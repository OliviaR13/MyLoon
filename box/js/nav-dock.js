/* 底部放大 Dock：主页 / 收藏 / 设置。
   来自 Bencho 的 Magnifying dock（MIT，bencho.dev/licence），从 React 改成了原生 JS，指针处理和注释基本保留。
   和原版的差别：
   - 三个图标是 index.html 里写好的静态按钮，这里只负责「放大」「提示条」「选择」；
   - 「主页」「收藏」是视图（state.category = 全部 / 收藏），「设置」是一个动作（打开设置面板），不会变成选中态；
   - 只有三个图标，spread 默认取 1（两边各一个邻居）；取 2 的话中间那个一悬停，两边几乎和它一样大，就不像「被顶起来」了。 */

import { CONFIG, FAV } from "./config.js";
import { els, motionOff } from "./dom.js";
import { state } from "./state.js";
import { render, syncTabs } from "./render.js";

/* ══ dock, distance based magnification ═══════════════════
   Scale falls off with distance from the cursor rather than
   applying only to the hovered item, which is what stops it
   reading as a row of buttons that happen to grow. */

export function initNavDock({
  /* what the glyph under the cursor grows to */
  magnify = 1.32,
  /* how many neighbours either side feel it. This is the knob
     that decides whether the dock reads as a row of buttons
     that happen to grow or as a sheet being pushed up from
     underneath — at 0 it is the former, and no amount of
     magnification rescues it. */
  spread = 1,
  /* how far the nearest glyph rises out of the bar */
  lift = 8,
  /* the name that appears over whatever is under the cursor */
  labels = true,
} = {}) {
  const bar = els.navDock;
  if (!bar) return;
  const items = [...bar.querySelectorAll(".mdock-item")];
  const glyphs = items.map((b) => b.querySelector(".mdock-glyph"));
  let hover = null;
  let down = false;
  /* set when a finger has already chosen on lift, so the click
     the browser sends afterwards — aimed at whichever item the
     touch STARTED on, which is not the one it ended over — does
     not undo the choice. A mouse never sets it. */
  let chose = false;

  /* ── 选择：主页 / 收藏切换视图，设置打开面板 ─────────────── */
  const toTop = () => {
    if ((window.scrollY || 0) > 2) window.scrollTo({ top: 0, behavior: motionOff() ? "auto" : "smooth" });
  };
  const choose = (i) => {
    const key = items[i]?.dataset.key;
    if (key === "settings") {
      document.dispatchEvent(new Event("mlb:settings"));
      return;
    }
    const target = key === "fav" ? FAV : CONFIG.all;
    if (state.category === target) { toTop(); return; } // 已经在这个视图：回到顶部
    state.category = target;
    els.filters.querySelectorAll(".chip-filter").forEach((x) =>
      x.setAttribute("aria-pressed", String(x.dataset.name === state.category))
    );
    syncTabs();
    render({ animate: true });
    toTop();
  };

  /* ── THE BAR READS THE POINTER, THE ITEMS DO NOT ─────────
     Each item used to carry its own onMouseEnter, which fails
     on a touch screen twice over. A mouse event is the smaller
     half of it — the real problem is that a touch is captured
     to whatever it started on, so sliding a finger along the
     dock keeps sending every event to the first icon you
     landed on and nothing else ever learns the finger arrived.

     One handler on the bar, and the index comes from where the
     pointer is: the nearest item centre to the pointer's x.
     Measured rather than derived from the index, because the
     items are not all the same width once one of them is
     magnified — the geometry moves as you sweep, which is
     exactly what makes a dock a dock, and an arithmetic guess
     would lag it. */
  const at = (clientX) => {
    let best = 0;
    let gap = Infinity;
    items.forEach((el, i) => {
      const b = el.getBoundingClientRect();
      const d = Math.abs(clientX - (b.left + b.width / 2));
      if (d < gap) { gap = d; best = i; }
    });
    return best;
  };

  /* A raised cosine over the reach, rather than the three
     hand-picked steps this used to carry. Those could not
     be made adjustable without also picking every
     intermediate value by hand, and a curve is what the
     effect was always imitating: 1 under the cursor,
     easing to 0 at the edge of the reach, and flat zero
     past it. 「减少动画」打开时不放大，只留提示条 */
  const paint = () => {
    const calm = motionOff();
    items.forEach((el, i) => {
      const d = hover === null ? 99 : Math.abs(i - hover);
      const f = calm || d > spread ? 0 : (1 + Math.cos((Math.PI * d) / (spread + 1))) / 2;
      const scale = 1 + (magnify - 1) * f;
      glyphs[i].style.transform = f ? `translateY(${-lift * f}px) scale(${scale})` : "";
      if (d <= 1) el.dataset.near = String(d);
      else el.removeAttribute("data-near");
    });
  };

  const tip = labels ? makeTip(bar, items) : null;
  const to = (i) => {
    if (i === hover) return;
    hover = i;
    paint();
    tip?.show(i);
  };

  const track = (e) => {
    /* a mouse magnifies on hover, the way it always did; a
       finger has to be down, or the bar would answer a scroll
       passing over it */
    if (e.pointerType !== "mouse" && !down) return;
    to(at(e.clientX));
  };

  /* ── CAPTURE PHASE, and no pointer capture ───────────
     Two different things with confusingly similar names.

     The phase is capture so the bar hears the pointer before
     any child can stop it. What this does NOT do is call
     setPointerCapture. The touch is already captured to the
     item it began on whether we ask or not, and those events
     reach here with their real coordinates, which is all this
     needs. Capturing on the bar as well would retarget the
     click and take it from the item — breaking the mouse to
     fix the finger. */
  bar.addEventListener("pointerdown", (e) => {
    down = true;
    /* ── disarmed HERE, not by the click ────────────────
       `chose` used to be cleared by the click it was meant
       to swallow, which assumes a click always follows a
       touch. It does not: a finger that lands on one item
       and lifts over another is a drag, and a browser is
       entitled to send no click at all. Cleared at the start
       of the next gesture instead, which is true whatever the
       browser decided to do with the last one. */
    chose = false;
    to(at(e.clientX));
  }, true);
  bar.addEventListener("pointermove", track, true);
  /* ── and the touch has to CHOOSE something ────────────
     With the bar holding the capture the button underneath
     never gets its click, so the lift is where a finger
     picks: whichever item it came to rest over. A mouse is
     untouched by this — it still clicks the button. */
  bar.addEventListener("pointerup", (e) => {
    if (down && e.pointerType !== "mouse") {
      chose = true;
      choose(at(e.clientX));
    }
    down = false;
    if (e.pointerType !== "mouse") to(null);
  }, true);
  bar.addEventListener("pointercancel", () => { down = false; to(null); }, true);
  bar.addEventListener("pointerleave", () => { if (!down) to(null); });

  items.forEach((el, i) => {
    el.addEventListener("click", (e) => {
      /* the lift already chose — see `chose`. e.detail === 0 是键盘（回车 / 空格）触发的点击，不是触摸后补发的那一下，照样选 */
      if (chose && e.detail > 0) { chose = false; return; }
      choose(i);
    });
  });

  /* 在 Dock 上按下 / 滑动时，不让下拉刷新（pull.js 监听的是 document 上的 touchstart）把它当成一次下拉 */
  bar.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  paint();
  syncTabs();
}

