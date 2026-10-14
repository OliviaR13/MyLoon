/* 四步新手引导向导（<dialog id="tour">）与 Android 风格启动页（#splash） */

import { TOUR_KEY, SETTINGS_KEY, SORT_KEY, LOGIN_HINT_KEY, SPLASH_KEY, COLS_KEY } from "./config.js";
import { $id, el, lsGet, lsSet } from "./dom.js";
import { state } from "./state.js";

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
    prev: $id("tourPrev"),
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
      ["需 MITM", "需要在 Loon 里开启 MITM 并信任证书"],
      ["含脚本", "带有脚本，安装前可以先看源码"],
      ["可配置", "安装后可以在 Loon 里调整参数"],
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
      ["未登录", "收藏和设置只保存在这台设备的浏览器里。"],
      ["登录 GitHub（可选）", "收藏和已开启同步的设置跟着账号走，多台设备共用。"],
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
      title: "欢迎来到 Loon Box",
      body: "这里收集了常用的 Loon 插件。可以浏览、搜索，看中了点一下「安装」，就会唤起 Loon 完成安装。",
      hint: "引导一共 4 步，随时可以跳过；之后想再看，到「设置 → 关于 → 新手引导」。",
    },
    {
      icon: "search",
      title: "快速找到需要的插件",
      body: "在搜索框里输入关键词，按回车添加；可以添加多个关键词一起筛选。再配合分类和排序，很快就能缩小范围。",
      extra: categoriesExtra,
      hint: "多个关键词默认需要「同时命中」。想改成「命中任意一个即可」，可以在「设置 → 外观 → 多关键词逻辑」里切换。",
    },
    {
      icon: "shield",
      title: "装之前，先看看详情",
      body: "点插件名称，或卡片上的 ⓘ，就能打开详情：介绍、安装前须知、遇到问题怎么排查，都在里面。卡片上的小标记会提示这个插件有额外要求：",
      extra: legendExtra,
      hint: "每个插件的要求不一样，花几秒看看「安装前须知」，能省不少麻烦。",
    },
    {
      icon: "star",
      title: "收藏与同步",
      body: "点卡片上的星标收藏插件，之后在顶部的「我的收藏」里集中查看。",
      extra: compareExtra,
      hint: "登录不是必须的，不登录也能使用全部功能。想登录或退出，到「设置 → 账号」。",
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
  const dots = TOUR_STEPS.map(() => {
    const d = el("i", "tour-dot");
    ui.dots.append(d);
    return d;
  });

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
    dots.forEach((d, i) => d.toggleAttribute("data-on", i === idx));
    const last = idx === TOUR_STEPS.length - 1;
    ui.count.textContent = `${idx + 1} / ${TOUR_STEPS.length}`;
    ui.prev.style.visibility = idx === 0 ? "hidden" : "visible";
    ui.skip.hidden = last;
    ui.next.textContent = last ? "开始使用" : "下一步";
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
    fill();
    renderStep();
    if (!dlg.open) {
      document.documentElement.style.setProperty("--page-sbw", window.innerWidth - document.documentElement.clientWidth + "px");
      dlg.showModal();
    }
    dlg.focus({ preventScroll: true });
    requestAnimationFrame(() => dlg.classList.add("open"));
  }

  function finish() {
    markDone();
    if (!dlg.open || endClose) return;
    dlg.classList.add("closing");
    dlg.classList.remove("open");
    const end = () => { cancelClose(); if (dlg.open) dlg.close(); };
    const fn = (e) => { if (e.target === dlg && (e.propertyName === "transform" || e.propertyName === "opacity")) end(); };
    endClose = { fn, timer: setTimeout(end, 600) };
    dlg.addEventListener("transitionend", fn);
  }

  ui.next.addEventListener("click", () => (idx === TOUR_STEPS.length - 1 ? finish() : go(idx + 1)));
  ui.prev.addEventListener("click", () => go(idx - 1));
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
  const MIN_SHOW = 900;
  let called = root.getAttribute("data-splash") !== "on";
  return {
    hide() {
      if (called) return;
      called = true;
      setTimeout(() => {
        const el = $id("splash");
        if (!el || getComputedStyle(el).visibility === "hidden") {
          root.setAttribute("data-splash", "done");
          return;
        }
        root.setAttribute("data-splash", "leaving");
        setTimeout(() => root.setAttribute("data-splash", "done"), 600);
      }, Math.max(0, MIN_SHOW - performance.now()));
    },
  };
})();
