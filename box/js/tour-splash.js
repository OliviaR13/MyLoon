/* 四步新手引导向导（<dialog id="tour">）与 Android 风格启动页（#splash） */

import { TOUR_KEY, SETTINGS_KEY, SORT_KEY, LOGIN_HINT_KEY, SPLASH_KEY, COLS_KEY } from "./config.js";
import { $id, el, lsGet, lsSet } from "./dom.js";
import { state } from "./state.js";
import { createStepPlayer } from "./step-player.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/* ---------- 新手引导 ---------- */

export const tour = (() => {
  const dlg = $id("tour");
  if (!dlg) return { open() {}, maybeShow() {} };
  dlg.tabIndex = -1;
  const ui = {
    stage: $id("tourStage"),
    dots: $id("tourDots"),
    count: $id("tourCount"),
    skip: $id("tourSkip"),
    next: $id("tourNext"),
  };

  const svg = (paths) => {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    paths.forEach((d) => {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      s.append(p);
    });
    return s;
  };

  const ICONS = {
    search: ["M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z", "M15.5 15.5L20 20"],
    shield: ["M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z", "M9 12l2 2 4-4"],
    star: ["M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.7l-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z"],
  };

  const categoriesExtra = () => {
    const cats = [...new Set(state.plugins.map((p) => p.category))].slice(0, 5);
    if (!cats.length) return null;
    const row = el("div", "tour-chips");
    row.append(el("span", "tour-label", "分类"), ...cats.map((c) => el("span", "chip", c)));
    return row;
  };

  const legendExtra = () => {
    const box = el("div", "tour-legend");
    [
      ["需 MITM", "需在 Loon 中开启 MITM 并信任证书"],
      ["含脚本", "包含脚本，建议安装前先查看源码"],
      ["可配置", "安装后可在 Loon 中调整参数"],
    ].forEach(([tag, text]) => {
      const row = el("div", "tour-legend-row");
      row.append(el("span", "chip chip-cap", tag), el("span", "", text));
      box.append(row);
    });
    return box;
  };

  const compareExtra = () => {
    const box = el("div", "tour-compare");
    [
      ["未登录", "收藏与设置仅保存在当前设备的浏览器中。"],
      ["登录 GitHub（可选）", "收藏及已开启同步的设置将随账号保存，可在多台设备间共用。"],
    ].forEach(([t, text]) => {
      const c = el("div", "tour-compare-col");
      c.append(el("strong", "", t), el("span", "", text));
      box.append(c);
    });
    return box;
  };

  const TOUR_STEPS = [
    {
      icon: "logo",
      title: "欢迎使用 Loon Box",
      body: "Loon Box 汇集常用的 Loon 插件，支持浏览、搜索与一键安装：点击「安装」即可唤起 Loon 完成配置。",
      hint: "本引导共 4 步，可随时跳过；如需再次查看，请前往「设置 → 关于 → 新手引导」。",
    },
    {
      icon: "search",
      title: "快速定位插件",
      body: "在搜索框输入关键词，列表会随输入实时筛选；结合分类与排序，可进一步缩小范围。",
      extra: categoriesExtra,
      hint: "搜索会同时匹配插件的名称与描述。",
    },
    {
      icon: "shield",
      title: "安装前，先查看详情",
      body: "点击插件名称或卡片上的 ⓘ 打开详情页，内容包括插件介绍、安装前须知与故障排查。卡片上的标记用于提示该插件的额外要求：",
      extra: legendExtra,
      hint: "各插件的要求不尽相同，建议安装前阅读「安装前须知」。",
    },
    {
      icon: "star",
      title: "收藏与同步",
      body: "点击卡片上的星标即可收藏，之后可在顶部「我的收藏」中集中查看。",
      extra: compareExtra,
      hint: "登录为可选项，未登录时所有功能均可正常使用。如需登录或退出，请前往「设置 → 账号」。",
    },
  ];

  let idx = 0, shownOnce = false, endClose = null;
  const steps = TOUR_STEPS.map((s, i) => {
    const sec = el("section", "tour-step");
    const icon = el("span", "tour-icon" + (s.icon === "logo" ? " tour-icon-logo" : ""));
    if (s.icon === "logo") {
      const img = el("img");
      img.src = "./icon.png";
      img.alt = "";
      img.width = 56;
      img.height = 56;
      icon.append(img);
    } else {
      icon.append(svg(ICONS[s.icon]));
    }
    const title = el("h2", "tour-title", s.title);
    title.id = "tourTitle" + i;
    sec.append(icon, title, el("p", "tour-body", s.body));
    const extra = el("div", "tour-extra");
    sec.append(extra, el("p", "tour-hint", s.hint));
    ui.stage.append(sec);
    return { sec, extra, make: s.extra };
  });
  /* 进度条是步骤播放器（js/step-player.js）：点上的条随步骤移动，右边的播放键可以让引导按节奏自动往下翻（默认暂停）。
     点某个点 / 自动前进 → onStep → go；按钮和方向键 → go → player.set（已经在那一步时什么也不做，不会互相触发） */
  const player = createStepPlayer(ui.dots, {
    steps: TOUR_STEPS.length,
    pace: 7,
    wake: 100,
    label: (i, n) => `第 ${i + 1} 步，共 ${n} 步`,
    onStep: (i) => go(i),
  });
  /* index.html 里这个容器原来是装饰用的 aria-hidden；现在里面是真正的按钮，必须让读屏软件和键盘都能到 */
  ui.dots.removeAttribute("aria-hidden");

  /* 内容区的高度跟着当前这一步走：四步叠在同一格里，原来取最高的那一步，第一步下面就空出一大块。
     现在量当前步骤自己的高度，换步时过渡；第一次打开时直接到位、不从 0 长出来。字体 / 内容变化由 ResizeObserver 追上。 */
  let fitted = false;
  function fit() {
    if (!dlg.open) return;
    const h = steps[idx].sec.offsetHeight;
    if (!h) return;
    const snap = !fitted;
    ui.stage.classList.toggle("snap", snap);
    ui.stage.style.height = h + "px";
    fitted = true;
    if (snap) requestAnimationFrame(() => ui.stage.classList.remove("snap"));
  }
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(fit);
    steps.forEach((s) => ro.observe(s.sec));
  }
  document.fonts?.ready.then(fit);

  function fill() {
    steps.forEach((s) => {
      const n = s.make ? s.make() : null;
      s.extra.replaceChildren(...(n ? [n] : []));
      s.extra.hidden = !n;
    });
  }

  function renderStep() {
    steps.forEach((s, i) => {
      const pos = i < idx ? "before" : i > idx ? "after" : "active";
      s.sec.dataset.pos = pos;
      s.sec.setAttribute("aria-hidden", String(pos !== "active"));
      s.sec.inert = pos !== "active";
    });
    player.set(idx);
    fit();
    const last = idx === TOUR_STEPS.length - 1;
    ui.count.textContent = `${idx + 1} / ${TOUR_STEPS.length}`;
    /* 只剩步骤播放器翻页：最后一步时「跳过」换成「开始使用」 */
    ui.skip.hidden = last;
    ui.next.hidden = !last;
    dlg.setAttribute("aria-labelledby", "tourTitle" + idx);
  }

  const go = (n) => { idx = Math.max(0, Math.min(TOUR_STEPS.length - 1, n)); renderStep(); };
  const isDone = () => { try { return localStorage.getItem(TOUR_KEY) === "1"; } catch { return true; } };
  const markDone = () => lsSet(TOUR_KEY, "1");

  function cancelClose() {
    if (endClose) {
      dlg.removeEventListener("transitionend", endClose.fn);
      clearTimeout(endClose.timer);
      endClose = null;
    }
    dlg.classList.remove("closing");
  }

  function open() {
    cancelClose();
    idx = 0;
    fitted = false;
    player.reset();
    fill();
    renderStep();
    if (!dlg.open) {
      document.documentElement.style.setProperty("--page-sbw", window.innerWidth - document.documentElement.clientWidth + "px");
      dlg.showModal();
    }
    fit();
    dlg.focus({ preventScroll: true });
    requestAnimationFrame(() => dlg.classList.add("open"));
  }

  function finish() {
    markDone();
    player.pause();
    if (!dlg.open || endClose) return;
    dlg.classList.add("closing");
    dlg.classList.remove("open");
    const end = () => { cancelClose(); if (dlg.open) dlg.close(); };
    const fn = (e) => { if (e.target === dlg && (e.propertyName === "transform" || e.propertyName === "opacity")) end(); };
    endClose = { fn, timer: setTimeout(end, 600) };
    dlg.addEventListener("transitionend", fn);
  }

  ui.next.addEventListener("click", finish);
  /* 在内容区左右滑动翻页：横向位移超过 48px 且明显大于纵向位移才算 */
  let sx = 0, sy = 0;
  ui.stage.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  ui.stage.addEventListener("touchend", (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) go(idx + (dx < 0 ? 1 : -1));
  }, { passive: true });
  ui.skip.addEventListener("click", finish);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); if (idx < TOUR_STEPS.length - 1) go(idx + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }
  });
  document.addEventListener("mlb:tour", () => open());

  const splashBusy = () => ["on", "leaving"].includes(document.documentElement.getAttribute("data-splash"));
  const returning = () =>
    Boolean(
      [SETTINGS_KEY, SORT_KEY, LOGIN_HINT_KEY, SPLASH_KEY, COLS_KEY].some((k) => lsGet(k)) ||
      state.favorites.size
    );

  function maybeShow() {
    if (shownOnce) return;
    shownOnce = true;
    if (isDone()) return;
    if (returning()) { markDone(); return; }
    const poll = () => {
      if (document.querySelector("dialog[open]")) return;
      if (splashBusy() || performance.now() < 2400) return void setTimeout(poll, 400);
      open();
    };
    setTimeout(poll, 600);
  }

  return { open, maybeShow };
})();

/* ---------- 启动页（Android 风格） ---------- */

export const splash = (() => {
  const root = document.documentElement;
  /* 启动页的显示时长，毫秒，从页面开始加载算起，固定不变：清单加载得再快或再慢都不改它。
     想长一点或短一点只改这一个数。 */
  const SHOW_MS = 1600;
  let called = root.getAttribute("data-splash") !== "on";
  function leave() {
    if (called) return;
    called = true;
    const el = $id("splash");
    if (!el || getComputedStyle(el).visibility === "hidden") {
      root.setAttribute("data-splash", "done");
      return;
    }
    root.setAttribute("data-splash", "leaving");
    setTimeout(() => root.setAttribute("data-splash", "done"), 600);
  }
  /* 到点就走，不等清单 */
  if (!called) setTimeout(leave, Math.max(0, SHOW_MS - performance.now()));
  return {
    /* 清单加载完成时也会调用 hide()，现在它什么也不做；只有 hide(true) 会立刻收起——
       人机验证需要用户点一下复选框时用，否则启动页会盖住验证框 */
    hide(force = false) {
      if (force) leave();
    },
  };
})();
