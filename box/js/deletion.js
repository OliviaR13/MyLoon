const $ = (id) => document.getElementById(id);
const fmt = (ms) => new Date(ms).toLocaleString("zh-CN", { hour12: false });

let busy = false;
function setBusy(on) {
  busy = on;
  for (const id of ["continueBtn", "cancelBtn", "cancelYes", "cancelNo"]) {
    const el = $(id);
    if (el) el.disabled = on;
  }
}
function showActionError(text) {
  const el = $("actionError");
  if (!el) return;
  el.hidden = !text;
  el.textContent = text || "";
}

async function post(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || "操作失败，请重试");
    err.status = res.status;
    throw err;
  }
  return data;
}

async function load() {
  const res = await fetch("/api/account/deletion/status", {
    headers: { accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  $("loading").hidden = true;
  if (!res.ok) {
    $("error").hidden = false;
    $("error").textContent = res.status === 401
      ? "登录确认已失效，请重新登录。"
      : (data.error === "account_deleted" ? "这个账号已经永久删除。" : "暂时无法读取注销状态，请重试。");
    return;
  }
  $("panel").hidden = false;
  $("requested").textContent = fmt(data.requestedAt);
  $("scheduled").textContent = fmt(data.scheduledAt);
  $("days").textContent = String(data.remainingDays);
}

$("continueBtn")?.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  showActionError("");
  try {
    await post("/api/account/deletion/continue");
    location.assign("/");
  } catch (err) {
    showActionError(err.message);
    setBusy(false);
  }
});

$("cancelBtn")?.addEventListener("click", () => {
  if (busy) return;
  $("cancelBox").hidden = false;
});
$("cancelNo")?.addEventListener("click", () => {
  if (busy) return;
  $("cancelBox").hidden = true;
});
$("cancelYes")?.addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  showActionError("");
  try {
    await post("/api/account/deletion/cancel");
    location.assign("/?login=restored");
  } catch (err) {
    showActionError(err.message);
    setBusy(false);
  }
});

load();
