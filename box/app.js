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
  if (p._ts === undefined) { // 每个插件只解析一次，排序时不再重复跑正则
    const m = p.date.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    p._ts = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }
  return p._ts;
};
const SORTS = {
  date: { label: "时间", defaultDir: "desc", hint: { desc: "新到旧", asc: "旧到新" }, short: { desc: "最新", asc: "最早" }, compare: (a, b) => dateValue(a) - dateValue(b) },
  name: { label: "名称", defaultDir: "asc", hint: { asc: "A 到 Z", desc: "Z 到 A" }, short: { asc: "A-Z", desc: "Z-A" }, compare: (a, b) => collator.compare(a.name, b.name) },
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

// query：输入框里还没回车的那一段；keywords：已回车确认的关键词（显示成胶囊）
const state = { plugins: [], category: CONFIG.all, query: "", keywords: [], sort: readSort(), favorites: readFavs(), favMeta: readFavMeta() };

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
/* 收藏时的爆发动效，思路借自 Bencho 的 Like（Bloom）：
   星标先挤压、再弹过头、落回原位；同时一圈光盘镂空成圆环，七对彩点沿辐条飞出。
   粒子的角度和颜色都是固定值，不用随机数，每次收藏看到的是同一个效果。
   只在「收藏」时播放，取消收藏不庆祝。 */
const BURST_COLORS = ["#f48ea7", "#cc8ef5", "#8ce8c3", "#91d2fa", "#f5a524", "#e5484d", "#9fc7fa"];
// 「减少动画」的唯一判断：settings.js 把「手动开启 或 系统开启」合并后写在 <html data-reduce-motion> 上；
// 再看一眼系统媒体查询只是兜底（脚本还没跑完的极短时间里也不会误播动画）
const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
const motionOff = () => document.documentElement.hasAttribute("data-reduce-motion") || reduceMQ.matches;

function burstStar(btn) {
  if (motionOff()) return;
  btn.querySelector(".star-burst")?.remove(); // 连点时重新开始，而不是排队
  const svg = btn.querySelector("svg");
  svg.classList.remove("pop");
  void svg.getBoundingClientRect(); // 强制回流，让动画能重播
  svg.classList.add("pop");

  const wrap = el("span", "star-burst");
  wrap.setAttribute("aria-hidden", "true");
  wrap.append(el("span", "star-ring"));
  BURST_COLORS.forEach((c, k) => {
    const spoke = el("span", "star-spoke");
    spoke.style.setProperty("--a", `${(k * 360) / BURST_COLORS.length - 90}deg`);
    [c, BURST_COLORS[(k + 3) % BURST_COLORS.length]].forEach((color) => {
      const dot = el("i");
      dot.style.setProperty("--c", color);
      spoke.append(dot);
    });
    wrap.append(spoke);
  });
  btn.append(wrap);
  setTimeout(() => { wrap.remove(); svg.classList.remove("pop"); }, 900);
}

/* 液体开关（思路借自 Bencho 的 Liquid toggle）：
   滑块不是平移过去，而是沿行进方向被拉长、同时变薄（面积保持），到位时带一点回弹，
   像一滴液体穿过轨道。滑块是 ::after 伪元素，所以用 Web Animations API 直接给伪元素写关键帧；
   位移也写在关键帧里，避免单独的 scale 属性把位移一起缩放而偏离终点。
   host：.switch 或 .mini-switch；on：切换后的状态。行程直接按元素的宽高量（宽 - 高），和 CSS 里滑块的位移同一个来源。
   不要直接调用：改状态一律走 setSwitch，这样每个开关、每条改动路径（点击、云端同步、恢复默认）动效都一样。 */
function liquidThumb(host, on) {
  if (!host || !host.animate || motionOff()) return;
  const travel = host.offsetWidth - host.offsetHeight;
  if (travel <= 0) return; // 不在屏幕上（display:none / hidden）就没必要播
  const [a, b] = on ? [0, travel] : [travel, 0];
  const at = (x, sx, sy) => `translateX(${x}px) scale(${sx}, ${sy})`;
  try {
    host.animate(
      [
        { transform: at(a, 1, 1) },
        { transform: at((a + b) / 2, 1.34, 0.76), offset: 0.42 },
        { transform: at(b, 1, 1) },
      ],
      { duration: 460, easing: "cubic-bezier(.3,1.2,.5,1)", pseudoElement: "::after" }
    );
  } catch {}
}

/* 开关状态的唯一入口：写 aria-checked，状态真的变了、且不是第一次赋值时，才播液体动效。
   host：带 aria-checked 的元素；thumb：真正承载滑块的元素，默认就是 host
   （排序菜单里 aria-checked 在整行 .sort-pin 上，滑块在里面的 .mini-switch）。 */
function setSwitch(host, on, thumb = host) {
  if (!host) return;
  const prev = host.getAttribute("aria-checked");
  const next = String(!!on);
  if (prev === next) return;
  host.setAttribute("aria-checked", next);
  if (prev !== null) liquidThumb(thumb, !!on); // prev 为 null = 页面刚加载的初始化，不播
}

// 等开关的第一帧画出去再做重活：render() 会整表重建，同步执行会把动效最前面几帧吃掉，看起来像「这个开关没动画」
const afterPaint = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

function toggleFav(id, btn) {
  state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
  state.favMeta[id] = [Date.now(), state.favorites.has(id) ? 1 : 0]; // 取消收藏也要留一条记录
  saveFavMeta();
  saveFavs();
  btn.setAttribute("aria-pressed", String(state.favorites.has(id)));
  if (state.favorites.has(id)) burstStar(btn);
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

/* 提示条（灵动岛式，思路借自 Bencho 的 Dynamic Island）：
   同一时间只显示一条，可带一个操作按钮。
   - 形状用一组弹簧过渡：先是一颗小药丸，宽、高、圆角一起长到内容的大小，而不是一个圆角慢半拍的盒子；
   - 内容不跟着形变，而是带一点模糊和缩放淡入，药丸先动、字后到；
   - 已经显示时来了新提示，药丸直接变形成新的大小，不先消失再出现；
   - 用 popover 提升到顶层，设置面板（modal dialog）打开时提示也不会被遮罩盖住。 */
let toastTimer = 0, toastHideTimer = 0;
const TOAST_NUB = { w: 96, h: 32, r: 16 };
// 顶层（popover）只在有模态对话框（设置面板）打开时才用，因为只有它才能盖过对话框的遮罩。
// 平时药丸就是普通的 fixed 元素：iOS 26 的 Safari 会拿顶层 / 固定定位的元素给工具栏取色，
// 下拉时药丸一进顶层，底部 dock 里就会冒出一块灰色底座。
function toastPopover(open) {
  const box = els.toast;
  try {
    if (typeof box.showPopover !== "function") return;
    const isOpen = box.matches(":popover-open");
    if (open && !isOpen && document.querySelector("dialog[open]")) box.showPopover();
    if (!open && isOpen) box.hidePopover();
  } catch {}
}
function toastSize(w, h, r) {
  const s = els.toast.style;
  s.setProperty("--tw", w + "px"); s.setProperty("--th", h + "px"); s.setProperty("--tr", r + "px");
}
function toastHold() { // 下拉刷新接管药丸：取消待执行的收起
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
}
function toast(msg, action) {
  const box = els.toast;
  const inner = box.querySelector(".toast-in");
  const act = box.querySelector(".toast-act");
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  box.style.opacity = "";                                // 下拉刷新可能留下了行内透明度
  box.classList.remove("leaving", "pulling", "armed", "working"); // 取消退场（退场到一半来了新提示）；下拉刷新的内容淡出，消息淡入，药丸就地变形

  const msgEl = box.querySelector(".toast-msg");
  msgEl.style.width = "";                                // 上一条提示收紧过的宽度要先放开，再量这一条
  msgEl.textContent = msg;
  act.hidden = !action;
  act.onclick = action ? () => { hideToast(); action.run(); } : null;
  if (action) act.textContent = action.label;

  const wasShown = box.classList.contains("show");
  if (!wasShown) { // 从小药丸起步
    toastSize(TOAST_NUB.w, TOAST_NUB.h, TOAST_NUB.r);
    box.classList.remove("open");
  }
  toastPopover(true);
  box.classList.add("show");

  const grow = () => {
    // 文字换行并均衡后，最宽的一行往往比容器窄；把文字区收紧到最宽那行，药丸左右就不会留出多余空白
    msgEl.style.width = "";
    const range = document.createRange();
    range.selectNodeContents(msgEl);
    // 起步时内容带 scale(.92)，getBoundingClientRect 量到的是缩小后的宽度，要除回去，否则会把文字区收得过窄、多折出一行
    const scale = inner.offsetWidth ? inner.getBoundingClientRect().width / inner.offsetWidth : 1;
    const textW = Math.ceil(range.getBoundingClientRect().width / (scale || 1));
    if (textW > 0 && textW < msgEl.offsetWidth) msgEl.style.width = textW + 1 + "px";
    const w = inner.offsetWidth, h = inner.offsetHeight; // 内容的自然大小
    toastSize(w, h, Math.min(22, h / 2));
    box.classList.add("open");
  };
  if (wasShown) grow(); // 已经在显示：直接变形
  else { void box.offsetWidth; requestAnimationFrame(grow); } // 先让小药丸落地，下一帧再长大

  toastTimer = setTimeout(hideToast, action ? 5000 : 1800);
}
// 退场：不再复用进场那条带回弹的弹簧（缩回去会先抖一下，再被硬切掉），而是单独一条平滑的收尾——
// ① 内容先淡出（和 .open 脱开就开始，.16s）；② 药丸同时缩回小药丸并轻轻上收，曲线不回弹；
// ③ 药丸在缩到一半时开始淡出，等它几乎没了再摘掉 .show。时长见 style.css 里的 .toast.leaving。
const TOAST_LEAVE = 340;
function hideToast() {
  const box = els.toast;
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  if (!box.classList.contains("show")) return;
  box.classList.remove("open", "pulling", "armed", "working"); // 内容先淡出
  box.classList.add("leaving");
  toastSize(TOAST_NUB.w, TOAST_NUB.h, TOAST_NUB.r); // 缩回小药丸
  toastHideTimer = setTimeout(() => { box.classList.remove("show", "leaving"); toastPopover(false); }, TOAST_LEAVE + 20);
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

/* 排序优先级（从高到低）：
   1. 搜索时，名称命中的排在只有描述命中的前面
   2. 开启「收藏置顶」时，已收藏的排前面
   3. 所选的排序方式与方向（同值按名称，保证顺序稳定） */
function sortPlugins(list, terms = searchTerms()) {
  const { key, dir } = state.sort;
  const sign = dir === "asc" ? 1 : -1;
  const pin = !!(window.MLB_settings && window.MLB_settings.get().pinFavs);
  const nameHit = (p) => (terms.length && termsHit(terms, p.name.toLowerCase()) ? 0 : 1); // 名称里就命中的排前面
  const pinned = (p) => (pin && state.favorites.has(p.id) ? 0 : 1);
  return [...list].sort((a, b) => {
    const tier = nameHit(a) - nameHit(b) || pinned(a) - pinned(b);
    if (tier) return tier;
    if (key === "date") {
      const missA = Number.isNaN(dateValue(a)), missB = Number.isNaN(dateValue(b));
      if (missA !== missB) return missA ? 1 : -1;
    }
    const d = SORTS[key].compare(a, b);
    return (Number.isNaN(d) ? 0 : sign * d) || collator.compare(a.name, b.name); // 相同则按名称，顺序稳定
  });
}

// 当前生效的搜索词 = 已确认的关键词 + 还在输入的那一段（边输入边筛）。
// 多个词之间怎么算由设置里的「多个关键词」决定：交（默认）= 每个词都要命中；并 = 命中任意一个就行
const termsHit = (terms, text) => (window.MLB_settings?.get().searchMode === "or" ? terms.some((t) => text.includes(t)) : terms.every((t) => text.includes(t)));
const searchTerms = () => {
  const draft = state.query.trim().toLowerCase();
  return [...state.keywords.map((k) => k.toLowerCase()), ...(draft ? [draft] : [])];
};
function matches(p, terms = searchTerms()) {
  if (state.category === FAV) { if (!state.favorites.has(p.id)) return false; }
  else if (state.category !== CONFIG.all && p.category !== state.category) return false;
  if (!terms.length) return true;
  const hay = (p.name + " " + p.description).toLowerCase();
  return termsHit(terms, hay);
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
  const terms = searchTerms();
  const visible = sortPlugins(state.plugins.filter((p) => matches(p, terms)), terms);
  const total = state.plugins.length;
  const how = SORTS[state.sort.key];
  els.count.textContent = (visible.length === total ? `共 ${total} 个插件` : `${visible.length} / ${total} 个插件`) + ` · ${how.label} ${how.hint[state.sort.dir]}`;

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
  placeTabInd();
}

/* 页签指示器（思路借自 Bencho 的 Icon bar）：整个页面只有一条下划线，切换页签时分两段走——
   第一段：前进方向的那一端先冲到目标页签，线被拉长、横跨两个页签；
   第二段：后面那一端稍晚、带一点回弹地追上来，收缩到目标页签上。
   两端各自一条过渡（左 / 右），用 left、right 而不是 width，所以「谁先走」只是过渡参数不同。
   页签文字宽度变化（收藏数从 9 变成 10、字体加载完）时直接落到新位置，不做动画。 */
const tabInd = document.createElement("i");
tabInd.className = "tab-ind";
tabInd.setAttribute("aria-hidden", "true");
els.tabs.append(tabInd);
let tabPrev = -1;
function placeTabInd() {
  const tabs = [...els.tabs.querySelectorAll(".tab")];
  const idx = tabs.findIndex((b) => b.getAttribute("aria-pressed") === "true");
  const act = tabs[idx];
  if (!act || !els.tabs.clientWidth) return;
  els.tabs.classList.add("has-ind"); // 有指示器了，页签自带的下划线就让出来
  const move = tabPrev !== -1 && idx !== tabPrev && !motionOff();
  tabInd.dataset.dir = idx > tabPrev ? "fwd" : "back";
  tabInd.classList.toggle("no-anim", !move);
  tabInd.style.left = act.offsetLeft + "px";
  tabInd.style.right = els.tabs.clientWidth - act.offsetLeft - act.offsetWidth + "px";
  tabPrev = idx;
}
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => placeTabInd());
  ro.observe(els.tabs);
  els.tabs.querySelectorAll(".tab").forEach((t) => ro.observe(t));
}

/* ---------- 搜索框 ----------
   盒子里从左到右：放大镜 · 关键词胶囊 + 输入框 · 红叉（清除全部）· 搜索按钮。
   - 输入时边输边筛；回车把输入框里的字「确认」成一个关键词胶囊，可以连续加多个，之间是「并且」；
   - 胶囊上的红叉删除这一个，右边的红叉清除全部；输入框为空时按退格会删掉最后一个；
   - 搜索按钮：把没回车的字也收进来、收起键盘。输入框为空时回车也一样收起键盘。 */
const searchBox = $("#searchBox"), searchField = $("#searchField"), searchClear = $("#searchClear");
const crossIcon = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({ width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 3, "stroke-linecap": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 6l12 12M18 6L6 18");
  svg.append(path);
  return svg;
};
function renderKeywords() {
  searchField.querySelectorAll(".kw").forEach((n) => n.remove());
  state.keywords.forEach((k, i) => {
    const chip = el("span", "kw");
    const x = el("button", "kw-x");
    x.type = "button";
    x.dataset.i = i;
    x.setAttribute("aria-label", `删除关键词 ${k}`);
    x.append(crossIcon());
    chip.append(el("span", "kw-text", k), x);
    searchField.insertBefore(chip, els.search);
  });
}
// 把输入框里的字确认成关键词（重复的不加）。返回有没有确认成功
function commitDraft() {
  const v = els.search.value.trim();
  if (!v) return false;
  if (!state.keywords.some((k) => k.toLowerCase() === v.toLowerCase())) state.keywords.push(v);
  els.search.value = state.query = "";
  return true;
}
function applySearch({ animate = false } = {}) {
  clearTimeout(timer);
  renderKeywords();
  syncSearch();
  if (state.plugins.length) render({ animate });
}

/* 搜索框收起（思路借自 Bencho 的 Search）：一个盒子，宽度就是状态，而不是图标和输入框互相淡入淡出。
   展开宽度由 JS 量出来（工具栏宽度减去排序按钮），这样宽度才能走弹簧过渡。
   设置里的「收起搜索框」开着才生效；盒子里有焦点、或有关键词 / 输入内容时保持展开。 */
function syncSearch() {
  const has = state.keywords.length > 0 || els.search.value !== "";
  searchBox.dataset.has = String(has);
  searchClear.hidden = !has;
  els.search.placeholder = state.keywords.length ? "继续添加" : "搜索，回车添加多词";
  if (!document.documentElement.hasAttribute("data-search-collapse")) {
    searchBox.removeAttribute("data-open");
    searchBox.style.removeProperty("--sw");
    return;
  }
  const open = searchBox.contains(document.activeElement) || has;
  searchBox.toggleAttribute("data-open", open);
  if (open) {
    const room = searchBox.parentElement.clientWidth - (els.sort ? els.sort.offsetWidth : 0) - 8; // 8 是工具栏的 gap
    searchBox.style.setProperty("--sw", Math.max(120, room) + "px");
  } else searchBox.style.removeProperty("--sw");
}
els.search.addEventListener("focus", syncSearch);
els.search.addEventListener("blur", syncSearch);
els.search.addEventListener("input", (e) => { state.query = e.target.value; syncSearch(); });
els.search.addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return; // 拼音输入法选词时的回车不算
  if (e.key === "Enter") {
    e.preventDefault();
    if (commitDraft()) applySearch(); else els.search.blur(); // 空的时候回车 = 收起键盘
  } else if (e.key === "Backspace" && !els.search.value && state.keywords.length) {
    state.keywords.pop();
    applySearch();
  }
});
searchBox.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); }); // 点按钮时输入框别失焦，不然收起的搜索框会先缩回去、点击落空
searchBox.addEventListener("click", (e) => {
  const x = e.target.closest(".kw-x");
  if (x) { state.keywords.splice(Number(x.dataset.i), 1); applySearch(); return; }
  if (e.target.closest("#searchClear")) {
    state.keywords = [];
    els.search.value = state.query = "";
    applySearch({ animate: true });
    els.search.focus();
    return;
  }
  if (e.target.closest("#searchGo")) { commitDraft(); applySearch({ animate: true }); els.search.blur(); return; }
  if (!e.target.closest(".kw")) els.search.focus(); // 点盒子的空白处 / 放大镜 = 聚焦输入框（收起时也靠它展开）
});
if (window.ResizeObserver) { // 工具栏宽度、排序按钮宽度（「最新」→「名称 A–Z」）变了，展开的搜索框都要跟着重新量
  const ro = new ResizeObserver(syncSearch);
  ro.observe(searchBox.parentElement);
  ro.observe(els.sort);
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
  state.keywords = [];
  renderKeywords();
  syncSearch();
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
  timer = setTimeout(() => { if (state.plugins.length) render(); }, 120);
});
els.refresh.addEventListener("click", () => load(true));

