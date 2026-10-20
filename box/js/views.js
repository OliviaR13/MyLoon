/* 页面切换：主页 / 收藏 / 设置，由底部 Dock（js/nav-dock.js）调用。

   三个都是同一个页面里的「视图」，不是弹层：
   - 主页、收藏共用同一个插件列表，只是 state.category 不同（全部 / 收藏）；
   - 设置是另一块内容（<section id="settings">），列表那一块（吸顶栏、计数、列表）藏起来；
   - 谁显示谁隐藏由 <html data-page="list|settings"> 控制，样式在 styles/nav-dock.css。

   切换时不闪的几条（之前 Dock 切主页 / 收藏会闪）：
   1. 不再重放「逐张卡片从透明淡入」的入场动画——那一下会让整个列表先变空白再长出来；
   2. 先把滚动位置落好再换内容：html 上有 scroll-behavior:smooth，直接 scrollTo 会变成慢慢滚，
      内容换了、页面高度缩了，还在边滚边夹，所以一律用 behavior:"instant"；
   3. 每个视图记住自己的滚动位置，切回来还在原处（和 App 里的标签页一样）；
   4. 换内容后新内容从来的方向滑进来，起点是 40% 不透明度，从来不会变成全透明（见 enter）。 */

import { CONFIG, FAV } from "./config.js";
import { els, motionOff, afterPaint } from "./dom.js";
import { state } from "./state.js";
import { render, syncTabs } from "./render.js";

const root = document.documentElement;
const memo = { home: 0, fav: 0 };

export const currentView = () => (state.page === "settings" ? "settings" : state.category === FAV ? "fav" : "home");

const jump = (top) => window.scrollTo({ top, behavior: "instant" });

const fade = () => {
  if (motionOff() || !els.list.animate) return;
  els.list.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
};

/* 切换时新内容从「来的方向」滑进来：Dock 从左到右是 主页 → 收藏 → 设置，往右切就从右边进，往左切就从左边进。
   只做进场、不做出场（出场要等一段时间才能换内容，会拖慢切换，也是以前闪的原因之一）；
   起点不透明度 .4 而不是 0，所以从来不会有一瞬间是空白。设置页自己有逐行入场，这里只让整块位移，不再叠一层淡入 */
const ORDER = { home: 0, fav: 1, settings: 2 };
function enter(from, to) {
  if (motionOff()) return;
  const x = (ORDER[to] > ORDER[from] ? 1 : -1) * 26;
  const move = (node, fadeIn) =>
    node?.animate?.(
      fadeIn ? [{ opacity: 0.4, transform: `translateX(${x}px)` }, { opacity: 1, transform: "none" }] : [{ transform: `translateX(${x}px)` }, { transform: "none" }],
      { duration: 380, easing: "cubic-bezier(.2,.85,.25,1)" }
    );
  if (to === "settings") {
    move(document.getElementById("settings"), false);
  } else {
    move(document.querySelector(".meta"), true);
    move(els.list, true);
    if (from === "settings") move(els.dock, false); // 搜索 / 分类栏是从设置页回来时才重新出现的
  }
}

const syncChips = () =>
  els.filters.querySelectorAll(".chip-filter").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.name === state.category)));

/* 点 Dock 时先让 Dock 自己立刻有反应（选中态是同步改的），把换内容（重画列表、搬滚动位置）推迟到 Dock 画完之后：
   手机上重画几十张卡片要几十毫秒，同步做的话 Dock 的反馈会被一起拖慢。
   连点时先把还没做完的那一次立刻做完，保证滚动位置的记录不会错位 */
let job = null;
const flush = () => {
  const j = job;
  job = null;
  if (j) j();
};
const defer = (fn) => {
  job = fn;
  afterPaint(() => {
    if (job === fn) {
      job = null;
      fn();
    }
  });
};

export function showView(view) {
  flush();
  const from = currentView();

  if (view === from) {
    // 已经在这个视图：主页上选着某个分类时回到「全部」，否则只是回到顶部
    if (view === "home" && state.category !== CONFIG.all) {
      state.category = CONFIG.all;
      syncTabs();
      defer(() => {
        syncChips();
        jump(0);
        render();
        fade();
      });
    } else if (scrollY > 2) {
      window.scrollTo({ top: 0, behavior: motionOff() ? "instant" : "smooth" });
    }
    return;
  }

  if (from !== "settings") memo[from] = scrollY;
  const prevCategory = state.category;
  const toSettings = view === "settings";
  if (!toSettings) state.category = view === "fav" ? FAV : CONFIG.all;
  state.page = toSettings ? "settings" : "list";
  syncTabs(); // Dock 的选中态马上变

  defer(() => {
    root.dataset.page = state.page;
    if (!toSettings) {
      syncChips();
      /* 画不画：换了分类一定画；从设置回来，只有设置里改过显示项（列表被标过期）才画。
         没改过就沿用原来的列表，切回来不用重画几十张卡片 */
      const redraw = from !== "settings" || state.category !== prevCategory || els.list.dataset.stale === "1";
      if (redraw) render();
    }
    jump(toSettings ? 0 : memo[view] || 0);
    enter(from, view);
    document.dispatchEvent(new CustomEvent("mlb:page", { detail: state.page }));
  });
}

root.dataset.page = state.page;
