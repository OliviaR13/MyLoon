/* MyLoon Box
   读取 GitHub Actions 生成的 manifest.json，渲染可安装的插件列表。
   所有插件字段都用 textContent 写入，不当作 HTML 解析。 */

const CONFIG = {
  manifest: "api/manifest",        // 服务端校验令牌后返回清单（Pages Function）
  staticManifest: "manifest.json", // 不启用人机验证时直接读取的静态清单
  rawBase: "https://raw.githubusercontent.com/OliviaR13/MyLoon/main/",
  all: "全部",
  turnstile: {
    siteKey: "0x4AAAAAAFM6TQJfkewCeO_g", // 留空则不启用人机验证
    action: "load_manifest",             // 需与 functions/api/manifest.js 中的 ACTION 一致
    loadTimeout: 8000,                   // 验证组件加载超时
    totalTimeout: 30000,                 // 无需交互时，整个验证的总时限
    interactiveTimeout: 90000,           // 需要用户点击时，给更长的时限
  },
};

const $ = (sel) => document.querySelector(sel);
const els = {
  list: $("#results"), count: $("#countText"), updated: $("#updatedText"), filters: $("#filters"),
  search: $("#searchInput"), refresh: $("#refreshBtn"), tpl: $("#rowTpl"), toast: $("#toast"),
  sort: $("#sortBox"), tabs: $("#tabs"),
};
/* ---------- 排序 ----------
   每种排序有默认方向：时间默认「新到旧」，名称默认「A 到 Z」。
   点击未选中的项：切换排序并使用它的默认方向；点击已选中的项：反转方向。
   没有日期的插件在「时间」排序里始终排最后，不随方向翻转。 */
const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
// 手动解析日期，不依赖 Date.parse（Safari 对 2026-9-5 这类非补零格式会返回无效）
const dateValue = (p) => {
  const m = p.date.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
};
const SORTS = {
  date: { label: "时间", defaultDir: "desc", hint: { desc: "新到旧", asc: "旧到新" }, compare: (a, b) => dateValue(a) - dateValue(b) },
  name: { label: "名称", defaultDir: "asc", hint: { asc: "A 到 Z", desc: "Z 到 A" }, compare: (a, b) => collator.compare(a.name, b.name) },
};
const SORT_KEY = "myloon_box_sort"; // 存储格式：date:desc

function readSort() {
  try {
    const [key, dir] = (localStorage.getItem(SORT_KEY) || "").split(":");
    if (SORTS[key] && (dir === "asc" || dir === "desc")) return { key, dir };
  } catch {}
  return { key: "date", dir: SORTS.date.defaultDir };
}

/* ---------- 收藏 ----------
   收藏的是插件 id，先存在本机；登录 GitHub 后由 account.js 同步到云端。 */
const FAV_KEY = "myloon_box_favs";
const FAV = "收藏"; // 筛选栏里的特殊分类
function readFavs() {
  try { const a = JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); return new Set(Array.isArray(a) ? a.filter((x) => typeof x === "string") : []); } catch { return new Set(); }
}
// 登录提示：account.js 在已登录时写入，用于让清单请求先走登录 Cookie，跳过人机验证
const loggedHint = () => { try { return localStorage.getItem("myloon_box_login") === "1"; } catch { return false; } };

// 每个插件的收藏记录：{ id: [最后一次操作的时间戳, 1 已收藏 / 0 已取消] }
// 云端同步靠它判断「谁后操作听谁的」，这样取消收藏也能传到其他设备
const FAV_META_KEY = "myloon_box_favs_meta";
function readFavMeta() {
  try {
    const o = JSON.parse(localStorage.getItem(FAV_META_KEY) || "{}");
    const out = {};
    for (const [id, v] of Object.entries(o || {})) if (Array.isArray(v) && Number.isFinite(v[0]) && (v[1] === 0 || v[1] === 1)) out[id] = [v[0], v[1]];
    return out;
  } catch { return {}; }
}
const saveFavMeta = () => { try { localStorage.setItem(FAV_META_KEY, JSON.stringify(state.favMeta)); } catch {} };

const state = { plugins: [], category: CONFIG.all, query: "", sort: readSort(), favorites: readFavs(), favMeta: readFavMeta() };

