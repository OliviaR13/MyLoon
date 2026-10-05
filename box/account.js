/* GitHub 账号：登录后把收藏和设置同步到云端（/api/me）。
   本机数据始终是第一份；未登录时一切照常工作。
   依赖：app.js（state、SORTS、SORT_KEY、setFavorites、syncSort、render、toast）、settings.js（MLB_settings）。 */
(() => {
  const $ = (id) => document.getElementById(id);
  // 显式声明要 JSON：服务端靠 Accept 判断是不是接口调用，不带就会被当成页面请求
  // 而回 302 重定向，登出就废了。
  // 写操作一律 keepalive：页面被卸载时这次请求还能活着落地。
  const api = (method, url, body) =>
    fetch(url, {
      method,
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body && JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      keepalive: method === "PUT",
    });
  let user = null, timer = 0, merging = false;
  // dirty：有改动还没被云端确认。登录握手没完成、正在合并、断网——都不许丢，排队等下一次机会。
  // settingsDirty：本次会话本地改过设置，merge 时据此决定谁听谁的。
  let dirty = false, settingsDirty = false, inflight = null, lastSyncAt = 0, pushWarned = false;

  const setHint = (on) => { try { on ? localStorage.setItem("myloon_box_login", "1") : localStorage.removeItem("myloon_box_login"); } catch {} };

  const hhmm = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  function refreshSync() {
    const n = $("syncState");
    if (!n) return;
    if (!user) { n.textContent = "未登录"; return; }
    if (inflight) { n.textContent = "同步中"; return; }
    if (dirty) { n.textContent = "待同步"; return; }
    n.textContent = lastSyncAt ? "已同步 " + hhmm(lastSyncAt) : "已同步";
  }

  function renderAccount() {
    $("loginBtn").hidden = !!user;
    $("accountRow").hidden = !user;
    if (user) {
      $("acctName").textContent = user.login;
      $("acctAvatar").src = "https://github.com/" + encodeURIComponent(user.login) + ".png?size=48";
    }
    refreshSync();
  }

  const snapshot = () => {
    const s = window.MLB_settings.get();
    return { favorites: [...state.favorites], settings: { theme: s.theme, showDesc: s.showDesc, showVer: s.showVer, showCat: s.showCat, sort: state.sort.key + ":" + state.sort.dir } };
  };

  // 同一类错误只提示一次，否则每次改动都弹一条很烦
  function warn(msg) {
    if (pushWarned) return;
    pushWarned = true;
    toast(msg);
  }

  async function flush() {
    if (inflight) return;            // 已有在途请求，让它跑完
    if (!user || merging) return;    // 暂时不可用：dirty 留着，等 user 就绪或 merge 结束
    inflight = (async () => {
      try {
        const res = await api("PUT", "/api/me", snapshot());
        if (res.ok) { dirty = false; lastSyncAt = Date.now(); pushWarned = false; return; }
        const detail = await res.json().catch(() => ({}));
        if (detail.error === "storage_not_configured") warn("云端存储未绑定，收藏和设置只保存在本机");
        else if (res.status === 401) warn("登录已过期，请重新登录后再同步");
        else warn("同步失败（HTTP " + res.status + "），稍后自动重试");
      } catch {
        // 网络断了或页面被掐断：dirty 保持，下次改动、回到前台或下次打开页面再试
      } finally {
        inflight = null;
        refreshSync();
      }
    })();
  }

  // 连续操作合并成一次保存。改了就置 dirty——即使此刻还没登录成功也不丢，
  // 只是先不排定时器，等 user 就绪再补发。
  const push = () => {
    dirty = true;
    clearTimeout(timer);
    if (user && !merging) timer = setTimeout(flush, 400);
    refreshSync();
  };

  document.addEventListener("favs:change", push);
  document.addEventListener("settings:change", () => { settingsDirty = true; push(); });

  // 页面要走了立刻补发，不等防抖。
  // iOS Safari 切后台会冻结页面，setTimeout 根本不会再执行，普通 fetch 也会被掐断；
  // PUT 带了 keepalive，这一次能活过页面卸载。少了这段，刚点的收藏就丢了。
  const leave = () => { if (dirty) { clearTimeout(timer); flush(); } };
  window.addEventListener("pagehide", leave);
  document.addEventListener("visibilitychange", () => {
    // 切走：立刻补发；切回来：把冻结期间没发出去的补上
    if (document.visibilityState === "hidden") leave();
    else if (dirty && user && !merging) { clearTimeout(timer); flush(); }
  });

  // 首次登录合并：收藏取并集（天然无冲突）；设置谁后改谁赢
  function merge(remote) {
    merging = true;
    setFavorites([...new Set([...state.favorites, ...(remote?.favorites || [])])]);
    // 握手期间本地已经改过设置，就别再拿云端旧值覆盖了，改完直接把本地推上去
    if (!settingsDirty) {
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
    }
    merging = false;
    push(); // 合并结果写回云端，顺便确认这次同步是通的
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
      if (dirty && !timer) flush(); // 握手排的队在 merge 里已经带走，这里是兜底
      refreshSync();
    } catch {
      // 拿不到会话不等于没登录，可能是网络抖了一下。说清楚，别让人以为是同步坏了。
      renderAccount();
      const n = $("syncState");
      if (n) n.textContent = "未连接云端";
    }
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
    dirty = settingsDirty = false;
    lastSyncAt = 0;
    pushWarned = false;
    setHint(false);
    renderAccount();
    toast("已退出登录，本机数据保留");
  });

  init();
})();
