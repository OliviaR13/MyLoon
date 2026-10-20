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
import { state, matches, searchTerms } from "./state.js";
import { render, syncTabs } from "./render.js";

const root = document.documentElement;
const memo = { home: 0, fav: 0 };

export const currentView = () => (state.page === "settings" ? "settings" : state.category === FAV ? "fav" : "home");

const jump = (top) => window.scrollTo({ top, behavior: "instant" });

const fade = () => {
  if (motionOff() || !els.list.animate) return;
  els.list.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
};

/* ══ 切换动效 ══════════════════════════════════════════════
   之前闪，是因为「旧内容 100% 不透明地立刻换掉，新内容却从 40% 开始淡入」——中间那一下掉了亮度。
   现在是连续的：旧内容先淡出（110ms），在完全看不见的时候换内容、搬滚动位置，新内容再从同样的 0 淡入，亮度始终是一条连续的线。

   主页 ⇄ 收藏是例外（它们是同一个列表，只是筛选不同）：整块淡出淡入会把「没变的卡片」也一起闪一下，
   而且开了「收藏置顶」时，收藏排在最上面，主页和收藏的前几张本来就一样，整块淡入淡出看上去就是「没变化」。
   所以这里只让「要消失的卡片」淡出，留下的卡片原地不动，其余的滑到新位置、新出现的淡入（render 的 flip）。
   主页→收藏：别的卡片消失，收藏留在原地；收藏→主页：别的卡片从下面长出来。 */
const ORDER = { home: 0, fav: 1, settings: 2 };
const settingsEl = () => document.getElementById("settings");
const metaEl = () => document.querySelector(".meta");
const outNodes = (from, to) => (from === "settings" ? [settingsEl()] : [metaEl(), els.list, ...(to === "settings" ? [els.dock] : [])]);
const inNodes = (from, to) => (to === "settings" ? [settingsEl()] : [metaEl(), els.list, ...(from === "settings" ? [els.dock] : [])]);

/* 新内容从「来的方向」滑进来并淡入：Dock 从左到右是 主页 → 收藏 → 设置，往右切就从右边进 */
function enter(from, to) {
  if (motionOff()) return;
  const x = (ORDER[to] > ORDER[from] ? 1 : -1) * 22;
  inNodes(from, to).forEach((n) =>
    n?.animate?.([{ opacity: 0, transform: `translateX(${x}px)` }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.85,.25,1)" })
  );
}

const syncChips = () =>
  els.filters.querySelectorAll(".chip-filter").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.name === state.category)));

/* 离场动画放完才换内容；连点时先把还没做完的那一次立刻做完（并取消它的离场动画），保证滚动位置的记录不会错位。
   点 Dock 时 Dock 自己的选中态是同步改的，不会被这里拖慢 */
let pending = null;
const flush = () => {
  const p = pending;
  pending = null;
  if (!p) return;
  p.anims.forEach((a) => a.cancel());
  p.swap();
};
const queue = (swap, anims = []) => {
  const p = { swap, anims };
  pending = p;
  const go = () => { if (pending === p) flush(); };
  if (anims.length) anims[0].finished.then(go, () => {}); // 被 flush 取消时会 reject，忽略
  else afterPaint(go);
};

const onScreen = (n) => {
  const r = n.getBoundingClientRect();
  return r.bottom > 0 && r.top < innerHeight;
};

export function showView(view) {
  flush();
  const from = currentView();

  if (view === from) {
    // 已经在这个视图：主页上选着某个分类时回到「全部」，否则只是回到顶部
    if (view === "home" && state.category !== CONFIG.all) {
      state.category = CONFIG.all;
      syncTabs();
      queue(() => {
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

  const target = toSettings ? 0 : memo[view] || 0;
  /* 主页 ⇄ 收藏、而且滚动位置不用变（通常在顶部）：只动「要消失的卡片」 */
  const listToList = from !== "settings" && !toSettings;
  const filterOnly = listToList && !motionOff() && Math.abs(scrollY - target) < 2 && els.list.animate;

  const swap = () => {
    root.dataset.page = state.page;
    if (!toSettings) {
      syncChips();
      /* 画不画：换了分类一定画；从设置回来，只有设置里改过显示项（列表被标过期）才画。
         没改过就沿用原来的列表，切回来不用重画几十张卡片 */
      const redraw = from !== "settings" || state.category !== prevCategory || els.list.dataset.stale === "1";
      if (redraw) render({ flip: !!filterOnly });
    }
    if (!filterOnly) {
      jump(target);
      enter(from, view);
    }
    document.dispatchEvent(new CustomEvent("mlb:page", { detail: state.page }));
  };

  let anims = [];
  if (!motionOff()) {
    if (filterOnly) {
      const terms = searchTerms();
      const keep = new Set(state.plugins.filter((p) => matches(p, terms)).map((p) => p.id));
      anims = [...els.list.querySelectorAll(".card")]
        .filter((c) => !keep.has(c.dataset.id) && onScreen(c))
        .map((c) => c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "ease-in", fill: "forwards" }));
    } else {
      const dir = ORDER[view] > ORDER[from] ? 1 : -1;
      anims = outNodes(from, view)
        .filter((n) => n?.animate)
        .map((n) => n.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 14}px)` }], { duration: 110, easing: "ease-in", fill: "forwards" }));
    }
  }
  queue(swap, anims);
}

root.dataset.page = state.page;
