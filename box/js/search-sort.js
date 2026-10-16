/* 搜索框、变形排序菜单与吸顶栏（#dock）控制 */

import { CONFIG, FAV, SORT_KEY } from "./config.js";
import { el, els, sortIcon, chevronIcon, setSwitch, lsSet } from "./dom.js";
import { SORTS, SORT_OPTIONS, state, getSettings, setSettings } from "./state.js";
import { render, renderFilters, syncTabs, setResetFiltersHandler } from "./render.js";

/* ---------- 搜索框（单关键词） ---------- */

let filterTimer = 0;

/* 有内容时：放大镜加粗、出现清除按钮 */
export function syncSearch() {
  const has = els.search.value !== "";
  els.searchBox.dataset.has = String(has);
  els.searchClear.hidden = !has;
}

export function applySearch({ animate = false } = {}) {
  clearTimeout(filterTimer);
  state.query = els.search.value;
  syncSearch();
  if (state.plugins.length) render({ animate, flip: !animate });
}

export function resetFilters() {
  state.category = CONFIG.all;
  state.query = els.search.value = "";
  syncSearch();
  renderFilters();
  render({ animate: true });
}

const filterSoon = () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { if (state.plugins.length) render({ flip: true }); }, 120);
};

/* ---------- 排序菜单 ---------- */

const sortUI = {};

export function sizeSortMenu() {
  if (!sortUI.menu) return;
  const s = sortUI.menu.style;
  s.setProperty("--bw", sortUI.btn.offsetWidth + "px");
  s.setProperty("--bh", sortUI.btn.offsetHeight + "px");
  s.setProperty("--mw", sortUI.inner.offsetWidth + 2 + "px");
  s.setProperty("--mh", sortUI.inner.offsetHeight + 2 + "px");
}

export function syncSort() {
  if (!sortUI.btn) return;
  const { key, dir } = state.sort;
  sortUI.text.textContent = SORTS[key].short[dir];
  sortUI.btn.setAttribute("aria-label", `排序：${SORTS[key].label} ${SORTS[key].hint[dir]}`);
  sortUI.items.forEach((b) => b.setAttribute("aria-checked", String(b.dataset.key === key && b.dataset.dir === dir)));
  const pinned = !!getSettings().pinFavs;
  setSwitch(sortUI.pin, pinned, sortUI.pin.querySelector(".mini-switch"));
  sortUI.btn.dataset.pin = String(pinned);
}

const sortIsOpen = () => sortUI.menu?.dataset.open === "true";

export function setSortOpen(open, viaKeyboard = false) {
  if (open) syncSort();
  if (open) sortUI.menu.style.transition = "none";
  sizeSortMenu();
  if (open) { void sortUI.menu.offsetWidth; sortUI.menu.style.transition = ""; }
  sortUI.menu.dataset.open = String(open);
  els.sort.dataset.open = String(open);
  sortUI.btn.setAttribute("aria-expanded", String(open));
  if (open && viaKeyboard) {
    (sortUI.items.find((b) => b.getAttribute("aria-checked") === "true") || sortUI.items[0]).focus();
  }
}

export function buildSort() {
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
  const inner = el("div", "sort-inner");
  menu.append(inner);
  const title = el("div", "sort-title");
  title.append(el("span", "", "排序方式"), chevronIcon());
  inner.append(title);

  sortUI.items = SORT_OPTIONS.map((o) => {
    const b = el("button", "sort-item");
    b.type = "button";
    b.setAttribute("role", "menuitemradio");
    b.dataset.key = o.key;
    b.dataset.dir = o.dir;
    b.append(el("span", "", o.label), el("i", "sort-check"));
    inner.append(b);
    return b;
  });
  inner.append(el("div", "sort-sep"));
  const pin = el("button", "sort-item sort-pin");
  pin.type = "button";
  pin.setAttribute("role", "menuitemcheckbox");
  pin.append(el("span", "", "收藏置顶"), el("i", "mini-switch"));
  inner.append(pin);

  [...inner.children].forEach((c, i) => c.style.setProperty("--i", i));
  inner.style.setProperty("--n", inner.children.length);

  Object.assign(sortUI, { btn, menu, inner, pin });
  els.sort.replaceChildren(btn, menu);
  sizeSortMenu();
  syncSort();
}

