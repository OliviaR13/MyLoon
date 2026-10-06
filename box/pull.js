/* 下拉刷新 × 灵动岛（思路借自 Bencho 的 Pull to refresh · Balance 和 Dynamic Island，已改写为原生 JS + CSS）
   不再单独画一个圆形指示器，而是接管 app.js 里的提示条药丸（#toast），让「下拉 → 刷新 → 结果」是同一个对象：
   - 手指在页面顶部往下拉：页面内容跟着往下走，药丸悬在露出的空隙里，宽、高、圆角随拉动一起长大；
   - 药丸里是一圈水滴（SVG goo），从中心向外散开成环；拉过阈值，环完整、药丸变强调色，同时轻震一下；
   - 决定发生在「距离」上而不是松手时：药丸变色就是「已就绪」，此时手还没松，你就知道松手会刷新；
   - 橡皮筋：位移曲线是饱和的，越往后越费劲；手指在时尺寸跟手（无过渡），弹簧只用于回家的路；
   - 松手后整圈旋转；load() 结束时会调用 toast("清单已刷新")，药丸就地变形成消息，不用先消失再出现；
     消息读完，药丸和页面一起收回去。
   只响应触屏；桌面端仍用页头的「刷新」按钮。
   依赖 app.js 中的全局：els、load、toastHold、toastPopover、toastSize、hideToast。 */
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const SIZE = 28, C = SIZE / 2;
  const DROPS = 8, RING = 7.5;          // 水滴数量、圆环半径
  const R_HEAD = 3, R_STEP = 0.2;       // 头部水滴半径，以及每往后一颗缩小多少（渐细的尾巴）
  const R_START = 1.7;                  // 刚开始拉时每颗水滴的半径
  const THRESHOLD = 64;                 // 位移（经过橡皮筋曲线后）达到这个值就算「就绪」，大约要真实拉 80px
  const RESISTANCE = 340;               // 橡皮筋的软硬：位移的上限，越大越接近跟手
  const MAX_SHIFT = 80;                 // 页面内容最多被拉下去多少
  const HOLD = 56;                      // 刷新期间页面停在多低的位置（药丸 10px + 40px 高，要装得下）
  const PILL = { w0: 36, h0: 30, w1: 128, h1: 40 }; // 药丸：刚露头 → 就绪
  const WORK = { w: 124, h: 38 };       // 刷新中药丸收成的大小
  const RESULT_HOLD = 1300;             // 刷新完成后「清单已刷新」停留多久（页面同时停在空隙下面）
  const TEXT = { idle: "下拉刷新", armed: "松手刷新", work: "正在刷新" };

  const mk = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const shell = document.querySelector(".shell");
  const box = els.toast;
  if (!box) return;

  // 在药丸里加一层「下拉」内容：水滴环 + 标签。和消息层 .toast-in 互相淡入淡出
  const layer = document.createElement("div");
  layer.className = "toast-pull";
  layer.setAttribute("aria-hidden", "true");
  const svg = mk("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, width: SIZE, height: SIZE });
  const filter = mk("filter", { id: "pull-goo", x: "-50%", y: "-50%", width: "200%", height: "200%", "color-interpolation-filters": "sRGB" });
  filter.append(
    mk("feGaussianBlur", { in: "SourceGraphic", stdDeviation: "1.3", result: "smear" }),
    mk("feColorMatrix", { in: "smear", type: "matrix", values: "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -9" })
  );
  const defs = mk("defs");
  defs.append(filter);
  const goo = mk("g", { filter: "url(#pull-goo)" });
  const ring = mk("g", { class: "pull-ring" });
  const drops = Array.from({ length: DROPS }, () => ring.appendChild(mk("circle", { r: R_START })));
  goo.append(ring);
  svg.append(defs, goo);
  const label = document.createElement("span");
  label.className = "toast-pull-label";
  label.textContent = TEXT.idle;
  layer.append(svg, label);
  box.append(layer);

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

  // 药丸的大小跟着 p 走；标签等药丸够宽了才展开（--lt：0..1）
  function pill(p, drawn) {
    const e = 1 - (1 - p) * (1 - p);
    const h = lerp(PILL.h0, PILL.h1, e);
    toastSize(lerp(PILL.w0, PILL.w1, e), h, h / 2);
    box.style.setProperty("--lt", clamp((p - 0.45) / 0.4, 0, 1).toFixed(3));
    // 空隙还没露出来之前完全透明，不会盖住页头
    box.style.opacity = String(clamp((drawn - 8) / 22, 0, 1));
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

  let startY = 0, tracking = false, dragging = false, armed = false, busy = false, popTimer = 0;

  const blocked = (e) =>
    busy || tracking || window.scrollY > 0 || !els.list || els.refresh.disabled ||
    e.target.closest("dialog, input, textarea, .sort-menu, .filters") || document.querySelector("dialog[open]");

  // 第一次真正往下拉时才接管药丸（此前它可能正显示着别的提示）
  function begin() {
    dragging = true;
    toastHold();
    box.style.opacity = "0";
    box.classList.remove("open", "armed", "working", "pop");
    box.classList.add("dragging", "pulling", "show");
    label.textContent = TEXT.idle;
    draw(0);
    pill(0, 0);
    toastPopover(true);
  }

  function pop() { // 过阈值那一下，内容弹一下
    clearTimeout(popTimer);
    box.classList.remove("pop");
    void box.offsetWidth;
    box.classList.add("pop");
    popTimer = setTimeout(() => box.classList.remove("pop"), 420);
  }

  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || blocked(e)) return;
    tracking = true; armed = false; dragging = false;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!tracking) return;
    const raw = e.touches[0].clientY - startY;
    if (raw <= 0 || window.scrollY > 0) { // 往上推，或者页面已经滚动了：交还给浏览器
      if (dragging) release(false);
      return;
    }
    if (e.cancelable) e.preventDefault(); // 接管：不让浏览器自己的下拉刷新 / 回弹抢手势
    if (!dragging) begin();
    const drawn = (RESISTANCE * raw) / (RESISTANCE + raw); // 饱和曲线：前 20px 比后 20px 便宜
    const p = clamp(drawn / THRESHOLD, 0, 1);
    draw(p, raw * 0.6);
    pill(p, drawn);
    shiftShell(Math.min(drawn, MAX_SHIFT), { animate: false });
    const nowArmed = p >= 1;
    if (nowArmed !== armed) { // 过阈值的那一刻：圈完整了，药丸变色，轻震一下
      armed = nowArmed;
      box.classList.toggle("armed", armed);
      label.textContent = armed ? TEXT.armed : TEXT.idle;
      if (armed) { pop(); if (navigator.vibrate) navigator.vibrate(8); }
    }
  }, { passive: false });

  async function release(commit) {
    const go = commit && armed && dragging;
    tracking = false;
    dragging = false;
    box.classList.remove("dragging"); // 回家的路交给弹簧
    if (go) {
      busy = true;
      box.style.opacity = "";           // 交还给 .show
      box.style.setProperty("--lt", "1");
      label.textContent = TEXT.work;
      box.classList.remove("armed");
      box.classList.add("working");
      toastSize(WORK.w, WORK.h, WORK.h / 2);
      shiftShell(HOLD, { animate: true }); // 页面停在药丸下面，整圈旋转
      try { await load(true); } catch {}
      if (box.classList.contains("pulling")) {
        hideToast(); // 失败：load() 没有发消息，药丸直接收起
      } else {
        // 成功：load() 已调用 toast("清单已刷新")，药丸在原地变形成消息。
        // 页面继续停在空隙下面让消息读完，然后药丸和页面一起收回去（不会盖住页头）
        await new Promise((r) => setTimeout(r, RESULT_HOLD));
        if (box.classList.contains("open")) hideToast();
      }
      busy = false;
    } else if (box.classList.contains("pulling")) { // 没拉够，或者中途收手：淡出并缩回
      box.style.opacity = "0";
      hideToast();
      setTimeout(() => { if (!tracking && !busy && !box.classList.contains("show")) box.style.opacity = ""; }, 460);
    }
    armed = false;
    shiftShell(0, { animate: true }); // 弹簧回家
    setTimeout(() => { if (!tracking && !busy) draw(0); }, 450); // 回到原位后再收拢，下次拉的时候从中心开始
  }
  document.addEventListener("touchend", () => { if (tracking) release(true); }, { passive: true });
  document.addEventListener("touchcancel", () => { if (tracking) release(false); }, { passive: true });
  draw(0);
})();