/* ── ONE TIP THAT TRAVELS ─────────────────────────────────
   After the avatar tooltip in transitions.dev's share dialog: not a
   label per icon blinking on and off, but one pill that slides
   along to whichever icon is under the pointer and changes width to
   fit the new word as it goes, both on one short curve. It keeps the
   last word while it fades, so leaving the dock does not empty it
   mid-fade. Its place is read off the item it sits over, centre to
   centre, since a magnified dock does not lay out evenly. */
function makeTip(bar, items) {
  const tip = document.createElement("span");
  tip.className = "mdock-tip";
  tip.setAttribute("aria-hidden", "true");
  const word = document.createElement("span");
  tip.append(word);
  bar.append(tip);

  let last = -1;
  /* the first placing must not slide in from the bar's left edge:
     until it has been placed once it moves without a transition */
  let ready = false;

  const place = (i) => {
    last = i;
    word.textContent = items[i].dataset.label || items[i].getAttribute("aria-label") || "";
    /* offsetLeft is layout, so the glyph's own scale does not skew it */
    const w = Math.ceil(word.scrollWidth) + 24;
    const x = items[i].offsetLeft + items[i].offsetWidth / 2 - w / 2;
    tip.style.width = w + "px";
    tip.style.transform = `translateX(${x}px)`;
    if (!ready) requestAnimationFrame(() => { ready = true; tip.dataset.ready = ""; });
  };

  return {
    show(i) {
      if (i !== null && i !== last) place(i);
      tip.dataset.on = String(i !== null);
    },
  };
}
