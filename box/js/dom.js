/* DOM 工具、SVG 图标生成、本地存储封装与通用交互动效（液体开关、星标爆发、里程表数字、按钮自确认） */

export const $ = (sel) => document.querySelector(sel);
export const $id = (id) => document.getElementById(id);

export const els = {
  list: $("#results"),
  count: $("#countText"),
  updated: $("#updatedText"),
  filters: $("#filters"),
  search: $("#searchInput"),
  refresh: $("#refreshBtn"),
  tpl: $("#rowTpl"),
  toast: $("#toast"),
  sort: $("#sortBox"),
  navDock: $("#navDock"),
  dock: $("#dock"),
  searchBox: $("#searchBox"),
  searchField: $("#searchField"),
  searchClear: $("#searchClear"),
};

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
export const lsRemove = (k) => { try { localStorage.removeItem(k); } catch {} };

/* ---------- SVG 图标生成 ---------- */

const SVG_NS = "http://www.w3.org/2000/svg";

export function svgIcon(d, extra = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const [k, v] of Object.entries(extra)) svg.setAttribute(k, v);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

export const checkIcon = () => svgIcon("M5 12.5l4.5 4.5L19 7.5");
export const starIcon = () => svgIcon("M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9L3.5 9.7l5.9-.8z");
export const sortIcon = () => svgIcon("M8 4v16M8 4L5 7M8 4l3 3M16 20V4M16 20l-3-3M16 20l3-3");
export const chevronIcon = () => svgIcon("M6 14.5l6-6 6 6");

export function infoIcon() {
  // 圆圈 + 竖线 + 实心小点。小点不能用「零长度的线 + 圆头」画：.star 的 svg 没设 linecap，Safari 里会直接消失
  const svg = svgIcon("M12 11.2v5");
  const c = document.createElementNS(SVG_NS, "circle");
  for (const [k, v] of Object.entries({ cx: 12, cy: 12, r: 8.5 })) c.setAttribute(k, v);
  const dot = document.createElementNS(SVG_NS, "circle");
  for (const [k, v] of Object.entries({ cx: 12, cy: 7.9, r: 1, fill: "currentColor", stroke: "none" })) dot.setAttribute(k, v);
  svg.prepend(c);
  svg.append(dot);
  return svg;
}

export function crossIcon() {
  return svgIcon("M6 6l12 12M18 6L6 18", {
    width: 12,
    height: 12,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 3,
    "stroke-linecap": "round",
  });
}

/* ---------- 动效控制与通用微交互 ---------- */

export const sysReduce = matchMedia("(prefers-reduced-motion: reduce)");
export const motionOff = () => document.documentElement.hasAttribute("data-reduce-motion") || sysReduce.matches;
export const afterPaint = (fn) => requestAnimationFrame(() => requestAnimationFrame(fn));

/* 收藏时的爆发动效（借自 Bencho 的 Like · Bloom）：
   星标挤压回弹 + 光盘镂空圆环 + 七对彩点沿辐条飞出。只在收藏时播放，取消收藏不庆祝。 */
const BURST_COLORS = ["#f48ea7", "#cc8ef5", "#8ce8c3", "#91d2fa", "#f5a524", "#e5484d", "#9fc7fa"];

export function burstStar(btn) {
  if (motionOff()) return;
  btn.querySelector(".star-burst")?.remove();
  const svg = btn.querySelector("svg");
  svg.classList.remove("pop");
  void svg.getBoundingClientRect();
  svg.classList.add("pop");

  const wrap = el("span", "star-burst");
  wrap.setAttribute("aria-hidden", "true");
  wrap.append(el("span", "star-ring"));
  BURST_COLORS.forEach((c, k) => {
    const spoke = el("span", "star-spoke");
    spoke.style.setProperty("--a", `${(k * 360) / BURST_COLORS.length - 90}deg`);
    [c, BURST_COLORS[(k + 3) % BURST_COLORS.length]].forEach((color) => {
      const dot = el("i");
      dot.style.setProperty("--c", color);
      spoke.append(dot);
    });
    wrap.append(spoke);
  });
  btn.append(wrap);
  setTimeout(() => { wrap.remove(); svg.classList.remove("pop"); }, 900);
}

/* 液体开关（借自 Bencho 的 Liquid toggle）：
   滑块沿行进方向被拉长、同时变薄（面积保持），到位时带轻微回弹。 */
