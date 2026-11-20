/* 注销状态页：读取一次性票据对应的注销申请，显示冷静期倒计时，可以取消注销，或保持注销并返回首页。
   接口：GET /api/account/deletion/status、POST /api/account/deletion/cancel、POST /api/account/deletion/continue */
const $ = (id) => document.getElementById(id);
const reduce = () =>
  document.documentElement.hasAttribute("data-reduce-motion") || matchMedia("(prefers-reduced-motion: reduce)").matches;

const dayFmt = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
const RING = 314; // 2π × 50

let busy = false;
function setBusy(on, activeId) {
  busy = on;
  for (const id of ["continueBtn", "cancelBtn", "cancelYes", "cancelNo"]) {
    const el = $(id);
    if (!el) continue;
    el.disabled = on;
    el.toggleAttribute("data-busy", on && id === activeId);
  }
}
function showActionError(text) {
  const el = $("actionError");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
}
function showFatal(text, sub, retry) {
  for (const id of ["loading", "panel", "doneBox"]) $(id).hidden = true;
  $("errorText").textContent = text;
  $("errorSub").textContent = sub || "";
  $("retryBtn").hidden = !retry;
  $("errorBox").hidden = false;
}

async function post(url) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw Object.assign(new Error("网络不太顺畅，请检查网络后重试。"), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      res.status === 401 ? "登录确认已过期（超过 10 分钟），请回到首页重新登录。"
      : res.status === 429 ? "操作太频繁了，请稍等一会儿再试。"
      : data.error === "deletion_in_progress" ? "账号正在删除中，已经无法取消。"
      : data.error === "not_pending" ? "这个账号已经不在注销状态，请回到首页重新登录。"
      : data.message || "操作失败，请重试。";
    throw Object.assign(new Error(message), { status: res.status });
  }
  return data;
}

function countTo(node, to) {
  if (reduce() || to <= 1) { node.textContent = String(to); return; }
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / 800);
    node.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function render(data) {
  $("loading").hidden = true;
  $("panel").hidden = false;
  const days = Math.max(0, Number(data.remainingDays) || 0);
  $("requested").textContent = timeFmt.format(data.requestedAt);
  $("scheduled").textContent = timeFmt.format(data.scheduledAt);
  $("headline").textContent = "账号将在 " + dayFmt.format(data.scheduledAt) + " 永久删除";
  $("daysUnit").textContent = days <= 1 ? "天内" : "天";
  const bar = $("ringBar");
  const total = Math.max(1, data.scheduledAt - data.requestedAt);
  const left = Math.min(1, Math.max(0, (data.scheduledAt - Date.now()) / total));
  const target = RING * (1 - left);
  if (reduce()) bar.style.strokeDashoffset = String(target);
  else requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.strokeDashoffset = String(target); }));
  countTo($("days"), days);
}

async function load() {
  $("errorBox").hidden = true;
  $("loading").hidden = false;
  let res;
  try {
    res = await fetch("/api/account/deletion/status", { headers: { accept: "application/json" }, credentials: "same-origin", cache: "no-store" });
  } catch {
    showFatal("暂时读不到注销状态", "请检查网络后重试。", true);
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) showFatal("登录确认已失效", "这个页面需要先登录。请回到首页，重新登录这个账号。", false);
    else if (data.error === "account_deleted" || res.status === 410) showFatal("这个账号已经永久删除", "冷静期已结束，数据无法恢复。你仍然可以无需登录使用 Loon Box。", false);
    else showFatal("暂时读不到注销状态", "服务有点忙，请稍后重试。", true);
    return;
  }
  render(data);
}

function toggleCancel(open) {
  const fold = $("cancelFold");
  fold.toggleAttribute("data-open", open);
  fold.firstElementChild.toggleAttribute("inert", !open);
  $("cancelBtn").setAttribute("aria-expanded", String(open));
  if (open) setTimeout(() => $("cancelYes")?.focus({ preventScroll: true }), 120);
}

$("retryBtn")?.addEventListener("click", load);

$("cancelBtn")?.addEventListener("click", () => {
  if (busy) return;
  showActionError("");
  toggleCancel(!$("cancelFold").hasAttribute("data-open"));
});
$("cancelNo")?.addEventListener("click", () => { if (!busy) { toggleCancel(false); $("cancelBtn").focus({ preventScroll: true }); } });

$("cancelYes")?.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true, "cancelYes");
  showActionError("");
  try {
    await post("/api/account/deletion/cancel");
    $("panel").hidden = true;
    $("doneBox").hidden = false;
    setTimeout(() => location.assign("/?login=restored"), reduce() ? 300 : 1500);
  } catch (err) {
    showActionError(err.message);
    setBusy(false);
  }
});

$("continueBtn")?.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true, "continueBtn");
  showActionError("");
  toggleCancel(false);
  try {
    await post("/api/account/deletion/continue");
    location.assign("/");
  } catch (err) {
    showActionError(err.message);
    setBusy(false);
  }
});

load();
