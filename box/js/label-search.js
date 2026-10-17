/* 搜索框的浮动标签（移植自 Bencho 的 Label input，MIT 许可，bencho.dev/licence；原版是 React，这里改成原生 JS）。
   标签平时就是占位符；聚焦时它抬到上边框上，字母依次轻轻跳一下，描边在原地变深，上边框从标签下面的中点向两边让出缺口。

   ── 只有一样东西在动 ──────────────────────────────
   描边始终是完整的；聚焦只改它的颜色并打开缺口。标签是事件，线是为它让位。
   缺口是跨过凹口的两小段路径，各从中点出发走向一侧，用负的 dash offset 从中点向外「收回」。

   这里只做外观：输入框、清除按钮、搜索按钮、过滤逻辑都还是 js/search-sort.js 的，一个字没动。
   删掉 app.js 里的 initLabelSearch() 那一行，就回到原来的占位符样式。 */

import { el, els } from "./dom.js";

const NS = "http://www.w3.org/2000/svg";
/* 抬起后标签相对静止时的缩放 */
const S = 0.78;
/* 描边向内缩进半个最粗线宽，免得被 svg 自己的边裁掉 */
const IN = 0.75;

const path = (cls) => {
  const p = document.createElementNS(NS, "path");
  if (cls) p.setAttribute("class", cls);
  return p;
};

export function initLabelSearch() {
  const box = els.searchBox;
  const input = els.search;
  if (!box || !input) return;

  const text = input.getAttribute("aria-label") || "搜索插件";
  box.classList.add("lbi");
  /* 标签取代占位符；输入框的 aria-label 仍是它的名字 */
  input.placeholder = "";

  const label = el("label", "lbi-label");
  label.htmlFor = input.id;
  label.setAttribute("aria-hidden", "true");
  [...text].forEach((ch, i) => {
    const s = el("span", "", ch);
    s.style.setProperty("--i", i);
    label.append(s);
  });

  const ring = document.createElementNS(NS, "svg");
  ring.setAttribute("class", "lbi-ring");
  ring.setAttribute("aria-hidden", "true");
  const right = path();
  const left = path();
  const gapL = path("lbi-gap");
  const gapR = path("lbi-gap");
  [gapL, gapR].forEach((g) => g.setAttribute("pathLength", "1"));
  ring.append(right, left, gapL, gapR);
  box.prepend(ring);
  box.append(label);

  /* ── 几何：盒子（含 1px 边框）的宽高、标签的起点和宽度，都是量出来的 ──
     标签永远不在圆角的弧线里：凹口得开在上边的直线段上，所以更圆的框要把标签放得更靠里。
     标签起点取输入框的左边（放大镜右边），凹口比抬起后的标签两头各宽 5px。 */
  function layout() {
    const W = box.offsetWidth;
    const H = box.offsetHeight;
    if (!W || !H) return;
    const r = Math.min(H / 2, parseFloat(getComputedStyle(box).borderTopLeftRadius) || H / 2);
    const bw = box.clientLeft; // 边框宽度；svg 盖在边框上，坐标从边框外沿算起
    const lx = input.offsetLeft;
    const lw = label.offsetWidth;
    const x = lx + bw;
    const x0 = Math.max(r * 0.6, x - 5);
    const x1 = x + lw * S + 5;
    const a = r - IN;
    const R = W - IN;
    const B = H - IN;
    const mid = W / 2;
    const nm = (x0 + x1) / 2;
    ring.setAttribute("width", W);
    ring.setAttribute("height", H);
    ring.setAttribute("viewBox", `0 0 ${W} ${H}`);
    gapL.setAttribute("d", `M${nm},${IN} L${x0},${IN}`);
    gapR.setAttribute("d", `M${nm},${IN} L${x1},${IN}`);
    /* 右半：从凹口顺时针到下边中点；左半：从凹口反方向绕到同一点 */
    right.setAttribute("d", `M${x1},${IN} L${W - r},${IN} A${a},${a} 0 0 1 ${R},${r} L${R},${H - r} A${a},${a} 0 0 1 ${W - r},${B} L${mid},${B}`);
    left.setAttribute("d", `M${x0},${IN} L${r},${IN} A${a},${a} 0 0 0 ${IN},${r} L${IN},${H - r} A${a},${a} 0 0 0 ${r},${B} L${mid},${B}`);
    box.style.setProperty("--lbi-x", lx + "px");
    /* 抬起 = 把标签的中心从框的正中移到上边框上，也就是上移半个框高 */
    box.style.setProperty("--lbi-lift", H / 2 + "px");
  }

  /* ── 状态：聚焦或有内容时标签抬起 ── */
  let focus = false;
  function sync() {
    const filled = input.value !== "";
    box.dataset.up = String(focus || filled);
    box.dataset.focus = String(focus);
    box.dataset.filled = String(filled);
  }
  input.addEventListener("focus", () => { focus = true; sync(); });
  input.addEventListener("blur", () => { focus = false; sync(); });
  input.addEventListener("input", sync);
  /* 「清除」「重置筛选」是程序改的值，不触发 input 事件；search-sort.js 每次都会更新 data-has，跟着它同步 */
  new MutationObserver(sync).observe(box, { attributes: true, attributeFilter: ["data-has"] });

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(layout);
    ro.observe(box);
    ro.observe(label);
  } else {
    window.addEventListener("resize", layout);
  }
  /* 字体到位后标签宽度会变 */
  document.fonts?.ready.then(layout);
  layout();
  sync();
}