/* ---------- 排序菜单 ----------
   工具栏里只放一个按钮（图标 + 当前排序的简称），点开是菜单：
   四种排序直接点选，不再有「再点一次反转」这种藏起来的操作；
   「收藏置顶」也放进菜单，排序相关的选项集中在一处。 */
const SORT_OPTIONS = Object.entries(SORTS).flatMap(([key, s]) =>
  ["desc", "asc"].sort((a) => (a === s.defaultDir ? -1 : 1)).map((dir) => ({ key, dir, label: `${s.label} · ${s.hint[dir]}` }))
);
const sortUI = {};

function sortIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M8 4v16M8 4L5 7M8 4l3 3M16 20V4M16 20l-3-3M16 20l3-3");
  svg.append(p);
  return svg;
}

function buildSort() {
  const btn = el("button", "sort-btn");
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", "sortMenu");
  sortUI.text = el("span", "sort-text");
  btn.append(sortIcon(), sortUI.text);

  const menu = el("div", "sort-menu");
  menu.id = "sortMenu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "排序方式");
  menu.append(el("div", "sort-title", "排序方式"));
  sortUI.items = SORT_OPTIONS.map((o) => {
    const b = el("button", "sort-item");
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.dataset.key = o.key;
    b.dataset.dir = o.dir;
    b.append(el("span", "", o.label), el("i", "sort-check"));
    menu.append(b);
    return b;
  });
  menu.append(el("div", "sort-sep"));
  const pin = el("button", "sort-item sort-pin");
  pin.type = "button";
  pin.setAttribute("role", "menuitemcheckbox");
  pin.append(el("span", "", "收藏置顶"), el("i", "mini-switch"));
  menu.append(pin);

  Object.assign(sortUI, { btn, menu, pin });
  els.sort.replaceChildren(btn, menu);
  syncSort();
}

