/* MyLoon Box
   读取 GitHub Actions 生成的 manifest.json，渲染可安装的插件列表。
   所有插件字段都用 textContent 写入，不当作 HTML 解析。 */

const CONFIG = {
  manifest: "manifest.json",
  rawBase: "https://raw.githubusercontent.com/OliviaR13/MyLoon/main/",
  all: "全部",
  turnstile: {
    siteKey: "0x4AAAAAAFM6TQJfkewCeO_g", // 留空则不启用人机验证
    ttl: 30 * 60 * 1000,                  // 通过验证后，同一标签页内的免验证时长
    loadTimeout: 8000,                    // 验证组件加载超时
  },
};

const $ = (sel) => document.querySelector(sel);
const els = {
  list: $("#results"), count: $("#countText"), updated: $("#updatedText"), filters: $("#filters"),
  search: $("#searchInput"), refresh: $("#refreshBtn"), tpl: $("#rowTpl"), toast: $("#toast"),
  turnstile: $("#turnstile"),
};
// 页面里没有 Turnstile 容器时，不做人机验证
const state = { plugins: [], category: CONFIG.all, query: "", unlocked: !CONFIG.turnstile.siteKey || recentlyVerified() };

/* ---------- 工具 ---------- */

/* 提示条：同一时间只显示一条，新提示直接替换旧的；可带一个操作按钮 */
let toastTimer = 0;
function toast(msg, action) {
  const box = els.toast;
  const act = box.querySelector(".toast-act");
  box.querySelector(".toast-msg").textContent = msg;
  act.hidden = !action;
  act.onclick = action ? () => { hideToast(); action.run(); } : null;
  if (action) act.textContent = action.label;
  box.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 5000 : 1800);
}
function hideToast() {
  clearTimeout(toastTimer);
  els.toast.classList.remove("show");
}
// 离开页面（例如已跳转到 Loon）时收起提示，避免返回后还看到过期的提示
document.addEventListener("visibilitychange", () => { if (document.hidden) hideToast(); });

