/* 提示条（灵动岛式，思路借自 Bencho 的 Dynamic Island 与 Toast stack）：
   同一时间只显示一条，可带一个操作按钮；也供下拉刷新（pull.js）共用同一个药丸容器。
   - Dynamic Island：新的提示在上一条还没收起时到来，药丸会比自己大一点点再落回来（「有新活动开始」的那一下点头）。
   - Toast stack：被顶掉的那一条不会凭空消失，而是缩在新的这一条后面，露出一道边（最多两层）。
     这里不画真的多个元素，而是用药丸自己的 box-shadow 负扩展画出两层「后面的」，所以它们天然跟着药丸的圆角、
     走顶层（popover）、一起淡出，也不需要额外的 DOM。 */

import { els, motionOff, buzz } from "./dom.js";

let toastTimer = 0;
let toastHideTimer = 0;
const TOAST_NUB = { w: 96, h: 32, r: 16 };
const TOAST_LEAVE = 340;

// 顶层（popover）只在有模态对话框（设置/详情/引导）打开时才启用，盖过对话框遮罩
export function toastPopover(open) {
  const box = els.toast;
  try {
    if (typeof box.showPopover !== "function") return;
    const isOpen = box.matches(":popover-open");
    if (open && !isOpen && document.querySelector("dialog[open]")) box.showPopover();
    if (!open && isOpen) box.hidePopover();
  } catch {}
}

export function toastSize(w, h, r) {
  const s = els.toast.style;
  s.setProperty("--tw", w + "px");
  s.setProperty("--th", h + "px");
  s.setProperty("--tr", r + "px");
}

// 下拉刷新接管药丸时取消待执行的收起（同时把后面叠着的两层收掉）
export function toastHold() {
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  els.toast.dataset.stack = "0";
}

export function toast(msg, action) {
  const box = els.toast;
  const inner = box.querySelector(".toast-in");
  const act = box.querySelector(".toast-act");
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  /* 上一条正被甩出去时来了新的：甩出动画作废，药丸当作已经收起，新的从小药丸重新长出来 */
  if (flingAnim) dropToast();
  /* 要在清掉状态类之前判断：药丸此刻是不是正好亮着一条「真的提示」（不是下拉刷新的圆环，也不是正在收起） */
  const stacking = box.classList.contains("show") && box.classList.contains("open") &&
    !box.classList.contains("pulling") && !box.classList.contains("working") && !box.classList.contains("leaving");
  box.style.opacity = "";
  box.classList.remove("leaving", "pulling", "armed", "working");
  box.dataset.stack = stacking ? String(Math.min(2, Number(box.dataset.stack || 0) + 1)) : "0";

  const msgEl = box.querySelector(".toast-msg");
  msgEl.style.width = "";
  msgEl.textContent = msg;
  act.hidden = !action;
  act.onclick = action ? () => { hideToast(); action.run(); } : null;
  if (action) act.textContent = action.label;

  const wasShown = box.classList.contains("show");
  if (!wasShown) {
    toastSize(TOAST_NUB.w, TOAST_NUB.h, TOAST_NUB.r);
    box.classList.remove("open");
  }
  toastPopover(true);
  box.classList.add("show");

  const grow = () => {
    msgEl.style.width = "";
    const range = document.createRange();
    range.selectNodeContents(msgEl);
    const scale = inner.offsetWidth ? inner.getBoundingClientRect().width / inner.offsetWidth : 1;
    const textW = Math.ceil(range.getBoundingClientRect().width / (scale || 1));
    if (textW > 0 && textW < msgEl.offsetWidth) msgEl.style.width = textW + 1 + "px";
    const w = inner.offsetWidth, h = inner.offsetHeight;
    toastSize(w, h, Math.min(22, h / 2));
    box.classList.add("open");
  };
  if (wasShown) grow();
  else { void box.offsetWidth; requestAnimationFrame(grow); }
  /* 点头：和药丸的尺寸弹簧分开，用单独的 scale 属性，两者不会互相打架 */
  if (stacking && !motionOff() && box.animate) {
    box.animate({ scale: [1, 1.07, 1] }, { duration: 420, easing: "cubic-bezier(.34,1.4,.64,1)" });
  }

  toastTimer = setTimeout(hideToast, action ? 5000 : 1800);
}

export function hideToast() {
  const box = els.toast;
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  if (!box.classList.contains("show")) return;
  box.classList.remove("open", "pulling", "armed", "working");
  box.classList.add("leaving");
  box.dataset.stack = "0";
  toastSize(TOAST_NUB.w, TOAST_NUB.h, TOAST_NUB.r);
  toastHideTimer = setTimeout(() => {
    box.classList.remove("show", "leaving");
    toastPopover(false);
  }, TOAST_LEAVE + 20);
}

// 离开页面（例如已跳转到 Loon）时收起提示，避免返回后还看到过期的提示
document.addEventListener("visibilitychange", () => { if (document.hidden) hideToast(); });

