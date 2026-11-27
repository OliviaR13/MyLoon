/* 插件列表渲染、卡片构建、FLIP 平滑重排、顶栏页签与分类筛选渲染 */

import { CONFIG, FAV, FAV_KEY, rawUrl, installUrl } from "./config.js";
import { $id, el, els, svgIcon, starIcon, infoIcon, motionOff, burstStar, setRollText, confirmable, copyText, lsSet } from "./dom.js";
import { SORTS, state, statOf, isRecent, splitDescription, searchTerms, matches, sortPlugins, saveFavMeta, saveFavs } from "./state.js";
import { fmtCount, reportInstall } from "./stats.js";
import { toast } from "./toast.js";
import { openDetail, syncDetailFav, initDetail } from "./detail.js";
import { createVerifyCells } from "./verify-cells.js";
import { createWatcher } from "./watcher.js";

/* 列表过渡的缓动与时长，和 styles/base.css 的 --ease-ios 保持一致：淡入 / 淡出 180–240ms，位移 ≤ 6px */
const EASE = "cubic-bezier(.22,1,.36,1)";
const FADE_IN = 240, FADE_OUT = 200, MOVE = 320, RESIZE = 260;
let onResetFilters = () => {};
let listAnim = null; // 列表高度过渡（同一时间最多一个，下一次渲染开始前取消）

export function setResetFiltersHandler(fn) {
  onResetFilters = fn;
}

/* ---------- 收藏切换与跨视图星标同步 ---------- */

export function syncStars(id) {
  const on = String(state.favorites.has(id));
  els.list.querySelectorAll(".card").forEach((c) => {
    if (c.dataset.id === id) c.querySelector(".star:not(.detail-btn)")?.setAttribute("aria-pressed", on);
  });
  syncDetailFav();
}

export function toggleFav(id, btn) {
  state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
  state.favMeta[id] = [Date.now(), state.favorites.has(id) ? 1 : 0];
  saveFavMeta();
  saveFavs();
  btn.setAttribute("aria-pressed", String(state.favorites.has(id)));
  syncStars(id);
  if (state.favorites.has(id)) { burstStar(btn); flyToFavs(btn); }
  renderFilters();
  if (state.category === FAV) render({ flip: true });
}

/* 收藏去哪了：从星标飞出一颗小星，沿弧线落进「我的收藏」的计数上，落下时计数才滚动并轻轻弹一下。
   弧线 = 外层只管水平（先慢后快）、内层只管竖直（先快后慢），两条曲线合成一段抛物线，不用算路径。
   详情页（模态对话框）里收藏时页签在遮罩后面，看不到落点，就不飞；减少动画时也不飞，计数直接变。 */
let favFlights = 0;
const FLY_DELAY = 120, FLY_DUR = 560;

function flyToFavs(btn) {
  const fc = $id("favCount");
  if (!fc || motionOff() || !document.body.animate || btn.closest("dialog")) return;
  const a = btn.getBoundingClientRect(), b = fc.getBoundingClientRect();
  if (!b.width || b.bottom < 0 || b.top > innerHeight) return;
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);

  const fly = el("span", "fav-fly");
  fly.setAttribute("aria-hidden", "true");
  fly.style.left = a.left + a.width / 2 + "px";
  fly.style.top = a.top + a.height / 2 + "px";
  const dot = el("span", "fav-fly-dot");
  dot.append(starIcon());
  fly.append(dot);
  document.body.append(fly);
  favFlights++;

  const opt = { duration: FLY_DUR, delay: FLY_DELAY, fill: "both" };
  fly.animate([{ transform: "translateX(0)" }, { transform: `translateX(${dx}px)` }], { ...opt, easing: "cubic-bezier(.45,0,.75,.6)" });
  dot.animate(
    [
      { transform: "translateY(0) scale(.6)", opacity: 0 },
      { transform: `translateY(${dy * 0.55}px) scale(1)`, opacity: 1, offset: 0.25 },
      { transform: `translateY(${dy}px) scale(.45)`, opacity: 0.9 },
    ],
    { ...opt, easing: "cubic-bezier(.2,.75,.35,1)" }
  ).onfinish = () => {
    fly.remove();
    favFlights = Math.max(0, favFlights - 1);
    setRollText(fc, String(state.favorites.size));
    fc.animate({ scale: [1, 1.28, 1] }, { duration: 420, easing: "cubic-bezier(.34,1.4,.64,1)" });
  };
}

