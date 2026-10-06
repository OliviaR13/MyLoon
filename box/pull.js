/* 下拉刷新 × 灵动岛（思路借自 Bencho 的 Pull to refresh · Balance 和 Dynamic Island，已改写为原生 JS + CSS）
   不再单独画一个圆形指示器，而是接管 app.js 里的提示条药丸（#toast），让「下拉 → 刷新 → 结果」是同一个对象：
   - 手指在页面顶部往下拉：页面内容跟着往下走，药丸悬在露出的空隙里，宽、高、圆角随拉动一起长大；
   - 药丸里是五个独立的圆点，从中心向外散开成环；拉过阈值，环完整、药丸变强调色，同时轻震一下；
   - 决定发生在「距离」上而不是松手时：药丸变色就是「已就绪」，此时手还没松，你就知道松手会刷新；
   - 橡皮筋：位移曲线是饱和的，越往后越费劲；手指在时尺寸跟手（无过渡），弹簧只用于回家的路；
   - 松手后同一组圆点接着转成 Windows 11 风格的五点转圈；load() 结束时会调用 toast("清单已刷新")，药丸就地变形成消息，不用先消失再出现；
     消息读完，药丸和页面一起收回去。
   刷新中 / 「清单已刷新」还在显示的这段时间里，再往下拉不会开始新一轮，但手势也不会交还给系统：
   否则 Safari 自己的回弹 / 下拉刷新会趁机接管，页面和药丸一起抖。这段时间的下拉直接吞掉（swallow）。
   只响应触屏；桌面端仍用页头的「刷新」按钮。
   依赖 app.js 中的全局：els、load、toastHold、toastPopover、toastSize、hideToast。 */
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const SIZE = 28, C = SIZE / 2;
  const ORBS = 5, ORB_R = 1.9;          // 圆点数量与半径（拉动和刷新中用同一组点）
  const RING = 8;                       // 圆环半径
  const R_START = 0.9;                  // 刚开始拉时圆点的半径
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
  // 五个独立的圆点（不再套「黏稠」滤镜，点与点之间始终是分开的）。
  // 拉动时由 draw() 逐个摆位；松手进入刷新后，由 CSS 的 .toast.working .orb 接手，播放 Windows 11 风格的转圈
  const orbit = mk("g", { class: "pull-orbit" });
  const orbs = Array.from({ length: ORBS }, (_, i) => {
    const o = mk("g", { class: "orb", style: `--i:${i}` });
    const c = o.appendChild(mk("circle", { cx: C, cy: C, r: R_START }));
    orbit.append(o);
    return { o, c };
  });
  svg.append(orbit);
  const label = document.createElement("span");
  label.className = "toast-pull-label";
  label.textContent = TEXT.idle;
  layer.append(svg, label);
  box.append(layer);

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // p：0..1，圆点从中心散开成圆环的程度；turn：整圈的旋转角度（拉的时候随距离转一点，让它有生命）
  function draw(p, turn = 0) {
    const out = 1 - (1 - p) * (1 - p); // 先快后慢地散开
    orbs.forEach(({ o, c }, i) => {
      o.style.transform = `rotate(${(turn + i * (360 / ORBS)).toFixed(1)}deg)`;
      c.setAttribute("cy", (C - RING * out).toFixed(2));
      c.setAttribute("r", lerp(R_START, ORB_R, out).toFixed(2));
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

  let startX = 0, startY = 0, tracking = false, dragging = false, armed = false, busy = false, popTimer = 0, swallow = false, lockH = false;

  // 「在顶部」留 2px 的余量：iOS 上惯性滚动停下来时 scrollY 常常是 0.3 这样的小数，严格 > 0 会误判成「还没到顶」，
  // 手势就整个交给了系统
  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 2;
  // 键盘弹着（搜索框有焦点）时，下拉是用来收键盘 / 选文字的，不归我们管
  const typing = () => { const a = document.activeElement; return !!a && a.matches("input, textarea"); };
  // 这些地方的手势不归我们管：菜单、对话框、正在输入。
  // 搜索框、分类条不再整个排除——页头下面一大片就是它们，从那里起手的下拉也是下拉；分类条横向可滚，靠方向判断（见 touchmove）
  const excluded = (e) => e.target.closest("dialog, .sort-menu") || document.querySelector("dialog[open]") || typing();
  const blocked = (e) => busy || !atTop() || !els.list || els.refresh.disabled || excluded(e);
  // 正在刷新（含结果还在显示）：不开始新的下拉，但要把「往下拉」这个手势接住，别让系统趁机接管
  const shouldSwallow = (e) => (busy || els.refresh.disabled) && atTop() && els.list && !excluded(e);

  // 第一次真正往下拉时才接管药丸（此前它可能正显示着别的提示）
  function begin() {
    dragging = true;
    toastHold();
    box.style.opacity = "0";
    box.classList.remove("open", "armed", "working", "pop", "leaving");
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
    swallow = false;
    if (tracking) release(false); // 上一次触摸没有等到 touchend（被系统手势打断之类）：先收拾干净，否则 tracking 会一直卡着，之后每次下拉都被拦下
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY;
    lockH = !!e.target.closest(".filters"); // 分类条能横向滑：起手在它上面时要看方向
    if (shouldSwallow(e)) { swallow = true; return; }
    if (blocked(e)) return;
    tracking = true; armed = false; dragging = false;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (swallow) { // 刷新中的下拉：吞掉，不让系统接管；往上推或页面已滚动则照常放行
      if (e.cancelable && atTop() && e.touches[0].clientY - startY > 0) e.preventDefault();
      return;
    }
    if (!tracking) return;
    const t = e.touches[0];
    const raw = t.clientY - startY;
    if (!atTop()) { if (dragging) release(false); return; } // 页面已经滚动了：交还给浏览器
    if (!dragging) {
      if (raw <= 0) return; // 还没往下拉（或在往上推）：先不管，浏览器照常滚
      if (lockH && Math.abs(t.clientX - startX) > raw) { tracking = false; return; } // 在分类条上横着划：交给它
    }
    // 一旦接管就接管到底：手指回到起点以上时只是拉动量归零，不把手势还给系统
    // （还回去的话，同一次触摸里再往下拉，就是系统的回弹 / 下拉刷新在动）
    if (e.cancelable) e.preventDefault();
    if (!dragging) begin();
    const pull = Math.max(0, raw);
    const drawn = (RESISTANCE * pull) / (RESISTANCE + pull); // 饱和曲线：前 20px 比后 20px 便宜
    const p = clamp(drawn / THRESHOLD, 0, 1);
    draw(p, pull * 0.6);
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
      // load 最多等 15 秒：网络一直不回的话，busy 永远不放，之后每次下拉都被吞掉
      try { await Promise.race([load(true), new Promise((r) => setTimeout(r, 15000))]); } catch {}
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
  document.addEventListener("touchend", () => { swallow = false; if (tracking) release(true); }, { passive: true });
  document.addEventListener("touchcancel", () => { swallow = false; if (tracking) release(false); }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden && tracking) release(false); });
  draw(0);
})();
