/* 下拉刷新（思路借自 Bencho 的 Pull to refresh · Balance）
   手指在页面顶部往下拉：五颗水滴从四周聚拢，拉到阈值的那一刻融成一滴。
   决定发生在「距离」上，而不是松手时：融成一滴就是「已就绪」，此时手还没松，你就知道松手会刷新。
   - 橡皮筋：位移曲线是饱和的，越往后越费劲，感受到的是阻力而不是距离；
   - 手指在时跟手（无过渡），弹簧只用于回家的路；
   - 刷新期间整圈水滴一起旋转，刷新结束后收回。
   水滴画在 SVG 里，并在 SVG 内部套 goo 滤镜（模糊 + 提高 alpha 对比度），这样 Safari 也能正常渲染。
   只响应触屏；桌面端仍用页头的「刷新」按钮。依赖 app.js 中的全局：els、load、motionOff。 */
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const SIZE = 44, C = SIZE / 2;
  const DROPS = 5, R_DROP = 4;
  const THRESHOLD = 64;      // 位移（经过橡皮筋曲线后）达到这个值就算「就绪」，大约要真实拉 80px
  const RESISTANCE = 340;    // 橡皮筋的软硬：位移的上限，越大越接近跟手
  const SPREAD_FAR = 14, SPREAD_NEAR = 1.8; // 水滴离圆心的距离：散开 → 融合

  const mk = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // 指示器：一个圆形底座 + SVG
  const box = document.createElement("div");
  box.className = "pull";
  box.setAttribute("aria-hidden", "true");
  const svg = mk("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, width: SIZE, height: SIZE });
  const defs = mk("defs");
  const filter = mk("filter", { id: "pull-goo", x: "-50%", y: "-50%", width: "200%", height: "200%", "color-interpolation-filters": "sRGB" });
  filter.append(
    mk("feGaussianBlur", { in: "SourceGraphic", stdDeviation: "2.2", result: "smear" }),
    mk("feColorMatrix", { in: "smear", type: "matrix", values: "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9" })
  );
  defs.append(filter);
  const goo = mk("g", { filter: "url(#pull-goo)" });
  const ring = mk("g", { class: "pull-ring" });
  const drops = Array.from({ length: DROPS }, () => ring.appendChild(mk("circle", { r: R_DROP })));
  goo.append(ring);
  svg.append(defs, goo);
  box.append(svg);
  document.body.append(box);

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // p：0..1，决定水滴聚拢的程度；turn：整圈的旋转角度（拉的时候随距离转一点，让它有生命）
  function draw(p, turn = 0) {
    const spread = SPREAD_FAR - p * (SPREAD_FAR - SPREAD_NEAR);
    drops.forEach((d, i) => {
      const a = ((i / DROPS) * 360 + turn - 90) * (Math.PI / 180);
      d.setAttribute("cx", (C + Math.cos(a) * spread).toFixed(2));
      d.setAttribute("cy", (C + Math.sin(a) * spread).toFixed(2));
    });
  }
  function place(y, opacity) {
    box.style.setProperty("--py", y.toFixed(1) + "px");
    box.style.opacity = String(opacity);
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
    place(Math.min(drawn, THRESHOLD * 1.5), clamp(drawn / 24, 0, 1));
    const nowArmed = p >= 1;
    if (nowArmed !== armed) { // 过阈值的那一刻：融成一滴，轻震一下
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
      place(THRESHOLD, 1);          // 停在阈值处，整圈旋转
      try { await load(true); } catch {}
      box.dataset.phase = "";
      busy = false;
    }
    armed = false;
    box.dataset.armed = "false";
    place(0, 0);                     // 弹簧回家
    setTimeout(() => draw(0), 450);  // 回到原位后再散开，下次拉的时候从散开状态开始
  }
  document.addEventListener("touchend", () => { if (tracking) release(true); }, { passive: true });
  document.addEventListener("touchcancel", () => { if (tracking) release(false); }, { passive: true });

  draw(0);
  place(0, 0);
})();
