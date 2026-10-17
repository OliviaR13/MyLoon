/* 会看着你的小方块（移植自 Bencho 的 Eye tracker，MIT 许可，bencho.dev/licence；原版是 React，这里改成原生 JS）。
   一个带两只眼睛的方块，眼睛跟着指针走；戳它一下，它会在右下角冒出一个对话气泡，一个字一个字打出一句话。

   ── 眼睛长在球面上，而不是贴在球前面 ──────────────────
   最容易的做法是把两个形状朝指针平移，看上去像贴在圆盘上的贴纸。这里每只眼睛是球面上的一个点：
   往左看是球转了，所以眼睛沿曲线走；往边缘去的那只移得少、并且随着转离你而变窄，另一只则荡得更远。
   这种透视收缩是全部的诀窍——它让一个平的圆读成立体的。
   状态只有一个「转向」（偏航和俯仰），弹簧朝指针的方向追；两只眼睛都从它算出来，所以永远不会各看各的。
   指针离开窗口后它慢慢回到正对你，并且时不时自己眨眼。每帧直接写 DOM，不经过状态：指针移动不是一次渲染。

   和原版不同的地方：
   · 只保留「方块」这一种身体（原版有球、方块、药丸、六边形之间的形变，本站用不上）；
   · 只在看得见的时候跑循环（IntersectionObserver）——设置面板关着、被滚出屏幕时不耗电；
   · 手指也算指针：触屏上按下和拖动时看向手指，抬起约 1.2 秒后回到正前方；
   · 颜色映射到本站的强调色（身体 --accent，眼睛 --accent-ink），台词换成了中文。 */

const NS = "http://www.w3.org/2000/svg";
const R = 50;
const EYE = { w: 9, h: 15, r: 4.5 };
const GAP = 0.19;
const TILT = 64;
const BODY = "M30 6 H70 A24 24 0 0 1 94 30 V70 A24 24 0 0 1 70 94 H30 A24 24 0 0 1 6 70 V30 A24 24 0 0 1 30 6 Z";
const LINES = ["嘿，我看见你了。", "戳。", "好痒～", "你好呀！", "别戳我啦。", "我在盯着你。", "又来？好吧。", "被你发现了。"];
const TINTS = ["#3b5bff", "#179c52", "#e0307f"];
const KEY_MS = 38;
const HOLD_MS = 1500;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const still = () =>
  document.documentElement.hasAttribute("data-reduce-motion") ||
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
let uid = 0;

const mk = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/* host：放它的元素；size 边长 px；say "right" | "left" 是气泡出现在哪一侧（靠右放时选 left，免得被容器裁掉）；
   eyeScale 眼睛相对身体的大小——小图标要眼睛更大才看得清。返回 { el, destroy }。 */