function safeIcon(value) {
  try {
    const u = new URL(value, document.baseURI);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch { return ""; }
}

const rawUrl = (p) => CONFIG.rawBase + p.file.replace(/^\/+/, "");
const installUrl = (p) => "loon://import?plugin=" + encodeURIComponent(rawUrl(p));

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = Object.assign(document.createElement("textarea"), { value: text });
  document.body.append(ta); ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/* ---------- 数据 ---------- */

function normalize(raw) {
  const category = String(raw.category || "其他");
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : [];
  return {
    id: String(raw.id || raw.file),
    name: String(raw.name || raw.file || "未命名插件"),
    file: String(raw.file || ""),
    version: raw.version ? String(raw.version) : "",
    author: String(raw.author || ""),
    category,
    // 分类之外的其余标签
    tags: tags.filter((t) => t && t !== category),
    icon: safeIcon(raw.icon || ""),
    description: String(raw.description || ""),
  };
}

function matches(p) {
  if (state.category !== CONFIG.all && p.category !== state.category) return false;
  const q = state.query.trim().toLowerCase();
  return !q || (p.name + " " + p.description).toLowerCase().includes(q);
}

/* ---------- 渲染 ---------- */

/* 唤起 Loon：成功时页面会被切走，不弹任何提示；
   2 秒后页面仍在前台并保持焦点，才认为没有唤起成功，给出备用方案。
   这是根据页面状态做的判断，可能受系统弹窗影响。 */
function openInLoon(p) {
  window.location.href = installUrl(p);
  setTimeout(() => {
    if (document.visibilityState === "visible" && document.hasFocus()) {
      toast("没有唤起 Loon，请确认已安装", {
        label: "复制链接",
        run: async () => toast((await copyText(rawUrl(p))) ? "已复制链接" : "复制失败，请手动复制"),
      });
    }
  }, 2000);
}

function buildCard(p) {
  const card = els.tpl.content.firstElementChild.cloneNode(true);
  const icon = card.querySelector(".card-icon");
  if (p.icon) icon.src = p.icon; else icon.remove();

  card.querySelector("h2").textContent = p.name;
  const ver = card.querySelector(".chip-ver");
  if (p.version) ver.textContent = p.version; else ver.remove();

  const desc = card.querySelector(".card-desc");
  desc.textContent = p.description;

  const tags = card.querySelector(".tags");
  tags.append(el("span", "chip chip-cat", p.category));
  p.tags.forEach((t) => tags.append(el("span", "chip", t)));
  if (p.author) tags.append(el("span", "chip", p.author));

  const more = card.querySelector(".more");
  more.addEventListener("click", () => {
    const open = more.getAttribute("aria-expanded") === "true";
    more.setAttribute("aria-expanded", String(!open));
    desc.dataset.clamp = String(open);
    more.textContent = open ? "展开" : "收起";
  });

  card.querySelector(".act-install").addEventListener("click", () => openInLoon(p));
  card.querySelector(".act-copy").addEventListener("click", async () => {
    toast((await copyText(rawUrl(p))) ? "已复制链接" : "复制失败，请手动复制");
  });
  return card;
}

function notice(title, body, label, onClick) {
  const box = el("div", "notice");
  box.append(el("h2", "", title), el("p", "", body));
  if (label) {
    const b = el("button", "btn", label);
    b.type = "button";
    b.addEventListener("click", onClick);
    box.append(b);
  }
  return box;
}

function render() {
  const visible = state.plugins.filter(matches);
  const total = state.plugins.length;
  els.count.textContent = visible.length === total ? `共 ${total} 个插件` : `${visible.length} / ${total} 个插件`;

  if (!visible.length) {
    els.list.replaceChildren(
      notice(
        total ? "没有匹配的插件" : "清单里还没有插件",
        total ? "换个关键词，或把分类切回「全部」。" : "manifest.json 中没有插件条目。",
        total ? "清除筛选" : "",
        resetFilters
      )
    );
    return;
  }
  els.list.replaceChildren(...visible.map(buildCard));
  // 描述没有被截断时，隐藏「展开」按钮
  requestAnimationFrame(() =>
    els.list.querySelectorAll(".card").forEach((c) => {
      const d = c.querySelector(".card-desc");
      c.querySelector(".more").hidden = d.scrollHeight <= d.clientHeight + 2;
    })
  );
}

function renderFilters() {
  const counts = new Map();
  state.plugins.forEach((p) => counts.set(p.category, (counts.get(p.category) || 0) + 1));
  const items = [[CONFIG.all, state.plugins.length], ...counts];
  els.filters.replaceChildren(
    ...items.map(([name, n]) => {
      const b = el("button", "chip-filter", name);
      b.type = "button";
      b.append(el("small", "", String(n)));
      b.setAttribute("aria-pressed", String(state.category === name));
      b.addEventListener("click", () => { state.category = name; renderFilters(); render(); });
      return b;
    })
  );
}

function resetFilters() {
  state.category = CONFIG.all;
  state.query = els.search.value = "";
  renderFilters();
  render();
}

function renderSkeleton() {
  els.list.replaceChildren(...[0, 1, 2].map(() => el("div", "sk")));
}

/* ---------- 加载 ---------- */

async function load(announce = false) {
  if (!state.unlocked) return toast("请先完成人机验证");
  els.list.setAttribute("aria-busy", "true");
  els.refresh.disabled = true;
  els.count.textContent = "正在加载清单";
  els.updated.textContent = "";
  renderSkeleton();

  try {
    const res = await fetch(`${CONFIG.manifest}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.plugins = (data.plugins || []).map(normalize);
    state.category = CONFIG.all;
    renderFilters();
    render();
    if (data.generatedAt) {
      els.updated.textContent = "清单更新于 " + new Date(data.generatedAt).toLocaleDateString("zh-CN");
    }
    if (announce) toast("清单已刷新");
  } catch (err) {
    console.error(err);
    els.count.textContent = "清单加载失败";
    els.list.replaceChildren(
      notice("暂时拿不到插件清单", "可能是网络问题，或 manifest.json 尚未生成。可以重试，也可以到 GitHub 的 plugin 目录手动获取。", "重试", () => load(true))
    );
  } finally {
    els.refresh.disabled = false;
    els.list.setAttribute("aria-busy", "false");
  }
}

/* ---------- Turnstile ----------
   显式渲染 + interaction-only：通常无感通过，需要交互时才显示组件。
   通过后在本标签页内 ttl 时间内免验证。注意：这是页面层面的验证，不会保护 manifest.json 本身。 */

const TS_KEY = "myloon_box_verified";
let tsWidget = null;
let tsLoadTimer = 0;

function recentlyVerified() {
  try { return Date.now() - Number(sessionStorage.getItem(TS_KEY)) < CONFIG.turnstile.ttl; } catch { return false; }
}
function markVerified() {
  try { sessionStorage.setItem(TS_KEY, String(Date.now())); } catch {}
}

function startTurnstile() {
  els.count.textContent = "正在进行人机验证…";
  clearTimeout(tsLoadTimer);
  tsLoadTimer = setTimeout(() => {
    if (!window.turnstile) tsFailed("无法加载验证组件，可能是当前网络访问不到 Cloudflare");
  }, CONFIG.turnstile.loadTimeout);
  if (window.turnstile) renderTurnstile(); // 组件先于 app.js 加载完成时直接渲染
}

window.onTurnstileLoad = () => { clearTimeout(tsLoadTimer); renderTurnstile(); };

function renderTurnstile() {
  if (tsWidget !== null) return;
  tsWidget = turnstile.render("#tsBox", {
    sitekey: CONFIG.turnstile.siteKey,
    theme: "auto",
    language: "zh-cn",
    appearance: "interaction-only",
    callback: unlock,
    "before-interactive-callback": () => els.turnstile.classList.add("show"),
    "after-interactive-callback": () => els.turnstile.classList.remove("show"),
    "expired-callback": () => turnstile.reset(tsWidget),
    "timeout-callback": () => turnstile.reset(tsWidget),
    "error-callback": (code) => { tsFailed("人机验证未完成（" + code + "）"); return true; },
  });
}

function removeTurnstile() {
  if (tsWidget !== null && window.turnstile) turnstile.remove(tsWidget);
  tsWidget = null;
  els.turnstile.classList.remove("show");
}

function unlock() {
  state.unlocked = true;
  markVerified();
  removeTurnstile();
  load();
}

function tsFailed(message) {
  state.unlocked = false;
  removeTurnstile();
  els.count.textContent = message;
  els.list.replaceChildren(
    notice("人机验证未完成", "请检查网络后重试，或直接到 GitHub 的 plugin 目录手动获取插件。", "重试", () => {
      if (window.turnstile) { startTurnstile(); renderTurnstile(); } else location.reload();
    })
  );
}

/* ---------- 事件 ---------- */

let timer = 0;
els.search.addEventListener("input", (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => { state.query = e.target.value; if (state.unlocked && state.plugins.length) render(); }, 120);
});
els.refresh.addEventListener("click", () => load(true));

if (state.unlocked) load(); else startTurnstile();
