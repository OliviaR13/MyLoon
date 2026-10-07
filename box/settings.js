/* 设置面板
   所有设置只保存在本机 localStorage，不涉及后端。
   依赖 app.js 中的全局：state、render、readSort、syncSort、toast、SORT_KEY。 */
(() => {
  const KEY = "myloon_box_settings";
  const DEFAULTS = { theme: "system", showDesc: true, showVer: true, showCat: true, pinFavs: false, compact: false, reduceMotion: false, collapseSearch: false };
  const root = document.documentElement;
  const sheet = document.getElementById("settings");
  const $ = (id) => document.getElementById(id);
  const BOOL_KEYS = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === "boolean"); // 开关类设置，不再手写第二份清单

  function load() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
    const out = { ...DEFAULTS };
    if (["system", "light", "dark"].includes(s.theme)) out.theme = s.theme;
    for (const k of BOOL_KEYS) if (typeof s[k] === "boolean") out[k] = s[k];
    return out;
  }
  let settings = load();
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
    document.dispatchEvent(new Event("settings:change")); // account.js 据此同步到云端
  };

  // 系统的「减少动态效果」。生效与否 = 手动开启 或 系统开启，合并后写到 <html data-reduce-motion>，CSS 和 app.js 都只认它
  const sysReduce = matchMedia("(prefers-reduced-motion: reduce)");
  const REDUCE_HINT = "关闭过渡和入场动画。系统已开启「减少动态效果」时自动生效";

  function apply() {
    const forced = sysReduce.matches; // 系统已开：这一项由系统接管，开关显示为开并锁定
    if (settings.theme === "system") delete root.dataset.theme; else root.dataset.theme = settings.theme;
    root.toggleAttribute("data-hide-desc", !settings.showDesc);
    root.toggleAttribute("data-hide-ver", !settings.showVer);
    root.toggleAttribute("data-hide-cat", !settings.showCat);
    root.toggleAttribute("data-compact", settings.compact);
    root.toggleAttribute("data-reduce-motion", settings.reduceMotion || forced);
    root.toggleAttribute("data-search-collapse", settings.collapseSearch);
    sheet.querySelectorAll("[data-theme-opt]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeOpt === settings.theme)));
    // 所有开关的状态都经 setSwitch：点击、云端同步、恢复默认走的是同一条路，动效一致
    sheet.querySelectorAll("[data-switch]").forEach((b) => {
      const lock = forced && b.dataset.switch === "reduceMotion";
      setSwitch(b, settings[b.dataset.switch] || lock);
      b.disabled = lock;
    });
    $("reduceMotionSub").textContent = forced ? "系统已开启「减少动态效果」，已自动生效" : REDUCE_HINT;
    if (typeof syncSort === "function") syncSort(); // 排序菜单里的「收藏置顶」状态跟着同步
    if (typeof syncSearch === "function") syncSearch(); // 搜索框收起 / 展开跟着设置走
  }

  /* ---------- 面板开关 ---------- */
  // 「今天 / 昨天 / 3 天前」，超过 30 天不显示
  function ago(t) {
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86400000);
    return days <= 0 ? "今天更新" : days === 1 ? "昨天更新" : days < 30 ? days + " 天前更新" : "";
  }
  function renderAbout() {
    const n = state.plugins.length;
    $("aboutCount").textContent = n ? n + " 个" : "-";
    const t = state.generatedAt ? new Date(state.generatedAt) : null;
    const ok = t && !isNaN(t);
    $("aboutDate").textContent = ok ? t.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }) : "-";
    const sub = ok ? ago(t) : "";
    $("aboutAgo").textContent = sub;
    $("aboutAgo").hidden = !sub;
  }
  // 退场：加上 .closing 换成「先慢后快」的曲线，等面板的 transform 过渡真正结束再 close()，
  // 不再靠一个写死的 400ms 去猜——猜早了会在最后一帧硬切，猜晚了会留一块看不见却挡手的面板。
  let endClose = null;
  function cancelClose() {
    if (endClose) { sheet.removeEventListener("transitionend", endClose.fn); clearTimeout(endClose.timer); endClose = null; }
    sheet.classList.remove("closing");
  }
  function open() {
    cancelClose(); // 退场动画还没播完就又点开：直接接回来
    renderAbout();
    endClear();
    if (!sheet.open) sheet.showModal();
    requestAnimationFrame(() => sheet.classList.add("open")); // 下一帧再加 class，过渡才会播放
  }
  function close() {
    if (!sheet.open || endClose) return;
    sheet.classList.add("closing");
    sheet.classList.remove("open");
    const finish = () => { cancelClose(); if (sheet.open) sheet.close(); };
    const fn = (e) => { if (e.target === sheet && e.propertyName === "transform") finish(); };
    endClose = { fn, timer: setTimeout(finish, 600) }; // 兜底：减少动画 / 过渡被打断时也一定会关
    sheet.addEventListener("transitionend", fn);
  }
  // 全屏切换：状态只记在内存里（sheet 上的 .full 类）。
  // 本次访问内关闭再打开设置页会保持上次的展开状态；刷新或重新进入页面后恢复默认，不写入 localStorage、也不同步到云端
  function setFull(on) {
    sheet.classList.toggle("full", on);
    const b = $("settingsFull");
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", on ? "退出全屏" : "全屏显示");
  }
  $("settingsFull").addEventListener("click", () => setFull(!sheet.classList.contains("full")));
  $("settingsBtn").addEventListener("click", open);
  $("settingsClose").addEventListener("click", close);
  sheet.addEventListener("cancel", (e) => { e.preventDefault(); close(); }); // Esc
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); }); // 点遮罩

  /* ---------- 设置项 ---------- */
  sheet.addEventListener("click", (e) => {
    const t = e.target.closest("[data-theme-opt]");
    if (t) { settings.theme = t.dataset.themeOpt; save(); apply(); return; }
    const sw = e.target.closest("[data-switch]");
    if (sw) {
      const k = sw.dataset.switch;
      settings[k] = !settings[k];
      save(); apply(); // 开关动效在 apply → setSwitch 里播
      // 描述重新显示后，重新计算「展开」按钮；收藏置顶会改变排序结果。都等开关动效起步后再重建列表
      if ((k === "showDesc" || k === "compact") && state.plugins.length) afterPaint(() => render());
      if (k === "pinFavs" && state.plugins.length) afterPaint(() => render({ animate: true }));
    }
  });

  /* ---------- 恢复默认设置（行内立即执行 + 撤销） ----------
     思路借自 Bencho 的 Confirm：不弹二次确认，点一下就恢复默认，
     同一行变成「已恢复默认设置 · 撤销」，下方一条细线在 GRACE 内烧完。
     撤销就在原地，只打扰改变主意的人。 */
  const GRACE = 5000;
  let clearTimer = 0;
  const showClearRow = (done) => { $("clearConfirm").hidden = !done; $("clearBtn").hidden = done; };
  const endClear = () => { clearTimeout(clearTimer); showClearRow(false); };

  $("clearBtn").addEventListener("click", () => {
    // 先留一份现状，撤销时原样放回
    const prevSettings = { ...settings };
    const prevSort = { ...state.sort };
    let prevSortRaw = null;
    try { prevSortRaw = localStorage.getItem(SORT_KEY); } catch {}

    try { localStorage.removeItem(SORT_KEY); } catch {}
    settings = { ...DEFAULTS };
    save(); // 走 save 才会派发 settings:change；已登录且开启外观同步时，云端跟着一起恢复默认
    apply();
    state.sort = readSort(); // 排序也回到默认
    syncSort();
    if (state.plugins.length) render({ animate: true });

    // 每次都重新播放「烧引信」动画
    const fuse = $("clearFuse");
    fuse.style.animation = "none";
    void fuse.offsetWidth;
    fuse.style.animation = "";
    fuse.style.animationDuration = GRACE + "ms";
    showClearRow(true);
    clearTimeout(clearTimer);
    clearTimer = setTimeout(endClear, GRACE);

    $("clearUndo").onclick = () => {
      settings = prevSettings;
      try { if (prevSortRaw !== null) localStorage.setItem(SORT_KEY, prevSortRaw); } catch {}
      state.sort = prevSort;
      save();
      apply();
      syncSort();
      if (state.plugins.length) render({ animate: true });
      endClear();
      toast("已撤销");
    };
  });

  /* ---------- 复制收藏的插件链接 ---------- */
  $("copyFavsBtn").addEventListener("click", async () => {
    const list = state.plugins.filter((p) => state.favorites.has(p.id));
    if (!list.length) return toast("还没有收藏的插件");
    const ok = await copyText(list.map(rawUrl).join("\n"));
    toast(ok ? `已复制 ${list.length} 个插件链接` : "复制失败，请手动复制");
  });

  // 供 account.js 读写（登录后合并云端设置）
  window.MLB_settings = {
    get: () => ({ ...settings }),
    set(next) {
      const prev = settings.showDesc;
      settings = { ...settings, ...next };
      try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
      apply();
      if (prev !== settings.showDesc && state.plugins.length) render();
    },
  };

  // 系统设置在页面打开期间改了也要立刻跟上
  if (sysReduce.addEventListener) sysReduce.addEventListener("change", apply); else sysReduce.addListener(apply);

  apply();
})();
