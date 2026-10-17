/* 搜索框的手感（借自 Bencho 的 Search / Seek，MIT 许可，bencho.dev/licence）。
   Seek 是「一个图标变成一个输入框」，这里不做展开 / 收起，只取它让控件有手感的几处：

   · 靠近：量的是指针到「框」的距离，不是到被它推开的东西的距离——后者是个反馈回路，会收敛但靠的是抖，
     在这么小的东西上看得出来。几个像素封顶：再大它就不是「回应你」而是「被你拖着走」。聚焦后整个关掉。
   · 按下：一个会在被按时先退让的东西像被推了一下，只会移动的东西像被触发了。
   · 打字：放大镜加粗一点，一阵一次，不是一个键一次——随键盘频率闪的标记是穿着反馈外衣的噪音。
   视觉全在 toolbar.css（--lx/--ly、data-press、data-busy）。 */

import { motionOff } from "./dom.js";

const R = 110;      // 指针进入这个距离才有反应，px
const GIVE = 50;    // 0..100，偏多远；50 时最大约 4.5px

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function initSeekFeel(box, input) {
  if (!box || !input) return;

  /* 按下：只在还没聚焦时（已经在输入时再点是在放光标），也不含里面的按钮 */
  const release = () => { delete box.dataset.press; };
  box.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button") || box.matches(":focus-within")) return;
    box.dataset.press = "true";
  });
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);

  /* 打字：一阵一次 */
  let rest = 0;
  input.addEventListener("input", () => {
    box.dataset.busy = "true";
    clearTimeout(rest);
    rest = setTimeout(() => { delete box.dataset.busy; }, 340);
  });

  /* 靠近：只给有鼠标 / 触控板的设备（手指没有「靠近」） */
  if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  let raf = 0;
  let at = { x: 0, y: 0 };
  const publish = () => {
    raf = 0;
    box.style.setProperty("--lx", at.x.toFixed(2) + "px");
    box.style.setProperty("--ly", at.y.toFixed(2) + "px");
  };
  const set = (x, y) => {
    if (at.x === x && at.y === y) return;
    at = { x, y };
    if (!raf) raf = requestAnimationFrame(publish);
  };
  document.addEventListener("pointermove", (e) => {
    if (motionOff() || box.matches(":focus-within")) return set(0, 0);
    const b = box.getBoundingClientRect();
    /* 到框的距离（在框里面是 0），而不是到中心的距离：框很宽，到中心的距离在两头永远超出 R */
    const dxEdge = Math.max(b.left - e.clientX, 0, e.clientX - b.right);
    const dyEdge = Math.max(b.top - e.clientY, 0, e.clientY - b.bottom);
    const d = Math.hypot(dxEdge, dyEdge);
    if (d > R) return set(0, 0);
    const pull = (1 - d / R) ** 1.4 * (2 + (GIVE / 100) * 5);
    /* 方向：相对中心的偏移，按框的半宽 / 半高加上 R 归一，宽框的左右两头也能朝各自的方向偏 */
    const nx = clamp((e.clientX - (b.left + b.width / 2)) / (b.width / 2 + R), -1, 1);
    const ny = clamp((e.clientY - (b.top + b.height / 2)) / (b.height / 2 + R), -1, 1);
    set(nx * pull, ny * pull);
  }, { passive: true });
  document.addEventListener("pointerleave", () => set(0, 0));
  input.addEventListener("focus", () => set(0, 0));
}
