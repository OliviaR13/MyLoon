/* 人机验证的等待态（移植自 Bencho 的 One-time code，MIT 许可，bencho.dev/licence；原版是 React，这里改成原生 JS）。
   本站没有要输入的验证码，所以只取它「核对中 → 通过」的那一半：四个小格子在等待时依次轻轻呼吸；
   验证通过后，格子向中间靠拢，同时从同一个点长出一颗胶囊，靠近的时候滤镜把它们连成一个形状，最后只剩一颗写着「已通过」的胶囊。

   ── 融合是滤镜的事 ────────────────────────────────
   格子在 blur + 阈值滤镜下，彼此隔得足够远所以平时不会被桥接。验证通过时它们滑向中间，
   胶囊也从中间长出来：靠得足够近时滤镜把它们接成一个形状——没人画过中间那一段，是滤镜决定两样东西近到什么程度算一个。
   所以文字绝不能放在这层滤镜下面：字形的抗锯齿全在 0.5 透明度以下，会被阈值切掉。文字单独叠在上面。

   ── 融合是弹簧，不是补间 ──────────────────────────
   略低于临界阻尼的弹簧会让胶囊冲过自己的尺寸再回来：冲出去时又长又薄，落定时变圆，
   这才像液体，而不是方块滑过去。每帧按 60Hz 计，由刚度和阻尼比推出。
   循环只在弹簧还在动时运行，停了就自己停。 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => {
  const u = clamp((v - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};

const still = () =>
  document.documentElement.hasAttribute("data-reduce-motion") ||
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* 一个格子、格子之间的空气、通过后的胶囊。原版是 36x44，这里是等待态的一个小指示，所以整体缩小；
   空隙不能缩得太多：滤镜的桥接距离由模糊半径决定，间隔必须大过它。 */
const N = 4;
const W = 26;
const H = 32;
const G = 8;
const CAP = 108;
const R = 10;
const ROW_W = N * W + (N - 1) * G;
const MERGE = (() => {
  const k = 0.075;
  const zeta = 0.42;
  return { k, d: 1 - 2 * zeta * Math.sqrt(k) };
})();

const NS = "http://www.w3.org/2000/svg";
let uid = 0;

export function createVerifyCells(label = "已通过") {
  const id = `otp-goo-${++uid}`;
  const root = document.createElement("div");
  root.className = "otp";
  root.dataset.phase = "check";
  root.setAttribute("aria-hidden", "true");

  const row = document.createElement("div");
  row.className = "otp-row";
  row.style.width = ROW_W + "px";
  row.style.height = H + "px";

  const goo = document.createElement("div");
  goo.className = "otp-goo";
  goo.style.filter = `url(#${id})`;
  const cells = Array.from({ length: N }, (_, i) => {
    const c = document.createElement("span");
    c.className = "otp-cell";
    c.style.setProperty("--i", i);
    c.style.width = W + "px";
    c.style.borderRadius = R + "px";
    c.style.translate = `${i * (W + G)}px 0`;
    goo.append(c);
    return c;
  });
  const cap = document.createElement("span");
  cap.className = "otp-cell otp-cap";
  cap.style.display = "none";
  goo.append(cap);

  /* 文字在滤镜外面 */
  const ok = document.createElement("span");
  ok.className = "otp-ok";
  ok.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  ok.append(document.createTextNode(label));
  row.append(goo, ok);

  /* defs 里什么也看不见；没有尺寸的 <svg> 是 300x150 的替换元素，会占位，所以移出文档流（见 cards.css 的 .otp-defs） */
  const defs = document.createElementNS(NS, "svg");
  defs.setAttribute("class", "otp-defs");
  defs.setAttribute("aria-hidden", "true");
  defs.setAttribute("focusable", "false");
  defs.innerHTML =
    `<defs><filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">` +
    '<feGaussianBlur in="SourceGraphic" stdDeviation="3" result="smear"/>' +
    '<feColorMatrix in="smear" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -12"/>' +
    "</filter></defs>";
  root.append(row, defs);

  const merge = { m: 0, v: 0, to: 0 };
  let raf = 0;
  let passed = null;

  function draw() {
    const rawM = merge.m;
    const m = clamp(rawM, 0, 1);
    const mid = (ROW_W - W) / 2;
    /* 弹簧会冲过 0 和 1：格子的行程夹在里面，只有胶囊允许把冲过的部分当作拉伸 */
    cells.forEach((c, i) => {
      c.style.translate = `${mix(i * (W + G), mid, m).toFixed(2)}px 0`;
      /* 格子在靠拢时圆成胶囊的形状，和胶囊对得上，滤镜接它们时两个形状才一致 */
      c.style.borderRadius = mix(R, H / 2, smooth(0.15, 0.7, m)).toFixed(2) + "px";
    });
    const over = rawM - 1;
    const capW = CAP * smooth(0.3, 1, m) * (1 + Math.max(-0.12, over) * 0.9);
    const capSy = 1 - Math.max(-0.12, over) * 0.55;
    if (capW > 0.5) {
      cap.style.display = "";
      cap.style.width = capW.toFixed(2) + "px";
      cap.style.borderRadius = H / 2 + "px";
      cap.style.translate = `${((ROW_W - capW) / 2).toFixed(2)}px 0`;
      cap.style.scale = `1 ${capSy.toFixed(3)}`;
    } else {
      cap.style.display = "none";
    }
    /* 颜色整体一起从灰变成强调色——所有形状始终同色，阈值才不会把两种颜色涂在一起 */
    goo.style.setProperty("--otp-mix", (smooth(0, 0.6, m) * 100).toFixed(1) + "%");
    const t = smooth(0.72, 1, m);
    ok.style.opacity = t.toFixed(3);
    ok.style.scale = mix(0.92, 1, t).toFixed(3);
  }

  function run() {
    if (raf) return;
    let prev = 0;
    const tick = (t) => {
      const dt = prev ? clamp((t - prev) / 16.67, 0, 2.5) : 1;
      prev = t;
      if (still()) { merge.m = merge.to; merge.v = 0; }
      else {
        merge.v += (merge.to - merge.m) * MERGE.k * dt;
        merge.v *= Math.pow(MERGE.d, dt);
        merge.m += merge.v * dt;
      }
      const settled = Math.abs(merge.to - merge.m) < 0.0008 && Math.abs(merge.v) < 0.0008;
      if (settled) { merge.m = merge.to; merge.v = 0; }
      draw();
      raf = settled ? 0 : requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  draw();

  return {
    el: root,
    /* 验证通过：格子融合成胶囊。幂等；返回的 Promise 在胶囊基本落定后 resolve（给后面的流程留出看到它的时间） */
    pass() {
      if (passed) return passed;
      root.dataset.phase = "ok";
      merge.to = 1;
      run();
      passed = new Promise((resolve) => setTimeout(resolve, still() ? 0 : 620));
      return passed;
    },
    get done() { return passed || Promise.resolve(); },
    destroy() { cancelAnimationFrame(raf); raf = 0; },
  };
}
