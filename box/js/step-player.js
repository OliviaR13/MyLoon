/* 步骤播放器（移植自 Bencho 的 Step player，MIT 许可，bencho.dev/licence；原版是 React，这里改成原生 JS）。
   用在新手引导的进度条上：一排圆点加一个播放键。当前步骤的那个点被拉成一根条，播放时条会慢慢填满，
   填满后条滑向下一个点，被它越过的点依次起一个小浪。

   ── 每个点都是一颗有左右两条边的药丸 ──────────────────
   没有「一根在点上面移动的高亮条」。每个点自己有左右两条边，当前步骤就是「槽位变宽」的那个点。
   换步骤只改两个槽位的宽度，所有边各自缓动到新槽位——条的移动、旧条收缩、中间的点被推开，都是这一件事。

   ── 浪 ───────────────────────────────────────────────
   被条越过的点按被越过的顺序站起来再落下，条落脚的那一格最后回应——像船尾的水纹，而不是石子落进池塘。
   wake 100 时整条浪都在，0 时只有落脚点旁边那一个点在动，落脚的条改成轻轻压扁一下。

   一个循环（rAF）只在有东西在动、或步骤正在填充时运行，静止时自己停下，所以暂停的播放器不耗电。 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a + (b - a) * t;

/* 系统「减少动态效果」或页面设置里的「减少动画」任一开启，都直接跳到终点 */
const still = () =>
  document.documentElement.hasAttribute("data-reduce-motion") ||
  !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/* 进出都缓动：播放键是「离开一个形状再到达另一个」，只缓和落地的曲线会在起步时卡一下 */
const SWING = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
/* 填满之后条滑向下一个点用「出」而不是「进出」：条是匀速填满的，ease-in-out 从静止起步，
   填满后的前一百多毫秒几乎不动，看上去像卡住了。ease-out 带着速度离开、在落地时才减速。 */
const easeOut = (u) => 1 - Math.pow(1 - u, 3);

/* ── 播放键是「画」出来的，不是换出来的 ──────────────────
   两个图标互换再快也是一次切换。这里暂停和播放是同样的两个四边形，差别只是八个点在哪：
   暂停是一对竖条，播放是把一对竖条的内侧边拉到中线、塌成一个点——一个沿自己轴线切开的三角形。
   形状全程连续，没有哪一帧分不清这个键是干什么的。 */
const PAUSE_L = [6, 4, 10, 4, 10, 20, 6, 20];
const PLAY_L = [6.5, 4, 13.25, 8, 13.25, 16, 6.5, 20];
const PAUSE_R = [14, 4, 18, 4, 18, 20, 14, 20];
const PLAY_R = [13.25, 8, 20, 12, 20, 12, 13.25, 16];
const quad = (a, b, t) => {
  let d = "";
  for (let i = 0; i < 8; i += 2) d += `${i ? "L" : "M"}${mix(a[i], b[i], t).toFixed(2)} ${mix(a[i + 1], b[i + 1], t).toFixed(2)}`;
  return d + "Z";
};

/* 一个点、它变成的条、以及它们之间的空隙。故意做小：太大像玩具而不像控件。 */
const DOT = 8;
const BAR = 36;
const GAP = 8;
/* 药丸槽在这一排外面的内边距；它的高度 = 点 + 两倍内边距，旁边的按钮和它等高，两颗药丸高度天然一致 */
const PAD = 12;
const H = DOT + PAD * 2;

/* 从一步滑到下一步用多久（ms）；浪比滑动晚多久开始、一个点站起来再落下用多久 */
const MOVE = 520;
const LEAD = 60;
const RISE = 300;

/* wake 旋钮：amp 是点站起来多高（高度的缩放），reach 是从落脚点往回数几个被越过的点还会回应，
   self 是落脚那根条的份额——正的是抬起，负的是压扁 */
const wakeOf = (w) => ({
  amp: mix(0.26, 0.34, w),
  reach: 1 + Math.round(w * 7),
  self: mix(-0.7, 0.3, w),
  stagger: mix(70, 55, w),
});

/* 没有定时移动可跟的边（比如减少动画刚被关掉）用的弹簧：每帧按 60Hz 算，由刚度和阻尼比推出 */
const SETTLE = (() => {
  const k = 0.16;
  const zeta = 1;
  return { k, d: 1 - 2 * zeta * Math.sqrt(k) };
})();

const layout = (n, at) => {
  const out = [];
  let x = 0;
  for (let i = 0; i < n; i++) {
    const w = i === at ? BAR : DOT;
    out.push([x, x + w]);
    x += w + GAP;
  }
  return out;
};

const NS = "http://www.w3.org/2000/svg";

/* mount 里会被塞进播放器的结构；返回的对象见文件末尾。
   steps  步数；pace 每步填满要几秒；wake 浪的范围 0..100；
   onStep(i) 在「自动前进」或「用户点了某个点」时调用；onEnd() 最后一步填满时调用。 */