/* ---------- 事件绑定与吸顶栏监听 ---------- */

export function initSearchAndSort() {
  setResetFiltersHandler(resetFilters);
  buildSort();

  els.search.addEventListener("focus", syncSearch);
  els.search.addEventListener("blur", syncSearch);
  els.search.addEventListener("input", (e) => {
    if (!e.isComposing) {
      state.query = e.target.value;
      filterSoon();
    }
    syncSearch();
  });
  els.search.addEventListener("compositionend", () => {
    state.query = els.search.value;
    syncSearch();
    filterSoon();
  });
  els.search.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      applySearch();
      els.search.blur();
    } else if (e.key === "Escape" && els.search.value) {
      e.preventDefault();
      els.search.value = "";
      applySearch({ animate: true });
    }
  });

  els.searchBox.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  els.searchBox.addEventListener("click", (e) => {
    if (e.target.closest("#searchClear")) {
      els.search.value = "";
      applySearch({ animate: true });
      els.search.focus();
      return;
    }
    if (e.target.closest("#searchGo")) { applySearch({ animate: true }); els.search.blur(); return; }
    els.search.focus();
  });

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

  sortUI.btn.addEventListener("click", (e) => setSortOpen(!sortIsOpen(), e.detail === 0));
  sortUI.menu.addEventListener("click", (e) => {
    if (e.target.closest(".sort-title")) {
      setSortOpen(false);
      if (e.detail === 0) sortUI.btn.focus();
      return;
    }
    const item = e.target.closest(".sort-item");
    if (!item) return;
    if (item === sortUI.pin) {
      const nextPin = !getSettings().pinFavs;
      setSettings({ pinFavs: nextPin });
      document.dispatchEvent(new Event("settings:change"));
      syncSort();
    } else {
      state.sort = { key: item.dataset.key, dir: item.dataset.dir };
      lsSet(SORT_KEY, state.sort.key + ":" + state.sort.dir);
      document.dispatchEvent(new Event("settings:change"));
      syncSort();
      setSortOpen(false);
      if (e.detail === 0) sortUI.btn.focus();
    }
    if (state.plugins.length) render({ animate: true });
  });

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

  // 吸顶栏（#dock）：吸住时加 data-stuck，触发毛玻璃渐隐背景
  if (els.dock) {
    let stickTop = 0;
    const LEAD = 36; // 提前这么多像素开始显示毛玻璃：等真正吸住再出现，会比手感慢半拍
    // top 只在尺寸变化时才可能变，缓存起来，滚动时不再每帧读 getComputedStyle
    const readStickTop = () => { stickTop = parseFloat(getComputedStyle(els.dock).top) || 0; };
    // 下拉刷新时 .shell 会被 translateY 整体下移（pull.js）；吸顶栏的位置跟着下移，
    // 不扣掉这段位移的话，要等灵动岛退出、位移归零后才会判定为「已吸顶」，毛玻璃就晚出现
    const shell = document.querySelector(".shell");
    const shellShift = () => {
      if (!shell || !shell.style.transform) return 0;
      const t = getComputedStyle(shell).transform;
      return t && t !== "none" ? new DOMMatrixReadOnly(t).m42 : 0;
    };
    const updateDock = () => {
      els.dock.toggleAttribute("data-stuck", scrollY > 0 && els.dock.getBoundingClientRect().top - shellShift() <= stickTop + LEAD);
    };
    readStickTop();
    updateDock();
    shell?.addEventListener("transitionend", (e) => { if (e.target === shell) updateDock(); });
    // 滚动事件本身就在帧前触发，直接更新，不再多等一个 rAF
    window.addEventListener("scroll", updateDock, { passive: true });
    window.addEventListener("resize", () => { readStickTop(); updateDock(); });
  }
}