function saveFavs() {
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites])); } catch {}
  document.dispatchEvent(new Event("favs:change"));
}
function setFavorites(ids, meta) { // 供 account.js 合并云端数据时调用
  state.favorites = new Set(ids);
  if (meta) { state.favMeta = meta; saveFavMeta(); }
  try { localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites])); } catch {}
  if (state.plugins.length) { renderFilters(); render(); }
}
function toggleFav(id, btn) {
  state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
  state.favMeta[id] = [Date.now(), state.favorites.has(id) ? 1 : 0]; // 取消收藏也要留一条记录
  saveFavMeta();
  saveFavs();
  btn.setAttribute("aria-pressed", String(state.favorites.has(id)));
  renderFilters();
  if (state.category === FAV) render(); // 在「收藏」里取消收藏时，该行立即消失
}
function starIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9L3.5 9.7l5.9-.8z");
  svg.append(path);
  return svg;
}

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

/* 按语义拆分描述：在带圈序号（①②…）前、句末标点（。！？；）后断开，每段单独成行。
   只影响显示，不修改插件文件里的 #!desc，搜索仍使用原文。 */
function splitDescription(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/([。！？；])(?=[^\s」』）)”’])/g, "$1\n")
    .replace(/\s*([①-⑳])/g, "\n$1")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
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
    date: raw.date ? String(raw.date).trim() : "",
  };
}

function sortPlugins(list) {
  const { key, dir } = state.sort;
  const sign = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    if (key === "date") {
      const missA = Number.isNaN(dateValue(a)), missB = Number.isNaN(dateValue(b));
      if (missA !== missB) return missA ? 1 : -1;
    }
    const d = SORTS[key].compare(a, b);
    return (Number.isNaN(d) ? 0 : sign * d) || collator.compare(a.name, b.name); // 相同则按名称，顺序稳定
  });
}

