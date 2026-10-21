/* 插件列表渲染、卡片构建、FLIP 平滑重排、顶栏页签与分类筛选渲染 */

import { CONFIG, FAV, FAV_KEY, rawUrl, installUrl } from "./config.js";
import { $id, el, els, starIcon, infoIcon, motionOff, burstStar, setRollText, confirmable, copyText, lsSet } from "./dom.js";
import { SORTS, state, isRecent, splitDescription, searchTerms, matches, sortPlugins, saveFavMeta, saveFavs } from "./state.js";
import { toast } from "./toast.js";
import { openDetail, syncDetailFav, initDetail } from "./detail.js";
import { createVerifyCells } from "./verify-cells.js";
import { createWatcher } from "./watcher.js";

const GLIDE_EASE = "cubic-bezier(.2,.8,.2,1)";
let onResetFilters = () => {};

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
  if (state.favorites.has(id)) burstStar(btn);
  renderFilters();
  if (state.category === FAV) render({ flip: true });
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

const cardTops = () => {
  const base = els.list.getBoundingClientRect().top;
  return new Map([...els.list.querySelectorAll(".card")].map((c) => [c.dataset.id, c.getBoundingClientRect().top - base]));
};

function glide(before) {
  const base = els.list.getBoundingClientRect().top;
  els.list.querySelectorAll(".card").forEach((c) => {
    const to = c.getBoundingClientRect().top - base;
    const from = before.get(c.dataset.id);
    if (from === undefined) {
      if (c.getBoundingClientRect().top < innerHeight) {
        c.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: GLIDE_EASE });
      }
      return;
    }
    if (Math.abs(from - to) < 2) return;
    c.animate([{ transform: `translateY(${from - to}px)` }, { transform: "none" }], { duration: 320, easing: GLIDE_EASE });
  });
}

export function openInLoon(p, ui) {
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
  card.querySelector(".card-title").append(info, star);

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
  const before = flip && !animate && !motionOff() && els.list.animate ? cardTops() : null;
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
  if (before && before.size) glide(before);
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
  if (fc) setRollText(fc, String(state.favorites.size));
  placeTabInd();
}

/* 加载 / 验证面板顶上的四个格子（js/verify-cells.js）：等待时轻轻呼吸，验证通过后融合成一颗「已通过」的胶囊 */
let verifyCells = null;

/* 人机验证 / 清单加载期间，列表里放的是验证面板（Turnstile 小组件挂在里面）；这时 render() 不动列表，加载结束时 manifest.js 先放开再画一次 */
let verifying = false;
export const setVerifying = (on) => { verifying = on; };

export function renderLoading(text) {
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
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => placeTabInd());
    ro.observe(els.tabs);
    els.tabs.querySelectorAll(".tab").forEach((t) => ro.observe(t));
  }

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
