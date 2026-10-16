/* 设置面板（<dialog id="settings">）：
   主题切换、单/双列全屏布局、插件卡片显示项、减少动画、行内撤销恢复默认与复制收藏链接。 */

import { SETTINGS_KEY, DEFAULTS, BOOL_KEYS, COLS_KEY, SPLASH_KEY, SORT_KEY, rawUrl } from "./config.js";
import { $id, sysReduce, motionOff, setSwitch, afterPaint, copyText, lsGet, lsSet, lsRemove } from "./dom.js";
import { state, readSort, registerSettingsAPI } from "./state.js";
import { toast } from "./toast.js";
import { render } from "./render.js";
import { syncSort, syncSearch } from "./search-sort.js";

const REDUCE_HINT = "关闭过渡和入场动画。系统已开启「减少动态效果」时自动生效";
const GRACE = 5000;

export function initSettings() {
  const root = document.documentElement;
  const sheet = $id("settings");
  if (!sheet) return;

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(lsGet(SETTINGS_KEY) || "{}"); } catch {}
    const out = { ...DEFAULTS };
    if (["system", "light", "dark"].includes(s.theme)) out.theme = s.theme;
    for (const k of BOOL_KEYS) if (typeof s[k] === "boolean") out[k] = s[k];
    return out;
  }

  let settings = loadSettings();

  // 全屏布局（单列 / 双列）与启动页开关：仅保存在本设备 localStorage，不同步到云端
  const UA = navigator.userAgent;
  const IS_PC =
    !/Android|iPhone|iPad|iPod|Mobile|Windows Phone|HarmonyOS|OpenHarmony/i.test(UA) &&
    !(/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  let fullCols = lsGet(COLS_KEY) === "2" ? "2" : "1";
  let splashOn = lsGet(SPLASH_KEY) !== "off";

  const save = () => {
    lsSet(SETTINGS_KEY, JSON.stringify(settings));
    document.dispatchEvent(new Event("settings:change"));
  };

  function apply() {
    const forced = sysReduce.matches;
    if (settings.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = settings.theme;
    root.toggleAttribute("data-hide-desc", !settings.showDesc);
    root.toggleAttribute("data-hide-ver", !settings.showVer);
    root.toggleAttribute("data-hide-cat", !settings.showCat);
    root.toggleAttribute("data-compact", settings.compact);
    root.toggleAttribute("data-reduce-motion", settings.reduceMotion || forced);


    $id("fullColsRow").hidden = !IS_PC;
    if (IS_PC) {
      root.dataset.fullCols = fullCols;
      $id("fullColsOpt").dataset.mode = fullCols;
      sheet.querySelectorAll("[data-cols-opt]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.colsOpt === fullCols)));
    } else {
      delete root.dataset.fullCols;
    }

    sheet.querySelectorAll("[data-theme-opt]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeOpt === settings.theme)));

    setSwitch($id("splashSwitch"), splashOn);
    sheet.querySelectorAll("[data-switch]").forEach((b) => {
      const lock = forced && b.dataset.switch === "reduceMotion";
      setSwitch(b, settings[b.dataset.switch] || lock);
      b.disabled = lock;
    });
    $id("reduceMotionSub").textContent = forced ? "系统已开启「减少动态效果」，已自动生效" : REDUCE_HINT;
    syncSort();
    syncSearch();
  }

  /* ---------- 面板开关与全屏切换 ---------- */

  function ago(t) {
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86400000);
    return days <= 0 ? "今天更新" : days === 1 ? "昨天更新" : days < 30 ? days + " 天前更新" : "";
  }

  function renderAbout() {
    const n = state.plugins.length;
    $id("aboutCount").textContent = n ? n + " 个" : "-";
    const t = state.generatedAt ? new Date(state.generatedAt) : null;
    const ok = t && !isNaN(t);
    $id("aboutDate").textContent = ok ? t.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }) : "-";
    const sub = ok ? ago(t) : "";
    $id("aboutAgo").textContent = sub;
    $id("aboutAgo").hidden = !sub;
  }

  let endClose = null;
  let clearTimer = 0;
  const showClearRow = (done) => {
    $id("clearConfirm").hidden = !done;
    $id("clearBtn").hidden = done;
  };
  const endClear = () => {
    clearTimeout(clearTimer);
    showClearRow(false);
  };

  function cancelClose() {
    if (endClose) {
      sheet.removeEventListener("transitionend", endClose.fn);
      clearTimeout(endClose.timer);
      endClose = null;
    }
    sheet.classList.remove("closing");
  }

  function open() {
    cancelClose();
    if (!sheet.open) document.documentElement.style.setProperty("--page-sbw", window.innerWidth - document.documentElement.clientWidth + "px");
    renderAbout();
    endClear();
    if (!sheet.open) sheet.showModal();
    sheet.classList.remove("enter");
    void sheet.offsetWidth;
    sheet.classList.add("enter");
    requestAnimationFrame(() => sheet.classList.add("open"));
  }

  function close() {
    if (!sheet.open || endClose) return;
    sheet.classList.add("closing");
    sheet.classList.remove("open");
    const finish = () => { cancelClose(); if (sheet.open) sheet.close(); };
    const fn = (e) => { if (e.target === sheet && e.propertyName === "transform") finish(); };
    endClose = { fn, timer: setTimeout(finish, 600) };
    sheet.addEventListener("transitionend", fn);
  }

  let resizeTimer = 0;
  function beginResize() {
    if (!sheet.open || motionOff()) return;
    sheet.classList.add("resizing");
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => sheet.classList.remove("resizing"), 320);
  }

  function setFull(on) {
    if (sheet.classList.contains("full") !== on) beginResize();
    sheet.classList.toggle("full", on);
    const b = $id("settingsFull");
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", on ? "退出全屏" : "全屏显示");
  }

  let fullTouched = false;
  $id("settingsFull").addEventListener("click", () => {
    fullTouched = true;
    setFull(!sheet.classList.contains("full"));
  });
  setFull(settings.fullDefault);

  const sheetBody = sheet.querySelector(".sheet-body");
  const syncScrollbar = () => sheet.style.setProperty("--sbw", sheetBody.offsetWidth - sheetBody.clientWidth + "px");
  if (window.ResizeObserver) new ResizeObserver(syncScrollbar).observe(sheetBody);
  sheet.querySelectorAll(".group").forEach((g) => [...g.children].forEach((c, r) => c.style.setProperty("--r", r)));

  $id("tourBtn")?.addEventListener("click", () => {
    sheet.addEventListener("close", () => document.dispatchEvent(new Event("mlb:tour")), { once: true });
    close();
  });
  $id("settingsBtn").addEventListener("click", open);
  $id("settingsClose").addEventListener("click", close);
  sheet.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });

  /* ---------- 设置项点击委托 ---------- */

  sheet.addEventListener("click", (e) => {
    const t = e.target.closest("[data-theme-opt]");
    if (t) { settings.theme = t.dataset.themeOpt; save(); apply(); return; }

    const c = e.target.closest("[data-cols-opt]");
    if (c) {
      if (fullCols === c.dataset.colsOpt) return;
      fullCols = c.dataset.colsOpt === "2" ? "2" : "1";
      lsSet(COLS_KEY, fullCols);
      if (sheet.classList.contains("full")) beginResize();
      apply();
      sheetBody.scrollTop = 0;
      return;
    }

    if (e.target.closest("[data-local-switch]")) {
      splashOn = !splashOn;
      if (splashOn) lsRemove(SPLASH_KEY);
      else lsSet(SPLASH_KEY, "off");
      apply();
      return;
    }

    const sw = e.target.closest("[data-switch]");
    if (sw) {
      const k = sw.dataset.switch;
      settings[k] = !settings[k];
      save();
      apply();
      if ((k === "showDesc" || k === "compact") && state.plugins.length) afterPaint(() => render());
      if (k === "pinFavs" && state.plugins.length) afterPaint(() => render({ animate: true }));
      if (k === "fullDefault" && settings.fullDefault) { fullTouched = true; setFull(true); }
    }
  });

  /* ---------- 恢复默认设置（行内立即执行 + 撤销引信） ---------- */

  $id("clearBtn").addEventListener("click", () => {
    const prevSettings = { ...settings };
    const prevSort = { ...state.sort };
    const prevSortRaw = lsGet(SORT_KEY);

    lsRemove(SORT_KEY);
    settings = { ...DEFAULTS };
    save();
    apply();
    state.sort = readSort();
    syncSort();
    if (state.plugins.length) render({ animate: true });

    const fuse = $id("clearFuse");
    fuse.style.animation = "none";
    void fuse.offsetWidth;
    fuse.style.animation = "";
    fuse.style.animationDuration = GRACE + "ms";
    showClearRow(true);
    clearTimeout(clearTimer);
    clearTimer = setTimeout(endClear, GRACE);

    $id("clearUndo").onclick = () => {
      settings = prevSettings;
      if (prevSortRaw !== null) lsSet(SORT_KEY, prevSortRaw);
      state.sort = prevSort;
      save();
      apply();
      syncSort();
      if (state.plugins.length) render({ animate: true });
      endClear();
      toast("已撤销");
    };
  });

  /* ---------- 复制收藏的插件链接 ---------- */

  $id("copyFavsBtn").addEventListener("click", async () => {
    const list = state.plugins.filter((p) => state.favorites.has(p.id));
    if (!list.length) return toast("还没有收藏的插件");
    const ok = await copyText(list.map(rawUrl).join("\n"));
    toast(ok ? `已复制 ${list.length} 个插件链接` : "复制失败，请手动复制");
  });

  /* ---------- 注册全局/模块间设置读写接口 ---------- */

  registerSettingsAPI({
    get: () => ({ ...settings }),
    set(next) {
      const prev = settings.showDesc;
      const prevFull = settings.fullDefault;
      settings = { ...settings, ...next };
      lsSet(SETTINGS_KEY, JSON.stringify(settings));
      apply();
      if (prevFull !== settings.fullDefault && !sheet.open && !fullTouched) setFull(settings.fullDefault);
      if (prev !== settings.showDesc && state.plugins.length) render();
    },
  });

  if (sysReduce.addEventListener) sysReduce.addEventListener("change", apply);
  else sysReduce.addListener(apply);

  apply();
}
