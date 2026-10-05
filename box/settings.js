/* 设置面板
   所有设置只保存在本机 localStorage，不涉及后端。
   依赖 app.js 中的全局：state、render、readSort、syncSort、toast、SORT_KEY。 */
(() => {
  const KEY = "myloon_box_settings";
  const DEFAULTS = { theme: "system", showDesc: true, showVer: true, showCat: true };
  const root = document.documentElement;
  const sheet = document.getElementById("settings");
  const $ = (id) => document.getElementById(id);

  function load() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch {}
    const out = { ...DEFAULTS };
    if (["system", "light", "dark"].includes(s.theme)) out.theme = s.theme;
    for (const k of ["showDesc", "showVer", "showCat"]) if (typeof s[k] === "boolean") out[k] = s[k];
    return out;
  }
  let settings = load();
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} };

  function apply() {
    if (settings.theme === "system") delete root.dataset.theme; else root.dataset.theme = settings.theme;
    root.toggleAttribute("data-hide-desc", !settings.showDesc);
    root.toggleAttribute("data-hide-ver", !settings.showVer);
    root.toggleAttribute("data-hide-cat", !settings.showCat);
    sheet.querySelectorAll("[data-theme-opt]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeOpt === settings.theme)));
    sheet.querySelectorAll("[data-switch]").forEach((b) => b.setAttribute("aria-checked", String(settings[b.dataset.switch])));
  }

  /* ---------- 面板开关 ---------- */
  function renderAbout() {
    $("aboutCount").textContent = state.plugins.length ? String(state.plugins.length) : "-";
    $("aboutDate").textContent = state.generatedAt ? new Date(state.generatedAt).toLocaleDateString("zh-CN") : "-";
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
    $("settingsBtn").focus();
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
      if (k === "showDesc" && state.plugins.length) render(); // 描述重新显示后，重新计算「展开」按钮
    }
  });

  /* ---------- 清除本地设置（行内二次确认） ---------- */
  $("clearBtn").addEventListener("click", () => { $("clearBtn").hidden = true; $("clearConfirm").hidden = false; });
  $("clearCancel").addEventListener("click", () => { $("clearConfirm").hidden = true; $("clearBtn").hidden = false; });
  $("clearOk").addEventListener("click", () => {
    try { localStorage.removeItem(KEY); localStorage.removeItem(SORT_KEY); } catch {}
    settings = { ...DEFAULTS };
    apply();
    state.sort = readSort(); // 排序也回到默认
    syncSort();
    if (state.plugins.length) render({ animate: true });
    $("clearConfirm").hidden = true;
    $("clearBtn").hidden = false;
    toast("已恢复默认设置");
  });

  apply();
})();