export function createWatcher(host, { size = 56, say = "right", eyeScale = 1.2 } = {}) {
  const id = ++uid;
  const root = document.createElement("div");
  root.className = "eyt";
  root.dataset.say = say;
  root.style.setProperty("--eyt-size", size + "px");
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", "一个会跟着指针转动视线的小方块，点一下它会说话");

  const svg = mk("svg", { class: "eyt-ball", viewBox: "0 0 100 100" });
  svg.dataset.poke = "true";
  const clipId = `eyt-clip-${id}`;
  const glossId = `eyt-gloss-${id}`;
  const defs = mk("defs");
  const clip = mk("clipPath", { id: clipId });
  clip.append(mk("path", { d: BODY }));
  const grad = mk("linearGradient", { id: glossId, x1: "0", y1: "0", x2: "1", y2: "1" });
  grad.append(
    mk("stop", { offset: "0", "stop-color": "#fff", "stop-opacity": ".55" }),
    mk("stop", { offset: ".5", "stop-color": "#fff", "stop-opacity": ".05" }),
    mk("stop", { offset: "1", "stop-color": "#fff", "stop-opacity": ".22" })
  );
  defs.append(clip, grad);
  const body = mk("path", { class: "eyt-body", d: BODY });
  const gloss = mk("path", { d: BODY, fill: `url(#${glossId})` });
  gloss.style.pointerEvents = "none";
  const clipped = mk("g", { "clip-path": `url(#${clipId})` });
  const eyes = [0, 1].map(() => {
    const g = mk("g");
    g.append(mk("rect", { class: "eyt-eye" }));
    clipped.append(g);
    return g;
  });
  svg.append(defs, body, clipped, gloss);

  const bubble = document.createElement("span");
  bubble.className = "eyt-say";
  bubble.setAttribute("aria-live", "polite");
  const typedEl = document.createElement("span");
  const caret = document.createElement("span");
  caret.className = "eyt-caret";
  bubble.append(typedEl, caret);
  root.append(svg, bubble);
  host.append(root);

  /* ── 戳它：开一个气泡，一个字一个字打出一句话，停一会儿再收起；不会连着两次同一句 ── */
  let turn = 0;
  let last = -1;
  svg.addEventListener("click", async () => {
    const mine = ++turn;
    const pool = LINES.map((_, i) => i).filter((i) => i !== last);
    last = pool[Math.floor(Math.random() * pool.length)];
    const line = LINES[last];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    bubble.style.setProperty("--tint", TINTS[Math.floor(Math.random() * TINTS.length)]);
    typedEl.textContent = "";
    bubble.dataset.on = "true";
    const chars = [...line];
    for (let k = 1; k <= chars.length; k++) {
      await wait(still() ? 0 : KEY_MS + Math.random() * 30);
      if (mine !== turn) return;
      typedEl.textContent = chars.slice(0, k).join("");
    }
    await wait(HOLD_MS);
    if (mine !== turn) return;
    delete bubble.dataset.on;
  });

  /* ── 一个循环：弹簧追着指针，每帧把两只眼睛读出来 ── */
  const t = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 };
  let raf = 0;
  let prev = 0;
  let blink = 0;
  let nextBlink = performance.now() + 2200;
  let visible = false;
  let alive = true;

  function draw(now) {
    /* 眨眼：160ms 一下一上，每只眼睛压扁 */
    let lid = 1;
    if (now > nextBlink) {
      blink = now;
      nextBlink = now + 2600 + Math.random() * 3200;
    }
    const since = now - blink;
    if (since < 160 && !still()) lid = 1 - 0.9 * Math.sin((since / 160) * Math.PI);

    /* 把球的正面转到脸所在的位置：绕竖轴偏航、绕横轴俯仰 */
    const as = (v) => Math.asin(clamp(v, -0.92, 0.92));
    const yaw = as(t.x);
    const pitch = -as(t.y);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    /* 斜着看时这一对会倾斜，在轴线上看时是平的 */
    const tilt = TILT * t.x * t.y;
    const g0 = GAP * Math.max(1, eyeScale * 0.8);

    [-g0, g0].forEach((x0, i) => {
      const g = eyes[i];
      /* 单位球面上正前方两侧的一个点，跟着球转 */
      const z0 = Math.sqrt(1 - x0 * x0);
      const x1 = x0 * cy + z0 * sy;
      const z1 = -x0 * sy + z0 * cy;
      const y2 = -z1 * sp;
      const z2 = z1 * cp;
      /* 深度：靠近边缘的那只离你更远，整体更小、沿转动方向更窄 */
      const near = clamp(z2, 0, 1);
      const k = 0.45 + 0.55 * near;
      const sx = k * (0.7 + 0.3 * near);
      /* 尺寸直接写成宽和高，不用 scale：scale 会把圆角一起拉成椭圆，直接写宽高每个角的半径才一样，并且不超过边长的一半 */
      const w = EYE.w * eyeScale * sx;
      const h = Math.max(0.6, EYE.h * eyeScale * k * lid);
      const rect = g.firstChild;
      rect.setAttribute("x", (-w / 2).toFixed(2));
      rect.setAttribute("y", (-h / 2).toFixed(2));
      rect.setAttribute("width", w.toFixed(2));
      rect.setAttribute("height", h.toFixed(2));
      rect.setAttribute("rx", Math.min(EYE.r * eyeScale, w / 2, h / 2).toFixed(2));
      g.setAttribute("transform", `translate(${(50 + x1 * R).toFixed(2)} ${(50 + y2 * R).toFixed(2)}) rotate(${tilt.toFixed(2)})`);
      g.style.opacity = z2 < 0.05 ? "0" : "1";
    });
  }

  function tick(now) {
    if (!alive || !root.isConnected) { destroy(); return; }
    if (!visible) { raf = 0; return; }
    const dt = prev ? Math.min(2.5, (now - prev) / 16.67) : 1;
    prev = now;
    if (still()) { t.x = t.tx; t.y = t.ty; t.vx = t.vy = 0; }
    else {
      /* 两个轴共用一根弹簧，阻尼 0.34 - 30% * 0.22 */
      const k = 0.06, d = 0.274;
      t.vx += ((t.tx - t.x) * k - t.vx * d) * dt;
      t.vy += ((t.ty - t.y) * k - t.vy * d) * dt;
      t.x += t.vx * dt;
      t.y += t.vy * dt;
    }
    draw(now);
    raf = requestAnimationFrame(tick);
  }
  const start = () => { if (!raf && alive) { prev = 0; raf = requestAnimationFrame(tick); } };

  /* ── 脸朝你所在的位置转：沿指针方向的一个点，离得越远越靠边；就在它上面时脸在正中 ── */
  let relax = 0;
  const aim = (e) => {
    clearTimeout(relax);
    const r = root.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1;
    const reach = Math.max(90, Math.min(innerWidth, innerHeight) * 0.22);
    const far = Math.min(0.85, Math.tanh(d / reach) * 0.6 * 1.5);
    t.tx = (dx / d) * far;
    t.ty = (dy / d) * far;
  };
  const rest = () => { t.tx = 0; t.ty = 0; };
  /* 手指抬起、鼠标移出页面之后，隔一会儿再回正：手指一抬就立刻回正会显得在躲你 */
  const later = (e) => { clearTimeout(relax); relax = setTimeout(rest, e && e.pointerType === "touch" ? 1200 : 0); };
  window.addEventListener("pointermove", aim, { passive: true });
  window.addEventListener("pointerdown", aim, { passive: true });
  window.addEventListener("pointerup", later, { passive: true });
  window.addEventListener("pointercancel", later, { passive: true });
  document.documentElement.addEventListener("pointerleave", rest);

  const io = "IntersectionObserver" in window
    ? new IntersectionObserver(([en]) => {
      /* 它所在的节点被换掉了（空状态每次渲染都会重建）：收拾干净，别留着监听器 */
      if (!root.isConnected) { destroy(); return; }
      visible = en.isIntersecting;
      if (visible) start();
    })
    : null;
  if (io) io.observe(root); else { visible = true; start(); }
  draw(performance.now());

  function destroy() {
    alive = false;
    cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(relax);
    turn++;
    io?.disconnect();
    window.removeEventListener("pointermove", aim);
    window.removeEventListener("pointerdown", aim);
    window.removeEventListener("pointerup", later);
    window.removeEventListener("pointercancel", later);
    document.documentElement.removeEventListener("pointerleave", rest);
  }
  return { el: root, destroy };
}