export function setFavorites(ids, meta) {
  state.favorites = new Set(ids);
  if (meta) { state.favMeta = meta; saveFavMeta(); }
  lsSet(FAV_KEY, JSON.stringify([...state.favorites]));
  if (state.plugins.length) { renderFilters(); render(); }
}

/* ---------- 关键词高亮、FLIP 平滑过渡与 Loon 唤起 ---------- */

export function highlight(text, terms) {
  if (!terms.length) return [text];
  const re = new RegExp(
    terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|"),
    "gi"
  );
  const out = [];
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(el("mark", "hit", m[0]));
    last = m.index + m[0].length;
  }
  if (!out.length) return [text];
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* 重渲染前的快照：每张卡的位置、旧节点（给淡出用）和列表高度。读的是屏幕上此刻的样子（含正在进行的位移），所以连续输入时过渡能接得上 */
function snapshot() {
  const box = els.list.getBoundingClientRect();
  const tops = new Map(), nodes = new Map();
  els.list.querySelectorAll(".card:not(.card-ghost)").forEach((c) => {
    tops.set(c.dataset.id, c.getBoundingClientRect().top - box.top);
    nodes.set(c.dataset.id, c);
  });
  return { tops, nodes, h: box.height };
}

/* 重渲染后的过渡（FLIP）：留下的卡片从旧位置滑到新位置，新出现的淡入并上移 6px，被拿掉的淡出，列表高度平滑过渡。
   只给视口附近的卡片做动画，长列表不会同时起几十个动画。所有动画都是 WAAPI 且没有 fill，结束后不遗留任何样式。 */
function glide(before) {
  const box = els.list.getBoundingClientRect();
  const near = (top) => { const y = box.top + top; return y < innerHeight && y > -600; };
  const kept = new Set();
  els.list.querySelectorAll(".card").forEach((c) => {
    const id = c.dataset.id;
    kept.add(id);
    const to = c.getBoundingClientRect().top - box.top;
    const from = before.tops.get(id);
    if (from === undefined) {
      if (near(to)) c.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: FADE_IN, easing: EASE });
      return;
    }
    if (Math.abs(from - to) < 2 || (!near(from) && !near(to))) return;
    c.animate([{ transform: `translateY(${from - to}px)` }, { transform: "none" }], { duration: MOVE, easing: EASE });
  });

  /* 被拿掉的卡片：旧节点放回列表末尾、定位到原来的位置，淡出后移除（样式见 .card-ghost） */
  before.nodes.forEach((node, id) => {
    const top = before.tops.get(id);
    if (kept.has(id) || !near(top)) return;
    node.classList.add("card-ghost");
    node.classList.remove("vt-src");
    node.removeAttribute("data-id");
    node.setAttribute("aria-hidden", "true");
    node.inert = true;
    node.style.top = top - els.list.clientTop + "px";
    els.list.append(node);
    node.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px)" }], { duration: FADE_OUT, easing: EASE })
      .onfinish = () => node.remove();
  });

  /* 列表高度：从屏幕上此刻的高度过渡到新高度，下面的内容不会突然跳 */
  const h = box.height;
  if (before.h > 0 && Math.abs(before.h - h) > 2) {
    listAnim = els.list.animate([{ height: before.h + "px" }, { height: h + "px" }], { duration: RESIZE, easing: EASE });
  }
}

export function openInLoon(p, ui) {
  reportInstall(p);
  window.location.href = installUrl(p);
  if (ui) ui.on(2000);
  setTimeout(() => {
    if (document.visibilityState === "visible" && document.hasFocus()) {
      toast("没有唤起 Loon，请确认已安装", {
        label: "复制链接",
        run: async () => toast((await copyText(rawUrl(p))) ? "已复制链接" : "复制失败，请手动复制"),
      });
    }
  }, 2000);
}