// 更新按钮文字、选中项和「收藏置顶」状态（account.js 合并云端设置后也会调用）
function syncSort() {
  if (!sortUI.btn) return;
  const { key, dir } = state.sort;
  sortUI.text.textContent = SORTS[key].short[dir];
  sortUI.btn.setAttribute("aria-label", `排序：${SORTS[key].label} ${SORTS[key].hint[dir]}`);
  sortUI.items.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.key === key && b.dataset.dir === dir)));
  const pinned = !!(window.MLB_settings && window.MLB_settings.get().pinFavs);
  setSwitch(sortUI.pin, pinned, sortUI.pin.querySelector(".mini-switch"));
  sortUI.btn.dataset.pin = String(pinned); // 按钮角上的小圆点：提示收藏置顶已开启
}

const sortIsOpen = () => sortUI.menu.dataset.open === "true";
function setSortOpen(open, viaKeyboard = false) {
  sortUI.menu.dataset.open = String(open);
  sortUI.btn.setAttribute("aria-expanded", String(open));
  if (open) {
    syncSort();
    // 只有键盘打开时才移动焦点；触屏点开不移动，避免出现焦点框
    if (viaKeyboard) (sortUI.items.find((b) => b.getAttribute("aria-checked") === "true") || sortUI.items[0]).focus();
  }
}