export function liquidThumb(host, on) {
  if (!host || !host.animate || motionOff()) return;
  const travel = host.offsetWidth - host.offsetHeight;
  if (travel <= 0) return;
  const [a, b] = on ? [0, travel] : [travel, 0];
  const at = (x, sx, sy) => `translateX(${x}px) scale(${sx}, ${sy})`;
  try {
    host.animate(
      [
        { transform: at(a, 1, 1) },
        { transform: at((a + b) / 2, 1.34, 0.76), offset: 0.42 },
        { transform: at(b, 1, 1) },
      ],
      { duration: 460, easing: "cubic-bezier(.3,1.2,.5,1)", pseudoElement: "::after" }
    );
  } catch {}
}

/* 开关状态的唯一入口：写 aria-checked，状态真的变了且不是首次初始化时播放液体动效 */
export function setSwitch(host, on, thumb = host) {
  if (!host) return;
  const prev = host.getAttribute("aria-checked");
  const next = String(!!on);
  if (prev === next) return;
  host.setAttribute("aria-checked", next);
  if (prev !== null) liquidThumb(thumb, !!on);
}

/* 数字滚动（借自 Bencho 的 Like：里程表式计数）：只有变化的数字位上下滚动 */
const ROLL_EASE = "cubic-bezier(.2,.8,.2,1)";
const slotOf = (ch) => { const s = el("span", "odo"); s.append(el("span", "odo-cur", ch)); return s; };

function rollSlot(slot, to, dir, delay) {
  const cur = slot.querySelector(".odo-cur");
  const old = el("span", "odo-old", cur.textContent);
  slot.append(old);
  cur.textContent = to;
  const opt = { duration: 380, delay, easing: ROLL_EASE };
  cur.animate([{ transform: `translateY(${dir * 100}%)`, opacity: 0 }, { transform: "none", opacity: 1 }], { ...opt, fill: "backwards" });
  old.animate([{ transform: "none", opacity: 1 }, { transform: `translateY(${-dir * 100}%)`, opacity: 0 }], { ...opt, fill: "both" }).onfinish = () => old.remove();
}

function settleNum(n) {
  clearTimeout(n._t);
  if (n.querySelector(".odo-old") || n.children.length !== n._v.length) n.replaceChildren(...[...n._v].map(slotOf));
}

function rollNum(n, to) {
  settleNum(n);
  const from = n._v;
  if (from === to) return;
  const dir = Number(to) >= Number(from) ? 1 : -1;
  n._v = to;
  if (from.length === to.length) {
    [...to].forEach((ch, i) => { if (ch !== from[i]) rollSlot(n.children[i], ch, dir, (to.length - 1 - i) * 45); });
  } else {
    const slot = slotOf(from);
    n.replaceChildren(slot);
    rollSlot(slot, to, dir, 0);
    n._t = setTimeout(() => settleNum(n), 460);
  }
}

export function setRollText(host, text) {
  const parts = text.split(/(\d+)/);
  const shape = parts.filter((_, i) => i % 2 === 0).join("\u0000");
  const prev = host._roll;
  if (prev && host.contains(prev.vis) && prev.shape === shape && !motionOff()) {
    const nums = prev.vis.querySelectorAll(".odo-num");
    parts.filter((_, i) => i % 2).forEach((s, k) => rollNum(nums[k], s));
    prev.sr.textContent = text;
    return;
  }
  const sr = el("span", "sr-only", text);
  const vis = el("span", "odo-text");
  vis.setAttribute("aria-hidden", "true");
  vis.append(...parts.map((s, i) => {
    if (i % 2 === 0) return document.createTextNode(s);
    const n = el("span", "odo-num");
    n._v = s;
    n.append(...[...s].map(slotOf));
    return n;
  }).filter((n) => n.nodeType !== 3 || n.data));
  host.replaceChildren(sr, vis);
  host._roll = { sr, vis, shape };
}

/* 按钮自己当确认（借自 Bencho 的 Notify）：两段文字叠在同一格，切换时旧文字上滑、新文字从底部滑入 */
export function confirmable(btn, doneText, withCheck) {
  const lbl = el("span", "lbl", btn.textContent);
  const alt = el("span", "lbl lbl-alt");
  alt.setAttribute("aria-hidden", "true");
  if (withCheck) alt.append(checkIcon());
  alt.append(doneText);
  btn.classList.add("swap");
  btn.replaceChildren(lbl, alt);
  let t = 0;
  const off = () => { clearTimeout(t); btn.removeAttribute("data-done"); btn.removeAttribute("aria-label"); };
  return {
    on(ms) {
      clearTimeout(t);
      btn.setAttribute("data-done", "");
      btn.setAttribute("aria-label", doneText);
      t = setTimeout(off, ms);
    },
    off,
  };
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = Object.assign(document.createElement("textarea"), { value: text });
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  return ok;
}