function matches(p) {
  if (state.category === FAV) { if (!state.favorites.has(p.id)) return false; }
  else if (state.category !== CONFIG.all && p.category !== state.category) return false;
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

/* 展开 / 收起：用 max-height 过渡，高度从当前值平滑变化 */
function expand(desc) {
  desc.style.maxHeight = desc.scrollHeight + "px"; // 从折叠高度过渡到完整高度
  desc.dataset.open = "true";
  const settle = () => { if (desc.dataset.open === "true") desc.style.maxHeight = ""; }; // 结束后恢复自适应
  desc.addEventListener("transitionend", settle, { once: true });
  setTimeout(settle, 450); // 减少动态效果时没有 transitionend，兜底处理
}
function collapse(desc) {
  desc.style.maxHeight = desc.scrollHeight + "px"; // 先固定为当前高度
  void desc.offsetHeight;                          // 强制回流，让过渡生效
  desc.style.maxHeight = "";                       // 回到 CSS 中的折叠高度
  desc.dataset.open = "false";
}

function buildCard(p) {
  const card = els.tpl.content.firstElementChild.cloneNode(true);
  const icon = card.querySelector(".card-icon");
  if (p.icon) icon.src = p.icon; else icon.remove();

  card.querySelector("h2").textContent = p.name;
  const star = el("button", "star");
  star.type = "button";
  star.append(starIcon());
  star.setAttribute("aria-label", "收藏 " + p.name);
  star.setAttribute("aria-pressed", String(state.favorites.has(p.id)));
  star.addEventListener("click", () => toggleFav(p.id, star));
  card.querySelector(".card-title").append(star);
  const ver = card.querySelector(".chip-ver");
  if (p.version) ver.textContent = p.version; else ver.remove();

  const desc = card.querySelector(".card-desc");
  desc.replaceChildren(...splitDescription(p.description).map((s) => el("span", "seg", s)));

  const tags = card.querySelector(".tags");
  tags.append(el("span", "chip chip-cat", p.category));
  p.tags.forEach((t) => tags.append(el("span", "chip", t)));
  if (p.author) tags.append(el("span", "chip", p.author));
  if (p.date) tags.append(el("span", "chip", p.date));

  const more = card.querySelector(".more");
  more.addEventListener("click", () => {
    const open = desc.dataset.open === "true";
    more.setAttribute("aria-expanded", String(!open));
    more.textContent = open ? "展开" : "收起";
    open ? collapse(desc) : expand(desc);
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

function render({ animate = false } = {}) {
  const visible = sortPlugins(state.plugins.filter(matches));
  const total = state.plugins.length;
  els.count.textContent = visible.length === total ? `共 ${total} 个插件` : `${visible.length} / ${total} 个插件`;

  if (!visible.length) {
    els.list.replaceChildren(
      notice(
        total ? (state.category === FAV && !state.favorites.size ? "还没有收藏" : "没有匹配的插件") : "清单里还没有插件",
        total ? (state.category === FAV && !state.favorites.size ? "点击插件右上角的星标，就能把它加入收藏。" : "换个关键词，或把分类切回「全部」。") : "manifest.json 中没有插件条目。",
        total ? "清除筛选" : "",
        resetFilters
      )
    );
    return;
  }
  els.list.classList.toggle("enter", animate);
  els.list.replaceChildren(
    ...visible.map((p, i) => {
      const card = buildCard(p);
      card.style.setProperty("--i", Math.min(i, 8)); // 入场动画错开，最多延迟 8 档
      return card;
    })
  );
  // 描述没有被截断时，隐藏「展开」按钮，并去掉底部渐隐
  requestAnimationFrame(() =>
    els.list.querySelectorAll(".card").forEach((c) => {
      const d = c.querySelector(".card-desc");
      const overflow = d.scrollHeight > d.clientHeight + 2;
      d.dataset.overflow = String(overflow);
      c.querySelector(".more").hidden = !overflow;
    })
  );
}

function renderFilters() {
  const counts = new Map();
  state.plugins.forEach((p) => counts.set(p.category, (counts.get(p.category) || 0) + 1));
  // 「收藏」不再作为分类 chip，顶层已经有「我的收藏」页签，一个功能只留一个入口
  const items = [[CONFIG.all, state.plugins.length], ...counts];
  els.filters.replaceChildren(
    ...items.map(([name, n]) => {
      const b = el("button", "chip-filter", name);
      b.type = "button";
      b.append(el("small", "", String(n)));
      b.dataset.name = name;
      b.setAttribute("aria-pressed", String(state.category === name));
      b.addEventListener("click", () => {
        state.category = name;
        // 只更新选中状态，不重建按钮，颜色过渡才能播放
        els.filters.querySelectorAll(".chip-filter").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.name === name)));
        syncTabs(); // 点分类就等于离开收藏页签，页签要跟着回退到「全部插件」
        render({ animate: true });
      });
      return b;
    })
  );
  syncTabs();
}

/* ---------- 顶层页签：全部插件 / 我的收藏 ----------
   页签和分类 chip 是两套东西：页签管「看哪一批插件」，chip 管「哪个分类」。
   切到「我的收藏」时所有 chip 都不选中，因为此刻生效的是页签。 */
function syncTabs() {
  const onFav = state.category === FAV;
  els.tabs.querySelectorAll(".tab").forEach((b) => {
    b.setAttribute("aria-pressed", String((b.dataset.view === "fav") === onFav));
  });
  const fc = document.getElementById("favCount");
  if (fc) fc.textContent = String(state.favorites.size);
}
els.tabs.addEventListener("click", (e) => {
  const b = e.target.closest(".tab");
  if (!b) return;
  state.category = b.dataset.view === "fav" ? FAV : CONFIG.all;
  syncTabs();
  els.filters.querySelectorAll(".chip-filter").forEach((x) =>
    x.setAttribute("aria-pressed", String(x.dataset.name === state.category))
  );
  render({ animate: true });
});

function resetFilters() {
  state.category = CONFIG.all;
  state.query = els.search.value = "";
  renderFilters();
  render({ animate: true });
}

/* 加载占位：顶部状态行（转圈 / 对勾 + 当前阶段文字）+ 与真实卡片结构一致的骨架卡片 */
function renderLoading(text) {
  const status = el("div", "status");
  status.setAttribute("role", "status");
  status.append(el("span", "spinner"), el("span", "status-text", text));
  // 验证面板：状态行 + 验证组件的容器；需要用户交互时才展开组件
  const slot = el("div", "verify-box");
  slot.id = "tsBox";
  const verify = el("div", "verify");
  verify.dataset.interactive = "false";
  verify.append(status, slot);
  const cards = [0, 1, 2].map((i) => {
    const c = el("div", "sk-card");
    c.style.setProperty("--i", i);
    const lines = el("div", "sk-lines");
    lines.append(el("div", "sk-line"), el("div", "sk-line"), el("div", "sk-line"));
    const chips = el("div", "sk-chips");
    chips.append(el("span", "sk-chip"), el("span", "sk-chip"));
    lines.append(chips);
    c.append(el("div", "sk-icon"), lines, el("div", "sk-btn"));
    return c;
  });
  els.list.classList.remove("enter");
  els.list.replaceChildren(verify, ...cards);
}

// 更新状态行文字；done = true 时转圈变成对勾
function setPhase(text, done = false) {
  const status = els.list.querySelector(".status");
  if (!status) return;
  status.dataset.state = done ? "ok" : "wait";
  status.querySelector(".status-text").textContent = text;
}


/* ---------- Turnstile ----------
   每次加载清单都获取一个新令牌（令牌只能使用一次），交给 /api/manifest 在服务端校验。
   interaction-only：通常无感通过，需要交互时才显示组件。 */

let tsWidget = null;

function whenTurnstileReady() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      // 脚本刚加载时 window.turnstile 可能已存在但接口还没就绪，需要确认 render 可用
      if (window.turnstile && typeof window.turnstile.render === "function") return resolve();
      if (Date.now() - start > CONFIG.turnstile.loadTimeout) return reject(new Error("script"));
      setTimeout(check, 100);
    })();
  });
}