export function createStepPlayer(mount, { steps = 4, pace = 7, wake = 100, label = (i, n) => `第 ${i + 1} 步，共 ${n} 步`, onStep, onEnd } = {}) {
  const n = Math.max(2, Math.round(steps));
  const wk = wakeOf(clamp(wake, 0, 100) / 100);
  const secs = Math.max(0.5, pace);

  let at = 0;
  let playing = false;
  let prog = 0;
  let raf = 0;
  let wave = null;
  const dots = [];
  const mark = { cur: 1, from: 1, to: 1, t0: 0 }; // 0 是暂停的形状，1 是播放的形状

  /* ---------- 结构 ---------- */
  const root = document.createElement("div");
  root.className = "spl";
  root.setAttribute("role", "group");
  root.dataset.playing = "false";

  const row = document.createElement("div");
  row.className = "spl-row";
  const slab = document.createElement("div");
  slab.className = "spl-slab";
  slab.style.padding = PAD + "px";
  slab.style.borderRadius = H / 2 + "px";
  const track = document.createElement("div");
  track.className = "spl-track";
  const width = layout(n, 0).at(-1)[1];
  track.style.width = width + "px";
  track.style.height = DOT + "px";
  slab.append(track);

  const tool = document.createElement("div");
  tool.className = "spl-slab spl-tool";
  tool.style.width = tool.style.height = H + "px";
  tool.style.borderRadius = H / 2 + "px";
  const go = document.createElement("button");
  go.type = "button";
  go.className = "spl-go";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("stroke-linecap", "round");
  svg.style.transformOrigin = "50% 50%";
  const pathL = document.createElementNS(NS, "path");
  const pathR = document.createElementNS(NS, "path");
  svg.append(pathL, pathR);
  go.append(svg);
  tool.append(go);
  row.append(slab, tool);
  root.append(row);
  mount.replaceChildren(root);

  const slots0 = layout(n, 0);
  for (let i = 0; i < n; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "spl-dot";
    b.setAttribute("aria-label", label(i, n));
    const ink = document.createElement("i");
    ink.className = "spl-ink";
    b.append(ink);
    b.addEventListener("click", () => pick(i));
    track.append(b);
    dots.push({ b, ink, l: { x: slots0[i][0], v: 0 }, r: { x: slots0[i][1], v: 0 }, ink01: 0 });
  }

  /* ---------- 一个循环 ---------- */
  function run() {
    if (raf) return;
    let prev = 0;
    const tick = (t) => {
      const dt = prev ? clamp((t - prev) / 16.67, 0, 2.5) : 1;
      prev = t;
      const quiet = still();
      const slots = layout(n, at);
      let busy = false;

      /* 填充，以及填满之后发生什么 */
      if (playing) {
        prog += (dt * 16.67) / (secs * 1000);
        busy = true;
        if (prog >= 1) {
          if (at < n - 1) {
            prog = 0;
            move(at + 1, false);
            onStep?.(at);
          } else {
            prog = 1;
            setPlaying(false);
            onEnd?.();
          }
        }
      }

      dots.forEach((d, i) => {
        const [tl, tr] = slots[i];
        for (const [e, target] of [[d.l, tl], [d.r, tr]]) {
          if (quiet) { e.x = target; e.v = 0; e.tw = undefined; continue; }
          if (e.tw) {
            const u = clamp((t - e.tw.t0) / MOVE, 0, 1);
            e.x = mix(e.tw.from, e.tw.to, easeOut(u));
            if (u >= 1) e.tw = undefined;
            busy = true;
            continue;
          }
          e.v += (target - e.x) * SETTLE.k * dt;
          e.v *= Math.pow(SETTLE.d, dt);
          e.x += e.v * dt;
          if (Math.abs(target - e.x) < 0.02 && Math.abs(e.v) < 0.02) { e.x = target; e.v = 0; }
          else busy = true;
        }
        /* 走过的是满墨，当前的是填充，没到的是空；向目标缓动，所以重新开始是「排空」而不是「闪一下」 */
        const want = i < at ? 1 : i === at ? prog : 0;
        const next = quiet ? want : d.ink01 + (want - d.ink01) * Math.min(1, 0.22 * dt);
        d.ink01 = Math.abs(want - next) < 0.002 ? want : next;
        if (d.ink01 !== want) busy = true;
      });

      /* 播放键的形状 */
      if (mark.cur !== mark.to) {
        if (quiet) mark.cur = mark.to;
        else {
          const u = clamp((t - mark.t0) / 300, 0, 1);
          mark.cur = mix(mark.from, mark.to, SWING(u));
          if (u >= 1) mark.cur = mark.to;
          else busy = true;
        }
      }

      const now = performance.now();
      if (wave && now - wave.t0 < LEAD + (wk.reach + 1) * wk.stagger + RISE) busy = true;
      else wave = null;

      paint(now);
      raf = busy ? requestAnimationFrame(tick) : 0;
    };
    raf = requestAnimationFrame(tick);
  }

  /* ---------- 这一帧的样子 ---------- */
  function shape(d, i, now) {
    let sy = 1;
    const w = wave;
    if (w) {
      const span = Math.abs(w.origin - w.from);
      const skip = Math.max(0, span - wk.reach);
      const lo = Math.min(w.from, w.origin);
      const hi = Math.max(w.from, w.origin);
      let delay = -1;
      let share = 1;
      if (i === w.origin) {
        delay = Math.min(span, wk.reach) * wk.stagger;
        share = wk.self;
      } else if (i >= lo && i <= hi) {
        const k = Math.abs(i - w.from);
        if (span - k <= wk.reach) delay = (k - skip) * wk.stagger;
      }
      if (delay >= 0) {
        const u = (now - w.t0 - LEAD - delay) / RISE;
        if (u > 0 && u < 1) sy = 1 + Math.sin(Math.PI * u) * wk.amp * share;
      }
    }
    return `translateX(${d.l.x.toFixed(2)}px) scaleY(${sy.toFixed(3)})`;
  }

  function paint(now) {
    dots.forEach((d, i) => {
      const w = Math.max(0, d.r.x - d.l.x);
      d.b.style.transform = shape(d, i, now);
      d.b.style.width = w + "px";
      /* 墨不会比一个点更窄，开始填充时是一个点而不是一道细缝；并在最初几个百分点里淡入，
         否则刚开始的一步会看上去已经走完了 */
      d.ink.style.width = (d.ink01 > 0.001 ? Math.max(Math.min(DOT, w), w * d.ink01) : 0) + "px";
      d.ink.style.opacity = i === at ? Math.min(1, d.ink01 * 14) : 1;
    });
    /* 软糖：两头为零、中间为一，所以全是「路上的鼓包」而不是两个状态的差——按两次回到原样。
       压扁、两半互相靠拢、整体歪几度再回正，都挂在它身上；歪的方向随方向变，所以暂停不只是播放倒放。 */
    const goo = Math.sin(clamp(mark.cur, 0, 1) * Math.PI);
    const pull = 1.6 * goo;
    const tip = (mark.to === 0 ? -9 : 9) * goo;
    svg.style.transform = `rotate(${tip}deg) scale(${1 - 0.13 * goo}, ${1 + 0.11 * goo})`;
    pathL.setAttribute("d", quad(PAUSE_L, PLAY_L, mark.cur));
    pathR.setAttribute("d", quad(PAUSE_R, PLAY_R, mark.cur));
    pathL.setAttribute("transform", `translate(${pull} 0)`);
    pathR.setAttribute("transform", `translate(${-pull} 0)`);
  }

  /* ---------- 换步骤 ----------
     每条边得到一次定时移动去新位置，浪从条离开的地方开始 */
  function move(to, fromHand) {
    if (to === at) return;
    const will = layout(n, to);
    const now = performance.now();
    if (!still()) {
      dots.forEach((d, i) => {
        d.l.tw = { from: d.l.x, to: will[i][0], t0: now };
        d.r.tw = { from: d.r.x, to: will[i][1], t0: now };
      });
      wave = { t0: now, origin: to, from: at };
    }
    dots[at].b.removeAttribute("aria-current");
    at = to;
    dots[at].b.setAttribute("aria-current", "step");
    if (fromHand) prog = 0;
    root.setAttribute("aria-label", label(at, n));
    run();
  }

  function setMark(to) {
    if (mark.to === to) return;
    mark.from = mark.cur;
    mark.to = to;
    mark.t0 = performance.now();
    go.setAttribute("aria-label", to === 0 ? "暂停自动播放" : "自动播放");
    run();
  }

  function setPlaying(v) {
    if (playing === v) return;
    playing = v;
    root.dataset.playing = String(v);
    setMark(v ? 0 : 1);
    run();
  }

  function toggle() {
    if (playing) { setPlaying(false); return; }
    /* 从末尾再按一下是重新开始，条会横穿整排回到第一个点 */
    if (at === n - 1 && prog >= 1) {
      prog = 0;
      move(0, true);
      onStep?.(0);
    }
    setPlaying(true);
  }

  function pick(i) {
    if (i === at) return;
    move(i, true);
    onStep?.(i);
  }

  go.addEventListener("click", toggle);

  /* 回到第一步、暂停、不带动画（引导每次重新打开时用） */
  function reset() {
    playing = false;
    root.dataset.playing = "false";
    prog = 0;
    wave = null;
    at = 0;
    const slots = layout(n, 0);
    dots.forEach((d, i) => {
      d.l = { x: slots[i][0], v: 0 };
      d.r = { x: slots[i][1], v: 0 };
      d.ink01 = 0;
      d.b.removeAttribute("aria-current");
    });
    dots[0].b.setAttribute("aria-current", "step");
    mark.cur = mark.from = mark.to = 1;
    go.setAttribute("aria-label", "自动播放");
    root.setAttribute("aria-label", label(0, n));
    paint(performance.now());
  }

  reset();

  return {
    el: root,
    /* 外部换了步骤（按钮、方向键）：只动画，不回调 onStep；已经在那一步就什么也不做 */
    set(i) { move(clamp(i, 0, n - 1), true); },
    pause() { setPlaying(false); },
    reset,
    destroy() { cancelAnimationFrame(raf); raf = 0; },
  };
}