buildSort();

sortUI.btn.addEventListener("click", (e) => setSortOpen(!sortIsOpen(), e.detail === 0));

sortUI.menu.addEventListener("click", (e) => {
  const item = e.target.closest(".sort-item");
  if (!item) return;
  if (item === sortUI.pin) { // 开关：菜单保持打开
    if (!window.MLB_settings) return;
    const nextPin = !window.MLB_settings.get().pinFavs;
    window.MLB_settings.set({ pinFavs: nextPin });
    document.dispatchEvent(new Event("settings:change")); // 通知 account.js 同步
    syncSort(); // 开关状态和动效都在 syncSort → setSwitch 里
  } else { // 单选：选完关闭菜单
    state.sort = { key: item.dataset.key, dir: item.dataset.dir };
    try { localStorage.setItem(SORT_KEY, state.sort.key + ":" + state.sort.dir); } catch {}
    document.dispatchEvent(new Event("settings:change"));
    syncSort();
    setSortOpen(false);
    if (e.detail === 0) sortUI.btn.focus();
  }
  if (state.plugins.length) render({ animate: true });
});

// 点菜单外面关闭；Esc 关闭；上下方向键在菜单项之间移动
document.addEventListener("click", (e) => { if (sortIsOpen() && !els.sort.contains(e.target)) setSortOpen(false); });
document.addEventListener("keydown", (e) => {
  if (!sortIsOpen()) return;
  if (e.key === "Escape") { setSortOpen(false); sortUI.btn.focus(); return; }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const list = [...sortUI.items, sortUI.pin];
    const i = list.indexOf(document.activeElement);
    list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length].focus();
  }
});

load();