/* ---------- 热度：标题行右侧的火焰徽标（安装次数） ---------- */

const FLAME = "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z";

/* 按「本周热度」排序时徽标显示本周的次数，其余显示总次数；没有统计或次数为 0 时整个徽标隐藏 */
function paintHeat(root = els.list) {
  const weekly = state.sort.key === "week";
  const byId = new Map(state.plugins.map((p) => [p.id, p]));
  root.querySelectorAll(".heat").forEach((h) => {
    const p = byId.get(h.dataset.id);
    const n = state.stats.on && p ? statOf(p, weekly ? "week" : "total") : 0;
    h.hidden = !n;
    if (!n) return;
    h.querySelector(".heat-n").textContent = fmtCount(n);
    const label = (weekly ? "本周安装 " : "安装 ") + n + " 次";
    h.title = label;
    h.setAttribute("aria-label", label);
  });
}

/* ---------- 卡片展开/收起与构建 ---------- */

export function expand(desc) {
  desc.style.maxHeight = desc.scrollHeight + "px";
  desc.dataset.open = "true";
  const settle = () => { if (desc.dataset.open === "true") desc.style.maxHeight = ""; };
  desc.addEventListener("transitionend", settle, { once: true });
  setTimeout(settle, 450);
}

export function collapse(desc) {
  desc.style.maxHeight = desc.scrollHeight + "px";
  void desc.offsetHeight;
  desc.style.maxHeight = "";
  desc.dataset.open = "false";
}

export function buildCard(p, terms = []) {
  const card = els.tpl.content.firstElementChild.cloneNode(true);
  card.dataset.id = p.id;
  const icon = card.querySelector(".card-icon");
  if (p.icon) icon.src = p.icon; else icon.remove();

  card.querySelector("h2").replaceChildren(...highlight(p.name, terms));
  const star = el("button", "star");
  star.type = "button";
  star.append(starIcon());
  star.setAttribute("aria-label", "收藏 " + p.name);
  star.setAttribute("aria-pressed", String(state.favorites.has(p.id)));
  star.addEventListener("click", () => toggleFav(p.id, star));

  const info = el("button", "star detail-btn");
  info.type = "button";
  info.append(infoIcon());
  info.setAttribute("aria-label", "查看 " + p.name + " 的详情");
  info.setAttribute("aria-haspopup", "dialog");
  info.addEventListener("click", () => openDetail(p));
  const heat = el("span", "heat");
  heat.dataset.id = p.id;
  heat.append(svgIcon(FLAME), el("span", "heat-n"));
  card.querySelector(".card-title").append(heat, info, star);
  paintHeat(card);

  const ver = card.querySelector(".chip-ver");
  if (p.version) ver.textContent = p.version; else ver.remove();
  if (isRecent(p)) card.querySelector(".card-name").append(" ", el("span", "chip chip-new", "近期更新"));

  const desc = card.querySelector(".card-desc");
  desc.replaceChildren(
    ...splitDescription(p.description).map((s) => {
      const seg = el("span", "seg");
      seg.replaceChildren(...highlight(s, terms));
      return seg;
    })
  );

  const tags = card.querySelector(".tags");
  tags.append(el("span", "chip chip-cat", p.category));
  p.tags.forEach((t) => tags.append(el("span", "chip", t)));
  [[p.mitm, "需 MITM"], [p.script, "含脚本"], [p.args, "可配置"]].forEach(([on, label]) => {
    if (on) tags.append(el("span", "chip chip-cap", label));
  });
  const meta = [p.author, p.date && "更新于 " + p.date].filter(Boolean);
  if (meta.length) tags.after(el("p", "card-meta", meta.join(" · ")));

  const more = card.querySelector(".more");
  more.addEventListener("click", () => {
    const open = desc.dataset.open === "true";
    more.setAttribute("aria-expanded", String(!open));
    more.textContent = open ? "展开" : "收起";
    open ? collapse(desc) : expand(desc);
  });

  const installBtn = card.querySelector(".act-install");
  const installing = confirmable(installBtn, "唤起中…", false);
  installBtn.addEventListener("click", () => openInLoon(p, installing));

  const copyBtn = card.querySelector(".act-copy");
  const copied = confirmable(copyBtn, "已复制", true);
  copyBtn.addEventListener("click", async () => {
    if (await copyText(rawUrl(p))) copied.on(1800);
    else toast("复制失败，请手动复制");
  });
  return card;
}

