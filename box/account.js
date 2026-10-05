/* GitHub 账号：登录后把收藏和设置同步到云端（/api/me）。
   本机数据始终是第一份；未登录时一切照常工作。
   依赖：app.js（state、SORTS、SORT_KEY、setFavorites、syncSort、toast）、settings.js（MLB_settings）。 */
(() => {
  const $ = (id) => document.getElementById(id);
  // 显式声明要 JSON：服务端靠 Accept 判断是不是接口调用，不带就会被当成页面请求
  // 而回 302 重定向，登出就废了。
  const api = (method, url, body) =>
    fetch(url, {
      method,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body && JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
    });
  let user = null, timer = 0, merging = false;

  const setHint = (on) => { try { on ? localStorage.setItem("myloon_box_login", "1") : localStorage.removeItem("myloon_box_login"); } catch {} };

  function renderAccount() {
    $("loginBtn").hidden = !!user;
    $("accountRow").hidden = !user;
    if (user) {
      $("acctName").textContent = user.login;
      $("acctAvatar").src = "https://github.com/" + encodeURIComponent(user.login) + ".png?size=48";
    }
  }

  const snapshot = () => {
    const s = window.MLB_settings.get();
    return { favorites: [...state.favorites], settings: { theme: s.theme, showDesc: s.showDesc, showVer: s.showVer, showCat: s.showCat, sort: state.sort.key + ":" + state.sort.dir } };
  };
  // 连续操作合并成一次保存。失败要说话，以前 .catch(() => {}) 把一切都吞掉，
  // 云端没配好 KV 时界面上完全看不出来，只会被误认为「收藏不同步」。
  let pushWarned = false;
  const push = () => {
    if (!user || merging) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const res = await api("PUT", "/api/me", snapshot());
        if (res.ok) return;
        const detail = await res.json().catch(() => ({}));
        if (detail.error === "storage_not_configured") {
          if (!pushWarned) { pushWarned = true; toast("云端存储未绑定，收藏和设置只保存在本机"); }
        } else if (res.status === 401) {
          if (!pushWarned) { pushWarned = true; toast("登录已过期，请重新登录后再同步"); }
        }
      } catch {}
    }, 800);
  };
  document.addEventListener("favs:change", push);
  document.addEventListener("settings:change", push);

  // 首次登录合并：收藏取并集；设置以云端为准，云端没有就用本机的
  function merge(remote) {
    merging = true;
    setFavorites([...new Set([...state.favorites, ...(remote?.favorites || [])])]);
    const r = remote?.settings || {};
    const { sort, ...rest } = r;
    window.MLB_settings.set(rest);
    const [key, dir] = String(sort || "").split(":");
    if (SORTS[key] && (dir === "asc" || dir === "desc")) {
      state.sort = { key, dir };
      try { localStorage.setItem(SORT_KEY, key + ":" + dir); } catch {}
      syncSort();
      if (state.plugins.length) render();
    }
    merging = false;
    push(); // 把合并结果写回云端
  }

  async function init() {
    const err = new URLSearchParams(location.search).get("login_error");
    if (err) {
      const msg = { denied: "这个 GitHub 账号没有登录权限", state: "登录已过期，请重试", config: "登录功能尚未配置" }[err] || "GitHub 登录失败，请重试";
      toast(msg);
      history.replaceState(null, "", location.pathname);
    }
    try {
      const res = await api("GET", "/api/me");
      if (!res.ok) throw new Error();
      const data = await res.json();
      user = data.user;
      setHint(!!user);
      renderAccount();
      if (user) merge(data.data);
    } catch { renderAccount(); }
  }

  $("logoutBtn").addEventListener("click", async () => {
    // 先取消待发的云端同步：退出之后那次 PUT 必定 401，没必要再发一次
    clearTimeout(timer);
    try {
      const res = await api("POST", "/api/logout");
      if (!res.ok) throw new Error("HTTP " + res.status);
    } catch {
      // 请求失败时会话还在，界面保持原样，不谎报「已退出」
      toast("退出失败，请检查网络后重试");
      return;
    }
    user = null;
    setHint(false);
    renderAccount();
    toast("已退出登录，本机数据保留");
  });

  init();
})();