const verifyPanel = () => els.list.querySelector(".verify");
function setInteractive(on) {
  const p = verifyPanel();
  if (p) p.dataset.interactive = String(on);
}

function removeTurnstile() {
  if (tsWidget !== null && window.turnstile && typeof turnstile.remove === "function") turnstile.remove(tsWidget);
  tsWidget = null;
  setInteractive(false);
}

let tsTimer = 0;
function armTimer(ms, reject) {
  clearTimeout(tsTimer);
  tsTimer = setTimeout(() => { removeTurnstile(); reject(new Error("turnstile timeout")); }, ms);
}

async function getToken() {
  await whenTurnstileReady();
  removeTurnstile();
  return new Promise((resolve, reject) => {
    armTimer(CONFIG.turnstile.totalTimeout, reject); // 不会一直卡在「请稍候」
    tsWidget = turnstile.render("#tsBox", {
      sitekey: CONFIG.turnstile.siteKey,
      action: CONFIG.turnstile.action,
      theme: "auto",
      language: "zh-cn",
      appearance: "interaction-only",
      size: "flexible", // 组件宽度跟随容器，手机上不会溢出
      retry: "never",   // 出错时立即报告，不在后台反复静默重试
      callback: (token) => { clearTimeout(tsTimer); removeTurnstile(); resolve(token); },
      "before-interactive-callback": () => { armTimer(CONFIG.turnstile.interactiveTimeout, reject); setInteractive(true); setPhase("请点击下方的复选框完成验证"); },
      "after-interactive-callback": () => { armTimer(CONFIG.turnstile.totalTimeout, reject); setInteractive(false); setPhase("正在验证…"); },
      "expired-callback": () => turnstile.reset(tsWidget),
      "timeout-callback": () => turnstile.reset(tsWidget),
      "error-callback": (code) => { clearTimeout(tsTimer); removeTurnstile(); reject(new Error("turnstile " + code)); return true; },
    });
  });
}

/* ---------- 加载 ---------- */

/* 通过验证后，服务端会下发 30 分钟有效的签名 Cookie（HttpOnly，页面读不到）。
   这里只在 sessionStorage 里记一个时间，用来判断「可能还在免验证期」，真正的校验仍在服务端。 */
const VERIFIED_KEY = "myloon_box_verified_at";
const VERIFIED_TTL = 25 * 60 * 1000; // 比服务端的 30 分钟略短，避免临界时请求失败
function recentlyVerified() {
  try { return Date.now() - Number(sessionStorage.getItem(VERIFIED_KEY)) < VERIFIED_TTL; } catch { return false; }
}
function markVerified() {
  try { sessionStorage.setItem(VERIFIED_KEY, String(Date.now())); } catch {}
}
const postJson = (url, payload) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), cache: "no-store" });

