/* 下拉刷新（思路借自 Bencho 的 Pull to refresh · Balance，重新设计过）
   手指在页面顶部往下拉：页面内容跟着手指往下走，在顶部露出的空隙里长出一圈水滴。
   - 指示器始终在可视区域内：它不是从屏幕上方滑进来的，而是固定在顶部、随空隙变大而放大，
     所以不会被系统的状态栏 / 浏览器顶栏切掉；
   - 水滴从中心向外散开成一圈，带渐细的尾巴；拉过阈值，这一圈就完整了（同时轻震一下）；
   - 决定发生在「距离」上，而不是松手时：圈完整了就是「已就绪」，此时手还没松，你就知道松手会刷新；
   - 橡皮筋：位移曲线是饱和的，越往后越费劲，感受到的是阻力而不是距离；
   - 手指在时跟手（无过渡），弹簧只用于回家的路；刷新期间整圈旋转，结束后收回。
   水滴画在 SVG 里，并在 SVG 内部套 goo 滤镜（模糊 + 提高 alpha 对比度），相邻的水滴会连成一条拖尾，Safari 也能正常渲染。
   只响应触屏；桌面端仍用页头的「刷新」按钮。依赖 app.js 中的全局：els、load。 */
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const SIZE = 44, C = SIZE / 2;
  const DROPS = 8, RING = 11;          // 水滴数量、圆环半径
  const R_HEAD = 4.2, R_STEP = 0.25;   // 头部水滴的半径，以及每往后一颗缩小多少（渐细的尾巴）
  const R_START = 2.6;                 // 刚开始拉时每颗水滴的半径
  const THRESHOLD = 64;                // 位移（经过橡皮筋曲线后）达到这个值就算「就绪」，大约要真实拉 80px
  const RESISTANCE = 340;              // 橡皮筋的软硬：位移的上限，越大越接近跟手
  const MAX_SHIFT = 80;                // 页面内容最多被拉下去多少
  const HOLD = 56;                     // 刷新期间页面停在多低的位置（要装得下 44px 的指示器）

  const mk = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const shell = document.querySelector(".shell");
  const box = document.createElement("div");
  box.className = "pull";
  box.setAttribute("aria-hidden", "true");
  const svg = mk("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, width: SIZE, height: SIZE });
  const defs = mk("defs");
  const filter = mk("filter", { id: "pull-goo", x: "-50%", y: "-50%", width: "200%", height: "200%", "color-interpolation-filters": "sRGB" });
  filter.append(
    mk("feGaussianBlur", { in: "SourceGraphic", stdDeviation: "2", result: "smear" }),
    mk("feColorMatrix", { in: "smear", type: "matrix", values: "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9" })
  );
  defs.append(filter);
  const goo = mk("g", { filter: "url(#pull-goo)" });
  const ring = mk("g", { class: "pull-ring" });
  const drops = Array.from({ length: DROPS }, () => ring.appendChild(mk("circle", { r: R_START })));
  goo.append(ring);
  svg.append(defs, goo);
  box.append(svg);
  document.body.append(box);

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // p：0..1，水滴散开成圆环的程度；turn：整圈的旋转角度（拉的时候随距离转一点，让它有生命）
  function draw(p, turn = 0) {
    const out = 1 - (1 - p) * (1 - p); // 先快后慢地散开
    drops.forEach((d, i) => {
      const a = (turn - 90 - i * (360 / DROPS)) * (Math.PI / 180); // 尾巴排在行进方向的后面
      const dist = RING * out;
      d.setAttribute("cx", (C + Math.cos(a) * dist).toFixed(2));
      d.setAttribute("cy", (C + Math.sin(a) * dist).toFixed(2));
      d.setAttribute("r", lerp(R_START, R_HEAD - i * R_STEP, out).toFixed(2));
    });
  }

  // 指示器固定在视口内，只做放大和淡入；空隙还没露出来之前（drawn 很小）完全透明，不会盖住页头
  function place(drawn) {
    const t = clamp((drawn - 8) / 22, 0, 1);
    box.style.opacity = String(t);
    box.style.setProperty("--ps", String(0.5 + 0.5 * t));
  }
  // 页面内容跟着往下走；shift 为 0 时彻底撤掉 transform，避免一直留着一个多余的层
  let settleTimer = 0;
  function shiftShell(y, { animate }) {
    if (!shell) return;
    clearTimeout(settleTimer);
    shell.classList.toggle("pull-drag", !animate);
    shell.classList.toggle("pull-anim", animate);
    shell.style.transform = `translateY(${y.toFixed(1)}px)`;
    if (animate && y === 0) {
      settleTimer = setTimeout(() => { shell.style.transform = ""; shell.classList.remove("pull-anim"); }, 520);
    }
  }

  let startY = 0, tracking = false, armed = false, busy = false;

  const blocked = (e) =>
    busy || tracking || window.scrollY > 0 || !els.list || els.refresh.disabled ||
    e.target.closest("dialog, input, textarea, .sort-menu, .filters") || document.querySelector("dialog[open]");

  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || blocked(e)) return;
    tracking = true; armed = false;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!tracking) return;
    const raw = e.touches[0].clientY - startY;
    if (raw <= 0 || window.scrollY > 0) { // 往上推，或者页面已经滚动了：交还给浏览器
      if (box.classList.contains("dragging")) release(false);
      return;
    }
    if (e.cancelable) e.preventDefault(); // 接管：不让浏览器自己的下拉刷新 / 回弹抢手势
    box.classList.add("dragging");
    const drawn = (RESISTANCE * raw) / (RESISTANCE + raw); // 饱和曲线：前 20px 比后 20px 便宜
    const p = clamp(drawn / THRESHOLD, 0, 1);
    draw(p, raw * 0.6);
    place(drawn);
    shiftShell(Math.min(drawn, MAX_SHIFT), { animate: false });
    const nowArmed = p >= 1;
    if (nowArmed !== armed) { // 过阈值的那一刻：圈完整了，轻震一下
      armed = nowArmed;
      box.dataset.armed = String(armed);
      if (armed && navigator.vibrate) navigator.vibrate(8);
    }
  }, { passive: false });

  async function release(commit) {
    tracking = false;
    box.classList.remove("dragging");
    if (commit && armed) {
      busy = true;
      box.dataset.phase = "work";
      place(THRESHOLD);
      shiftShell(HOLD, { animate: true }); // 页面停在指示器下面，整圈旋转
      try { await load(true); } catch {}
      box.dataset.phase = "";
      busy = false;
    }
    armed = false;
    box.dataset.armed = "false";
    shiftShell(0, { animate: true }); // 弹簧回家
    place(0);
    setTimeout(() => draw(0), 450);   // 回到原位后再收拢，下次拉的时候从中心开始
  }
  document.addEventListener("touchend", () => { if (tracking) release(true); }, { passive: true });
  document.addEventListener("touchcancel", () => { if (tracking) release(false); }, { passive: true });

  draw(0);
  place(0);
})();