/* ---------- 列表、分类筛选、顶栏页签与加载骨架屏 ---------- */

export function notice(title, body, label, onClick) {
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

export function render({ animate = false, flip = false } = {}) {
  if (verifying) return;
  syncDetailFav();
  const before = flip && !animate && !motionOff() && els.list.animate && els.list.querySelector(".card:not(.card-ghost)") ? snapshot() : null;
  listAnim?.cancel();
  const terms = searchTerms();
  const visible = sortPlugins(state.plugins.filter((p) => matches(p, terms)), terms);
  const total = state.plugins.length;
  const how = SORTS[state.sort.key];
  setRollText(
    els.count,
    (visible.length === total ? `共 ${total} 个插件` : `${visible.length} / ${total} 个插件`) + ` · ${how.label} ${how.hint[state.sort.dir]}`
  );

  if (!visible.length) {
    /* 空状态是固定文案，用强调字体（.accent）；notice() 本身还被加载失败等动态提示共用，所以不在 notice() 里加 */
    const empty = notice(
      total ? (state.category === FAV && !state.favorites.size ? "还没有收藏" : "没有匹配的插件") : "清单里还没有插件",
      total ? (state.category === FAV && !state.favorites.size ? "点击插件右上角的星标，就能把它加入收藏。" : "换个关键词，或把分类切回「全部」。") : "manifest.json 中没有插件条目。",
      total ? "清除筛选" : "",
      () => onResetFilters()
    );
    empty.classList.add("accent");
    /* 空状态里的小方块（js/watcher.js）：眼睛跟着指针 / 手指转，戳一下会说话 */
    const eyes = document.createElement("div");
    eyes.className = "notice-eyes";
    createWatcher(eyes, { size: 64, say: "right" });
    empty.prepend(eyes);
    els.list.replaceChildren(empty);
    if (before) {
      glide(before); // 原来的卡片淡出、高度过渡；空状态晚一点点淡入，避免和淡出中的卡片叠在一起
      if (empty.animate) empty.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: FADE_IN, delay: 80, easing: EASE, fill: "backwards" });
    }
    return;
  }
  els.list.classList.toggle("enter", animate);
  els.list.replaceChildren(
    ...visible.map((p, i) => {
      const card = buildCard(p, terms);
      card.style.setProperty("--i", Math.min(i, 8));
      return card;
    })
  );
  requestAnimationFrame(() =>
    els.list.querySelectorAll(".card").forEach((c) => {
      const d = c.querySelector(".card-desc");
      const overflow = d.scrollHeight > d.clientHeight + 2;
      d.dataset.overflow = String(overflow);
      c.querySelector(".more").hidden = !overflow;
    })
  );
  if (before) glide(before);
}

export function renderFilters() {
  const counts = new Map();
  state.plugins.forEach((p) => counts.set(p.category, (counts.get(p.category) || 0) + 1));
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
        els.filters.querySelectorAll(".chip-filter").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.name === name)));
        syncTabs();
        centerChip(b);
        render({ animate: true });
      });
      return b;
    })
  );
  syncTabs();
}

const tabInd = el("i", "tab-ind");
tabInd.setAttribute("aria-hidden", "true");
let tabPrev = -1;

export function placeTabInd() {
  const tabs = [...els.tabs.querySelectorAll(".tab")];
  const idx = tabs.findIndex((b) => b.getAttribute("aria-pressed") === "true");
  const act = tabs[idx];
  if (!act || !els.tabs.clientWidth) return;
  els.tabs.classList.add("has-ind");
  const move = tabPrev !== -1 && idx !== tabPrev && !motionOff();
  tabInd.dataset.dir = idx > tabPrev ? "fwd" : "back";
  tabInd.classList.toggle("no-anim", !move);
  tabInd.style.left = act.offsetLeft + "px";
  tabInd.style.right = els.tabs.clientWidth - act.offsetLeft - act.offsetWidth + "px";
  tabPrev = idx;
}

