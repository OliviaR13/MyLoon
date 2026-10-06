/* 设置面板
   所有设置只保存在本机 localStorage，不涉及后端。
   依赖 app.js 中的全局：state、render、readSort、syncSort、toast、SORT_KEY。 */
(() => {
  const KEY = "myloon_box_settings";
  const DEFAULTS = { theme: "system", showDesc: true, showVer: true, showCat: true, pinFavs: false, compact: false, reduceMotion: false };
  const root = document.documentElement;
  const sheet = document.getElementById("settings");
  const $ = (id) => document.getElementById(id);

  function load() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
    const out = { ...DEFAULTS };
    if (["system", "light", "dark"].includes(s.theme)) out.theme = s.theme;
    for (const k of ["showDesc", "showVer", "showCat", "pinFavs", "compact", "reduceMotion"]) if (typeof s[k] === "boolean") out[k] = s[k];
    return out;
  }
  let settings = load();
  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
    document.dispatchEvent(new Event("settings:change")); // account.js 据此同步到云端
  };

  function apply() {
    if (settings.theme === "system") delete root.dataset.theme; else root.dataset.theme = settings.theme;
    root.toggleAttribute("data-hide-desc", !settings.showDesc);
    root.toggleAttribute("data-hide-ver", !settings.showVer);
    root.toggleAttribute("data-hide-cat", !settings.showCat);
    root.toggleAttribute("data-compact", settings.compact);
    root.toggleAttribute("data-reduce-motion", settings.reduceMotion);
    sheet.querySelectorAll("[data-theme-opt]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeOpt === settings.theme)));
    sheet.querySelectorAll("[data-switch]").forEach((b) => b.setAttribute("aria-checked", String(settings[b.dataset.switch])));
    if (typeof syncSort === "function") syncSort(); // 排序菜单里的「收藏置顶」状态跟着同步
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
  function open() {
    renderAbout();
    $("clearConfirm").hidden = true;
    $("clearBtn").hidden = false;
    sheet.showModal();
    requestAnimationFrame(() => sheet.classList.add("open")); // 下一帧再加 class，过渡才会播放
  }
  function close() {
    sheet.classList.remove("open");
    setTimeout(() => sheet.open && sheet.close(), 400);
  }
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
      save(); apply();
      if ((k === "showDesc" || k === "compact") && state.plugins.length) render(); // 描述重新显示后，重新计算「展开」按钮
      if (k === "pinFavs" && state.plugins.length) render({ animate: true }); // 收藏置顶开关改变排序结果
    }
  });

  /* ---------- 清除本地设置（行内二次确认） ---------- */
  $("clearBtn").addEventListener("click", () => { $("clearBtn").hidden = true; $("clearConfirm").hidden = false; });
  $("clearCancel").addEventListener("click", () => { $("clearConfirm").hidden = true; $("clearBtn").hidden = false; });
  $("clearOk").addEventListener("click", () => {
    try { localStorage.removeItem(SORT_KEY); } catch {}
    settings = { ...DEFAULTS };
    save(); // 走 save 才会派发 settings:change，云端跟着一起恢复默认
    apply();
    state.sort = readSort(); // 排序也回到默认
    syncSort();
    if (state.plugins.length) render({ animate: true });
    $("clearConfirm").hidden = true;
    $("clearBtn").hidden = false;
    toast("已恢复默认设置");
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

  apply();
})();