async function load(announce = false) {
  els.list.setAttribute("aria-busy", "true");
  els.refresh.disabled = true;
  els.count.textContent = "加载中";
  els.updated.textContent = "";
  const needVerify = CONFIG.turnstile.siteKey && !recentlyVerified() && !loggedHint();
  renderLoading(needVerify ? "正在进行人机验证…" : "正在加载清单…");
  // 验证超过 4 秒还没完成时，提示一下
  let waitingToken = false;
  const slowTimer = setTimeout(() => { if (waitingToken) setPhase("验证时间较长，请稍候…"); }, 4000);

  try {
    let res;
    if (!CONFIG.turnstile.siteKey) {
      res = await fetch(CONFIG.staticManifest, { cache: "no-store" });
    } else {
      // 先尝试只带 Cookie（免验证期内直接成功）；失败再走 Turnstile
      if (recentlyVerified() || loggedHint()) {
        res = await postJson(CONFIG.manifest, {});
        if (!res.ok) res = null;
      }
      if (!res) {
        waitingToken = true;
        const token = await getToken();
        waitingToken = false;
        clearTimeout(slowTimer);
        setPhase("验证通过，正在加载清单…", true);
        res = await postJson(CONFIG.manifest, { token });
        if (res.ok) markVerified();
      }
    }
    if (!res.ok) {
      let reason = "";
      try { reason = (await res.json()).reason || ""; } catch {}
      throw new Error(res.status === 403 ? "verify:" + reason : "HTTP " + res.status);
    }
    const data = await res.json();
    state.plugins = (data.plugins || []).map(normalize);
    state.generatedAt = data.generatedAt || "";
    state.category = CONFIG.all;
    renderFilters();
    render({ animate: true });
    if (data.generatedAt) {
      els.updated.textContent = "清单更新于 " + new Date(data.generatedAt).toLocaleDateString("zh-CN");
    }
    if (announce) toast("清单已刷新");
  } catch (err) {
    console.error(err);
    const msg = String(err.message);
    const verify = msg.startsWith("verify") || msg === "script" || msg.startsWith("turnstile");
    els.count.textContent = verify ? "人机验证未通过" : "清单加载失败";
    els.list.replaceChildren(
      notice(
        verify ? "人机验证未通过" : "暂时拿不到插件清单",
        verify
          ? "请检查网络后重试。如果当前网络访问不到 Cloudflare，验证组件无法加载。错误信息：" + msg
          : "可能是网络问题，或清单尚未生成。可以重试，也可以到 GitHub 的 plugin 目录手动获取。",
        "重试",
        () => load(true)
      )
    );
  } finally {
    clearTimeout(slowTimer);
    removeTurnstile();
    els.refresh.disabled = false;
    els.list.setAttribute("aria-busy", "false");
  }
}

/* ---------- 事件 ---------- */

let timer = 0;
els.search.addEventListener("input", (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => { state.query = e.target.value; if (state.plugins.length) render(); }, 120);
});
els.refresh.addEventListener("click", () => load(true));

function buildSort() {
  els.sort.replaceChildren(
    ...Object.entries(SORTS).map(([key, s]) => {
      const b = el("button", "", s.label);
      b.type = "button";
      b.dataset.sort = key;
      b.append(el("i", "dir"));
      return b;
    })
  );
  syncSort();
}
// 只更新状态，不重建按钮，箭头旋转和颜色过渡才能播放
function syncSort() {
  const { key, dir } = state.sort;
  els.sort.querySelectorAll("button").forEach((b) => {
    const s = SORTS[b.dataset.sort];
    const active = b.dataset.sort === key;
    b.setAttribute("aria-pressed", String(active));
    b.dataset.dir = active ? dir : "";
    b.setAttribute("aria-label", active ? `${s.label}，${s.hint[dir]}，点击反转` : `按${s.label}排序`);
    b.title = active ? s.hint[dir] : "";
  });
}
els.sort.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sort]");
  if (!b) return;
  const key = b.dataset.sort;
  state.sort = key === state.sort.key
    ? { key, dir: state.sort.dir === "asc" ? "desc" : "asc" }
    : { key, dir: SORTS[key].defaultDir };
  try { localStorage.setItem(SORT_KEY, key + ":" + state.sort.dir); } catch {}
  document.dispatchEvent(new Event("settings:change"));
  syncSort();
  if (state.plugins.length) render({ animate: true });
});
buildSort();

load();