export function syncTabs() {
  const onFav = state.category === FAV;
  els.tabs.querySelectorAll(".tab").forEach((b) => {
    b.setAttribute("aria-pressed", String((b.dataset.view === "fav") === onFav));
  });
  const fc = $id("favCount");
  if (fc && !favFlights) setRollText(fc, String(state.favorites.size)); // 有星星在飞时，等它落下再变
  placeTabInd();
  placeFilterInd();
}

/* 分类筛选的选中底：一块浅色药丸，在分类之间滑过去（和页签下划线同一个手感：前进方向的边先到，后面的边带回弹追上）。
   用 left + width 而不是 left + right：.filters 会横向滚动，right 是相对可视宽度算的，滚动后会错位。
   分类按钮每次 renderFilters() 都会重建，所以按「选中的是哪个分类」判断要不要滑，不按按钮节点。 */
const filterInd = el("i", "filter-ind");
filterInd.setAttribute("aria-hidden", "true");
let filterPrev = null;   // 上次选中的分类名；null = 指示器当前没显示（比如在「我的收藏」页签）
let filterAnim = null;

export function placeFilterInd() {
  const box = els.filters;
  if (!box.clientWidth) return;
  if (filterInd.parentNode !== box) box.prepend(filterInd);
  box.classList.add("has-ind");
  const act = [...box.querySelectorAll(".chip-filter")].find((b) => b.dataset.name === state.category);
  if (!act) {
    filterInd.dataset.hidden = "";
    filterPrev = null;
    return;
  }
  const to = { l: act.offsetLeft, w: act.offsetWidth };
  if (filterAnim && filterPrev === state.category) return; // 正在滑向同一个分类（比如滑动途中按钮被重建），让它滑完
  const style = filterInd.style;
  const from = filterAnim && filterInd.isConnected
    ? { l: filterInd.offsetLeft, w: filterInd.offsetWidth } // 打断时从此刻屏幕上的位置接着走
    : { l: parseFloat(style.left) || 0, w: parseFloat(style.width) || 0 };
  const slide = filterPrev !== null && filterPrev !== state.category && from.w > 0 && !motionOff() && filterInd.animate;
  filterAnim?.cancel();
  filterAnim = null;
  style.top = act.offsetTop + "px";
  style.height = act.offsetHeight + "px";
  style.left = to.l + "px";
  style.width = to.w + "px";
  const appearing = filterInd.hasAttribute("data-hidden");
  filterInd.removeAttribute("data-hidden");
  if (slide) {
    /* 中间一帧：前进方向的边已经到位，后面的边才走了三成，药丸被拉长；之后后面的边回弹着追上 */
    const fwd = to.l > from.l;
    const lead = fwd ? to.l + to.w : to.l;
    const trail = fwd ? from.l + (to.l - from.l) * 0.3 : from.l + from.w + (to.l + to.w - from.l - from.w) * 0.3;
    const mid = fwd ? { l: trail, w: lead - trail } : { l: lead, w: trail - lead };
    filterAnim = filterInd.animate(
      [
        { left: from.l + "px", width: from.w + "px" },
        { left: mid.l + "px", width: mid.w + "px", offset: 0.4, easing: "cubic-bezier(.34,1.3,.64,1)" },
        { left: to.l + "px", width: to.w + "px" },
      ],
      { duration: 460, easing: "cubic-bezier(.3,.7,.3,1)" }
    );
    filterAnim.onfinish = () => { filterAnim = null; };
  } else if (appearing && !motionOff() && filterInd.animate) {
    filterInd.animate([{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(.22,1,.36,1)" });
  }
  filterPrev = state.category;
}

/* 点到半露在边上的分类时，把它滚到中间，顺手露出两边的邻居 */
function centerChip(chip) {
  const box = els.filters;
  if (box.scrollWidth <= box.clientWidth) return;
  box.scrollTo({ left: chip.offsetLeft - (box.clientWidth - chip.offsetWidth) / 2, behavior: motionOff() ? "auto" : "smooth" });
}

/* 加载 / 验证面板顶上的四个格子（js/verify-cells.js）：等待时轻轻呼吸，验证通过后融合成一颗「已通过」的胶囊 */
let verifyCells = null;

/* 人机验证 / 清单加载期间，列表里放的是验证面板（Turnstile 小组件挂在里面）；这时 render() 不动列表，加载结束时 manifest.js 先放开再画一次 */
let verifying = false;
export const setVerifying = (on) => { verifying = on; };

/* 骨架卡片：结构对着 buildCard 的真实卡片来（图标 / 名称 + 版本 / 三行描述 / 标签 / 作者行 / 安装 + 复制），样式见 styles/cards.css。
   装饰用，对读屏隐藏；「正在加载」的状态文字在上面的验证面板里（role=status） */
function skeletonCard(i) {
  const c = el("div", "sk-card");
  c.style.setProperty("--i", i);
  c.setAttribute("aria-hidden", "true");
  const name = el("div", "sk-name");
  name.append(el("span", "sk-line sk-title"), el("span", "sk-chip sk-ver"));
  const desc = el("div", "sk-desc");
  desc.append(el("div", "sk-line"), el("div", "sk-line"), el("div", "sk-line sk-w2"));
  const tags = el("div", "sk-tags");
  tags.append(el("span", "sk-chip"), el("span", "sk-chip"));
  const body = el("div", "sk-body");
  body.append(name, desc, tags, el("div", "sk-line sk-meta"));
  const actions = el("div", "sk-actions");
  actions.append(el("div", "sk-btn"), el("div", "sk-btn"));
  c.append(el("div", "sk-icon"), body, actions);
  return c;
}

export function renderLoading(text, count = 5) {
  verifying = true;
  verifyCells?.destroy();
  verifyCells = createVerifyCells();
  const status = el("div", "status");
  status.setAttribute("role", "status");
  status.append(verifyCells.el, el("span", "status-text", text));
  const slot = el("div", "verify-box");
  slot.id = "tsBox";
  const verify = el("div", "verify");
  verify.dataset.interactive = "false";
  verify.append(status, slot);
  els.list.classList.remove("enter");
  els.list.replaceChildren(verify, ...Array.from({ length: count }, (_, i) => skeletonCard(i)));
}

export function setPhase(text, done = false) {
  const status = els.list.querySelector(".status");
  if (!status) return;
  status.dataset.state = done ? "ok" : "wait";
  status.querySelector(".status-text").textContent = text;
  if (done) verifyCells?.pass();
}

/* 胶囊融合完成时 resolve；没有在验证时立刻 resolve。manifest.js 在渲染清单前等它，让「通过」这一下能被看到 */
export const passSettled = () => (verifyCells ? verifyCells.done : Promise.resolve());

export function initRender() {
  els.tabs.append(tabInd);

  /* 统计数据到了（或本机刚 +1）：按统计排序时重排，否则只改卡片上的数字 */
  document.addEventListener("stats:change", (e) => {
    if (!state.plugins.length || verifying) return;
    if (!e.detail?.optimistic && SORTS[state.sort.key]?.stat) render({ flip: true });
    else paintHeat();
  });
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => placeTabInd());
    ro.observe(els.tabs);
    els.tabs.querySelectorAll(".tab").forEach((t) => ro.observe(t));
    new ResizeObserver(() => placeFilterInd()).observe(els.filters);
  }
  document.fonts?.ready.then(() => { placeTabInd(); placeFilterInd(); }); // Geist 换上后分类按钮会变宽

  initDetail({ onToggleFav: toggleFav, onOpenInLoon: openInLoon });

  // 点卡片空白处（名称、描述、标签）打开插件详情；按钮、链接、正在选中文字时不触发
  els.list.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (!card || e.target.closest("button, a")) return;
    if (!getSelection().isCollapsed) return;
    const p = state.plugins.find((x) => x.id === card.dataset.id);
    if (p) openDetail(p);
  });
}