/* ---------- 滑动关闭 ----------
   只对「亮着的真提示」生效（下拉刷新借用药丸时不行）。左右、向上都能甩掉，向下有阻尼拉不动；
   按住时暂停自动收起，没甩够就弹回原位、重新计时。操作按钮上按下不算拖，照常点。 */
const SWIPE_SLOP = 4;       // 移动超过这么多 px 才算开始拖，以免吃掉轻点
const FLING_DIST = 70;      // 横向拖过这么远松手就关掉
const FLING_UP = 28;        // 向上只要这么远（往灵动岛里收，手指走的路更短）
const FLING_V = 0.45;       // 或者松手时速度超过这个，px/ms

const isLive = (box) => box.classList.contains("show") && box.classList.contains("open") &&
  !box.classList.contains("pulling") && !box.classList.contains("working") && !box.classList.contains("leaving");

/* 不走 hideToast 的「缩回小药丸」那一段：药丸已经被甩出去、透明了，直接复位。
   复位时关掉过渡，否则 opacity / 尺寸会从「甩出去之前」的值过渡回来，闪一下 */
let flingAnim = null;
function dropToast() {
  const box = els.toast;
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  box.style.transition = "none";
  box.classList.remove("show", "open", "leaving", "swiping");
  box.dataset.stack = "0";
  box.style.transform = "";
  box.style.opacity = "";
  toastSize(TOAST_NUB.w, TOAST_NUB.h, TOAST_NUB.r);
  flingAnim?.cancel();
  flingAnim = null;
  void box.offsetWidth;
  box.style.transition = "";
  toastPopover(false);
}

function initSwipe() {
  const box = els.toast;
  let drag = null;
  let settle = null;

  const at = (x, y) => `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  /* 越过边界后的阻尼：拉得越远越拉不动 */
  const rubber = (d) => Math.sign(d) * 18 * Math.log1p(Math.abs(d) / 18);
  const fade = (x, y) => Math.max(0.25, 1 - Math.max(Math.abs(x) / 220, -y / 90, 0));

  box.addEventListener("pointerdown", (e) => {
    if (!isLive(box) || e.button > 0 || e.target.closest(".toast-act")) return;
    settle?.cancel();
    settle = null;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: 0, y: 0, on: false, pts: [{ t: e.timeStamp, x: 0, y: 0 }] };
    clearTimeout(toastTimer); // 按住时不自动收起
  });

  box.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.on) {
      if (Math.hypot(dx, dy) < SWIPE_SLOP) return;
      drag.on = true;
      box.classList.add("swiping");
      try { box.setPointerCapture(e.pointerId); } catch {}
    }
    drag.x = dx;
    drag.y = dy > 0 ? rubber(dy) : dy;
    drag.pts.push({ t: e.timeStamp, x: drag.x, y: drag.y });
    if (drag.pts.length > 5) drag.pts.shift();
    box.style.transform = at(drag.x, drag.y);
    box.style.opacity = String(fade(drag.x, drag.y));
  });

  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    box.classList.remove("swiping");
    const restart = () => { toastTimer = setTimeout(hideToast, box.querySelector(".toast-act").hidden ? 1800 : 5000); };
    if (!d.on) { if (isLive(box)) restart(); return; }

    /* 松手速度：取最近几个点首尾的平均，比只看最后一帧稳 */
    const a = d.pts[0], b = d.pts[d.pts.length - 1];
    const dt = Math.max(1, b.t - a.t);
    const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
    const side = Math.abs(d.x) > FLING_DIST || (Math.abs(vx) > FLING_V && Math.abs(vx) > Math.abs(vy) && Math.sign(vx) === Math.sign(d.x));
    const up = d.y < -FLING_UP || (vy < -FLING_V && d.y < 0);

    if (side || up) {
      buzz(8);
      if (motionOff() || !box.animate) { dropToast(); return; }
      const w = box.offsetWidth;
      const tx = side ? d.x + Math.sign(d.x || vx) * (w * 0.6 + 60) : d.x * 1.3;
      const ty = side ? d.y : d.y - 60;
      flingAnim = box.animate(
        [{ transform: at(d.x, d.y), opacity: fade(d.x, d.y) }, { transform: at(tx, ty), opacity: 0 }],
        { duration: 220, easing: "cubic-bezier(.2,.6,.35,1)", fill: "forwards" }
      );
      flingAnim.onfinish = dropToast;
      return;
    }

    /* 没甩够：弹回原位 */
    box.style.transform = "";
    box.style.opacity = "";
    if (!motionOff() && box.animate) {
      settle = box.animate(
        [{ transform: at(d.x, d.y), opacity: fade(d.x, d.y) }, { transform: "translate(0, 0)", opacity: 1 }],
        { duration: 420, easing: "cubic-bezier(.34,1.4,.64,1)" }
      );
    }
    restart();
  };
  box.addEventListener("pointerup", end);
  box.addEventListener("pointercancel", end);
}
initSwipe();
