/* 设置页（<section id="settings">）：主页面里和「主页」「收藏」并列的一个视图，不是弹层。
   进出由底部 Dock 通过 js/views.js 切换（事件 mlb:page）。
   内容：主题、减少动画、插件卡片显示项（这三组可同步到云端，见 js/account.js），
   以及只存本机的启动页；行内撤销恢复默认与复制收藏链接。 */

import { SETTINGS_KEY, DEFAULTS, BOOL_KEYS, SPLASH_KEY, SORT_KEY, rawUrl } from "./config.js";
import { $id, els, sysReduce, setSwitch, afterPaint, copyText, lsGet, lsSet, lsRemove } from "./dom.js";
import { state, readSort, registerSettingsAPI } from "./state.js";
import { toast } from "./toast.js";
import { render } from "./render.js";
import { syncSort, syncSearch } from "./search-sort.js";
import { showView } from "./views.js";

const REDUCE_HINT = "关闭过渡和入场动画。系统已开启「减少动态效果」时自动生效";
const GRACE = 5000;

/* 设置页打开时列表是藏起来的（量不出卡片高度），所以这时候不画，只记个「过期」标记；回到列表时 js/views.js 看到标记再重画一次 */
const redraw = (opts) => {
  if (!state.plugins.length) return;
  if (state.page === "settings") els.list.dataset.stale = "1";
  else render(opts);
};

export function initSettings() {
  const root = document.documentElement;
  const sheet = $id("settings"); // 现在是页面里的一个 <section>，沿用 sheet 这个变量名
  if (!sheet) return;

  function loadSettings() {
    let s = {};
    try { s = JSON.parse(lsGet(SETTINGS_KEY) || "{}"); } catch {}
    const out = { ...DEFAULTS };
    if (["system", "light", "dark"].includes(s.theme)) out.theme = s.theme;
    for (const k of BOOL_KEYS) if (typeof s[k] === "boolean") out[k] = s[k];
    // 旧版有个「设置页默认全屏」开关（还会同步到云端）。现在改成自动记住上次的全屏选择、只存本机；
    // 开过那个开关的人，第一次打开时把它的值带过来
    if (s.fullDefault === true && lsGet(FULL_KEY) === null) lsSet(FULL_KEY, "1");
    return out;
  }

  let settings = loadSettings();

  // 启动页开关只存在本机 localStorage，不同步到云端。旧版的「设置页全屏」「全屏布局」已经取消，清掉它们留下的本机记录
  ["myloon_box_full"].forEach(lsRemove);
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

  let clearTimer = 0;
  const showClearRow = (done) => {
    $id("clearConfirm").hidden = !done;
    $id("clearBtn").hidden = done;
  };
  const endClear = () => {
    clearTimeout(clearTimer);
    showClearRow(false);
  };

  /* 切到设置页时：刷新「关于」，收起恢复默认的撤销条，并让每个大项各自播一次入场 */
  function enter() {
    renderAbout();
    endClear();
    sheet.classList.remove("enter");
    void sheet.offsetWidth;
    sheet.classList.add("enter");
    $id("settingsTitle").focus({ preventScroll: true });
  }
  document.addEventListener("mlb:page", (e) => {
    if (e.detail === "settings") enter();
    else { endClear(); sheet.classList.remove("enter"); }
  });

  /* ---------- 设置项点击委托 ---------- */

  sheet.addEventListener("click", (e) => {
    const t = e.target.closest("[data-theme-opt]");
    if (t) { settings.theme = t.dataset.themeOpt; save(); apply(); return; }

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
      if (k === "showDesc" || k === "compact") afterPaint(() => redraw());
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
    redraw({ animate: true });

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
      redraw({ animate: true });
      endClear();
      toast("已撤销");
    };
  });

  /* ---------- 新手引导：先回到主页，再打开引导 ---------- */

  $id("tourBtn").addEventListener("click", () => {
    showView("home");
    document.dispatchEvent(new Event("mlb:tour"));
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
      settings = { ...settings, ...next };
      lsSet(SETTINGS_KEY, JSON.stringify(settings));
      apply();
      if (prev !== settings.showDesc) redraw();
    },
  });

  if (sysReduce.addEventListener) sysReduce.addEventListener("change", apply);
  else sysReduce.addListener(apply);

  apply();
}
