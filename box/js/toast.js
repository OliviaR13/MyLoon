/* 提示条（灵动岛式，思路借自 Bencho 的 Dynamic Island）：
   同一时间只显示一条，可带一个操作按钮；也供下拉刷新（pull.js）共用同一个药丸容器。 */

import { els } from "./dom.js";

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

// 下拉刷新接管药丸时取消待执行的收起
export function toastHold() {
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
}

export function toast(msg, action) {
  const box = els.toast;
  const inner = box.querySelector(".toast-in");
  const act = box.querySelector(".toast-act");
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  box.style.opacity = "";
  box.classList.remove("leaving", "pulling", "armed", "working");

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

  toastTimer = setTimeout(hideToast, action ? 5000 : 1800);
}

export function hideToast() {
  const box = els.toast;
  clearTimeout(toastTimer);
  clearTimeout(toastHideTimer);
  if (!box.classList.contains("show")) return;
  box.classList.remove("open", "pulling", "armed", "working");
  box.classList.add("leaving");
  toastSize(TOAST_NUB.w, TOAST_NUB.h, TOAST_NUB.r);
  toastHideTimer = setTimeout(() => {
    box.classList.remove("show", "leaving");
    toastPopover(false);
  }, TOAST_LEAVE + 20);
}

// 离开页面（例如已跳转到 Loon）时收起提示，避免返回后还看到过期的提示
document.addEventListener("visibilitychange", () => { if (document.hidden) hideToast(); });
