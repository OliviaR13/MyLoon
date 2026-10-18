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
   4. 换内容后只让列表整体从 55% 不透明度回到 100%，从来不会变成全透明。 */

import { CONFIG, FAV } from "./config.js";
import { els, motionOff } from "./dom.js";
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

const syncChips = () =>
  els.filters.querySelectorAll(".chip-filter").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.name === state.category)));

export function showView(view) {
  const from = currentView();

  if (view === from) {
    // 已经在这个视图：主页上选着某个分类时回到「全部」，否则只是回到顶部
    if (view === "home" && state.category !== CONFIG.all) {
      state.category = CONFIG.all;
      syncChips();
      syncTabs();
      jump(0);
      render();
      fade();
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
  root.dataset.page = state.page;

  if (!toSettings) {
    syncChips();
    // 从设置回来一律重画一次：设置里改过显示项，而且列表在隐藏时量不出「展开」按钮要不要显示
    render();
    if (from !== "settings" || state.category !== prevCategory) fade();
  }
  syncTabs();
  jump(toSettings ? 0 : memo[view] || 0);
  document.dispatchEvent(new CustomEvent("mlb:page", { detail: state.page }));
}

root.dataset.page = state.page;
