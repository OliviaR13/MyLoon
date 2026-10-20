/* 底部放大 Dock：主页 / 收藏 / 设置。
   来自 Bencho 的 Magnifying dock（MIT，bencho.dev/licence），从 React 改成了原生 JS，指针处理和注释基本保留。
   和原版的差别：
   - 三个图标是 index.html 里写好的静态按钮，这里只负责「放大」「提示条」「选择」；
   - 「主页」「收藏」「设置」是三个并列的视图，切换逻辑在 js/views.js，这里只管 Dock 本身；
   - 只有三个图标，spread 默认取 1（两边各一个邻居）；取 2 的话中间那个一悬停，两边几乎和它一样大，就不像「被顶起来」了。 */

import { els, motionOff } from "./dom.js";
import { syncTabs } from "./render.js";
import { showView } from "./views.js";

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

  /* ── 选择：交给 js/views.js 切换视图 ─────────────── */
  const choose = (i) => {
    const key = items[i]?.dataset.key;
    pop(i);
    showView(key === "settings" ? "settings" : key === "fav" ? "fav" : "home");
  };

  /* ── 选中那一下：图标自己动一下（主页：小跳；收藏：先压后弹；设置：滑杆微转），和下面滑过去的小圆点是一对 ── */
  const POP = {
    home: [{ transform: "translateY(0) scale(1)" }, { transform: "translateY(-4px) scale(1.12)", offset: 0.4 }, { transform: "translateY(0) scale(1)" }],
    fav: [{ transform: "scale(1)" }, { transform: "scale(.78)", offset: 0.25 }, { transform: "scale(1.18)", offset: 0.62 }, { transform: "scale(1)" }],
    settings: [{ transform: "rotate(0) scale(1)" }, { transform: "rotate(-20deg) scale(1.1)", offset: 0.4 }, { transform: "rotate(0) scale(1)" }],
  };
  function pop(i) {
    if (motionOff()) return;
    const svg = glyphs[i]?.querySelector("svg");
    svg?.animate?.(POP[items[i].dataset.key] || POP.fav, { duration: 460, easing: "cubic-bezier(.25,.8,.3,1)" });
  }

  /* ── 会滑动的选中点 ───────────────────────────────
     以前每个图标下面各有一个点，切换时一个灭一个亮；现在只有一个点，从旧图标下面滑到新图标下面：
     走的时候被拉成一条细线（距离越远拉得越长），到站时弹回成点——液体一样的手感。
     它只读各个按钮的 data-active（render.js 的 syncTabs 写的），所以 Dock、页签、键盘切换都会带着它走。 */
  const ind = document.createElement("span");
  ind.className = "mdock-ind";
  ind.setAttribute("aria-hidden", "true");
  bar.append(ind);
  bar.dataset.ind = "";
  let indX = null;
  let indAnim = null;
  const DOT = 4;
  const placeInd = (animate) => {
    const act = items.find((b) => b.dataset.active === "true");
    if (!act) { ind.style.opacity = "0"; return; }
    ind.style.opacity = "";
    const x = act.offsetLeft + act.offsetWidth / 2 - DOT / 2;
    ind.style.top = act.offsetTop + act.offsetHeight - 3 - DOT + "px";
    const from = indX;
    indX = x;
    ind.style.transform = `translateX(${x}px)`;
    if (!animate || from === null || from === x || motionOff() || !ind.animate) { indAnim?.cancel(); return; }
    /* 动画还没走完时又点了别的：从点现在的位置接着走，不跳回起点 */
    let cur = from;
    if (indAnim && indAnim.playState === "running") {
      const ir = ind.getBoundingClientRect();
      cur = ir.left + ir.width / 2 - bar.getBoundingClientRect().left - DOT / 2;
    }
    indAnim?.cancel();
    const stretch = 1 + Math.min(Math.abs(x - cur) / 4.5, 9);
    indAnim = ind.animate(
      [
        { transform: `translateX(${cur}px) scaleX(1)`, easing: "cubic-bezier(.4,0,.2,1)" },
        { transform: `translateX(${(cur + x) / 2}px) scaleX(${stretch})`, offset: 0.42, easing: "cubic-bezier(.2,.9,.25,1.2)" },
        { transform: `translateX(${x}px) scaleX(1)` },
      ],
      { duration: 480 }
    );
  };
  new MutationObserver(() => placeInd(true)).observe(bar, { subtree: true, attributes: true, attributeFilter: ["data-active"] });
  window.addEventListener("resize", () => placeInd(false));

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
  /* 手机上的响应：每次 pointermove 都去量三个按钮的位置，是白白的强制布局。放大的是里面的图标（transform），
     按钮自己的盒子不会动，所以中心点量一次就够：手势开始时（和窗口变化时）量，滑动过程中直接用缓存 */
  let centers = [];
  const measure = () => {
    centers = items.map((el) => {
      const b = el.getBoundingClientRect();
      return b.left + b.width / 2;
    });
  };
  const at = (clientX) => {
    if (!centers.length) measure();
    let best = 0;
    let gap = Infinity;
    centers.forEach((c, i) => {
      const d = Math.abs(clientX - c);
      if (d < gap) { gap = d; best = i; }
    });
    return best;
  };
  window.addEventListener("resize", measure);
  window.addEventListener("orientationchange", measure);

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
  /* 触屏上轻点一下就切页，提示条刚冒头就收了，看着是闪一下：手指要按住 170ms 以上才显示；鼠标悬停照旧立刻显示 */
  let lastType = "mouse";
  let tipTimer = 0;
  const showTip = (i) => {
    clearTimeout(tipTimer);
    if (!tip) return;
    if (i === null || lastType === "mouse") tip.show(i);
    else tipTimer = setTimeout(() => tip.show(i), 170);
  };
  const to = (i) => {
    if (i === hover) return;
    hover = i;
    paint();
    showTip(i);
  };

  /* 手指滑动时 pointermove 可能一帧来好几个，每个都重画是浪费；记下最新的 x，每帧只算一次 */
  let moveRaf = 0;
  let moveX = 0;
  const track = (e) => {
    /* a mouse magnifies on hover, the way it always did; a
       finger has to be down, or the bar would answer a scroll
       passing over it */
    if (e.pointerType !== "mouse" && !down) return;
    lastType = e.pointerType;
    moveX = e.clientX;
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => { moveRaf = 0; to(at(moveX)); });
  };
  const stopMove = () => { cancelAnimationFrame(moveRaf); moveRaf = 0; };

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
    /* 多指同时按时只认第一根，不然两根手指会把放大和选择搅在一起 */
    if (!e.isPrimary) return;
    lastType = e.pointerType;
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
    measure();
    to(at(e.clientX));
  }, true);
  bar.addEventListener("pointermove", track, true);
  /* ── and the touch has to CHOOSE something ────────────
     With the bar holding the capture the button underneath
     never gets its click, so the lift is where a finger
     picks: whichever item it came to rest over. A mouse is
     untouched by this — it still clicks the button. */
  bar.addEventListener("pointerup", (e) => {
    if (!e.isPrimary) return;
    stopMove();
    if (down && e.pointerType !== "mouse") {
      chose = true;
      /* 手指在 Dock 附近抬起才算选中；按住后拖到很远的地方再松手 = 取消，和 iOS 的 Dock 一样 */
      const r = bar.getBoundingClientRect();
      const near = e.clientX > r.left - 40 && e.clientX < r.right + 40 && e.clientY > r.top - 48 && e.clientY < r.bottom + 40;
      if (near) choose(at(e.clientX));
    }
    down = false;
    if (e.pointerType !== "mouse") to(null);
  }, true);
  bar.addEventListener("pointercancel", () => { stopMove(); down = false; to(null); }, true);
  bar.addEventListener("pointerenter", measure);
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
  placeInd(false);
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
