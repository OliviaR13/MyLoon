/* GitHub 账号：登录后把收藏和设置同步到云端（/api/me）。
   本机数据始终是第一份；未登录时一切照常工作。
   同步有三个开关：总开关（关了什么都不同步）、同步外观、同步插件卡片设置。
   两组设置各记各的「最后修改时间」，互不影响。
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
  let dirty = false, inflight = null, lastSyncAt = 0, pushWarned = false, syncing = false;

  const setHint = (on) => { try { on ? localStorage.setItem("myloon_box_login", "1") : localStorage.removeItem("myloon_box_login"); } catch {} };

  const hhmm = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  function refreshSync() {
    const n = $("syncState");
    if (!n) return;
    if (!user) { n.textContent = "未登录"; return; }
    if (!ownMaster()) { n.textContent = "已关闭，收藏和设置只保存在本机"; return; }
    if (inflight || syncing) { n.textContent = "同步中"; return; }
    if (dirty) { n.textContent = "待同步"; return; }
    n.textContent = lastSyncAt ? "已同步 " + hhmm(lastSyncAt) : "已同步";
  }

  function renderAccount() {
    const m = ownMaster();
    $("loginRow").hidden = !!user; // 整行一起藏，只藏按钮会剩一个孤零零的「GitHub」
    $("accountRow").hidden = !user;
    $("syncMasterSwitch").hidden = !user; // 没登录就没有「同步」可言，只留一行状态
    $("syncMasterSwitch").setAttribute("aria-checked", String(m));
    $("syncNowRow").hidden = !user || !m;
    for (const [g, id] of [["look", "syncLook"], ["cards", "syncCards"]]) {
      $(id + "Row").hidden = !user;
      $(id + "Row").dataset.off = String(!m); // 总开关关了，两个子开关变灰
      const sw = $(id + "Switch");
      sw.setAttribute("aria-checked", String(own(g)));
      sw.disabled = !m;
    }
    if (user) {
      $("acctName").textContent = user.login;
      $("acctAvatar").src = "https://github.com/" + encodeURIComponent(user.login) + ".png?size=48";
    }
    refreshSync();
  }

  /* ---------- 三个同步开关 ----------
     master：总开关。关了以后既不上传也不采用云端的任何东西（收藏和设置都只留在本机）。
     look：外观（主题、减少动画、搜索框样式）。
     cards：插件卡片设置（显示项、紧凑模式、收藏置顶、排序）。
     look 沿用旧的「同步外观与显示」那个键，所以以前关掉它的人，外观和卡片设置都保持关闭。 */
  const SYNC_KEYS = { master: "myloon_box_sync", look: "myloon_box_sync_look", cards: "myloon_box_sync_cards" };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const ownMaster = () => lsGet(SYNC_KEYS.master) !== "0";
  const own = (g) => lsGet(SYNC_KEYS[g]) !== "0";
  if (lsGet(SYNC_KEYS.cards) === null) lsSet(SYNC_KEYS.cards, own("look") ? "1" : "0"); // 迁移：旧开关同时管着卡片设置
  const on = (g) => ownMaster() && own(g); // 这一组此刻是否真的在同步

  const GROUPS = {
    look: { keys: ["theme", "reduceMotion", "collapseSearch"], at: "myloon_box_look_at", cloud: "lookAt", label: "外观" },
    cards: { keys: ["showDesc", "showVer", "showCat", "compact", "pinFavs"], sort: true, at: "myloon_box_cards_at", cloud: "cardsAt", label: "插件卡片设置" },
  };
  // 每组设置的「最后修改时间」，同步时用它判断本机和云端谁更新；没有时回退到旧的统一时间戳
  const LEGACY_AT = "myloon_box_settings_at";
  const getAt = (g) => { const v = lsGet(GROUPS[g].at); return v !== null ? Number(v) || 0 : Number(lsGet(LEGACY_AT)) || 0; };
  const setAt = (g, t) => lsSet(GROUPS[g].at, String(t));
  const settingsDirty = { look: false, cards: false }; // 本次会话本地改过这一组，merge 时据此决定谁听谁的

  const groupValues = (g) => {
    const s = window.MLB_settings.get();
    const out = {};
    for (const k of GROUPS[g].keys) out[k] = s[k];
    if (GROUPS[g].sort) out.sort = state.sort.key + ":" + state.sort.dir;
    return out;
  };
  // 记下每组设置的当前值：settings:change 里靠对比知道是哪一组变了
  const seen = {};
  const refreshSeen = () => { for (const g of Object.keys(GROUPS)) seen[g] = JSON.stringify(groupValues(g)); };

  const snapshot = () => {
    const out = { favorites: [...state.favorites], favMeta: state.favMeta };
    const settings = {};
    let at = 0;
    for (const g of Object.keys(GROUPS)) { // 关闭的那组不带，服务端会保留云端原有的那一份
      if (!on(g)) continue;
      Object.assign(settings, groupValues(g));
      out[GROUPS[g].cloud] = getAt(g);
      at = Math.max(at, getAt(g));
    }
    if (Object.keys(settings).length) { out.settings = settings; out.settingsAt = at; }
    return out;
  };

  // 同一类错误只提示一次，否则每次改动都弹一条很烦
  function warn(msg) {
    if (pushWarned) return;
    pushWarned = true;
    toast(msg);
  }

  async function flush() {
    if (inflight) return;            // 已有在途请求，让它跑完
    if (!user || merging || !ownMaster()) return; // 暂时不可用：dirty 留着，等 user 就绪或 merge 结束
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
    return inflight;
  }

  // 「立即同步」：一次完整的来回——先把云端拉下来合并，再把合并结果推回去，
  // 不等防抖、不等下次打开页面。只推不拉不算同步，另一台设备上的改动就永远进不来。
  async function syncNow() {
    if (!user || syncing || !ownMaster()) return;
    syncing = true;
    clearTimeout(timer);
    const b = $("syncNowBtn");
    if (b) b.disabled = true;
    refreshSync();
    try {
      const res = await api("GET", "/api/me");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data.user) { // 会话过期了，说清楚，别让人对着一个没反应的按钮点
        user = null;
        setHint(false);
        renderAccount();
        toast("登录已过期，请重新登录");
        return;
      }
      // 手动点的这一次一定要有反馈，别被「同一类错误只提示一次」吞掉
      pushWarned = false;
      merge(data.data);
      await flush();
      if (!dirty) toast("已同步");
      else if (!pushWarned) toast("还没同步上去，稍后会自动重试"); // pushWarned 为真说明 flush 已经把原因说清楚了
    } catch {
      toast("同步失败，请检查网络后重试");
    } finally {
      syncing = false;
      if (b) b.disabled = false;
      refreshSync();
    }
  }
  $("syncNowBtn").addEventListener("click", syncNow);

  // 连续操作合并成一次保存。改了就置 dirty——即使此刻还没登录成功也不丢，
  // 只是先不排定时器，等 user 就绪再补发。总开关关着时什么都不记，打开时会做一次完整同步。
  const push = () => {
    if (!ownMaster()) return;
    dirty = true;
    clearTimeout(timer);
    if (user && !merging) timer = setTimeout(flush, 400);
    refreshSync();
  };

  document.addEventListener("favs:change", push);
  document.addEventListener("settings:change", () => {
    let changed = false;
    for (const g of Object.keys(GROUPS)) {
      const cur = JSON.stringify(groupValues(g));
      if (cur === seen[g]) continue;
      seen[g] = cur;
      if (!on(g)) continue; // 这一组不参与同步
      settingsDirty[g] = true; setAt(g, Date.now()); changed = true;
    }
    if (changed) push();
  });

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

  // 收藏：每个插件各记一条「最后一次操作的时间 + 是否收藏」，谁后操作听谁的。
  // 取消收藏会留下一条「已取消」记录，另一台设备才知道要删掉它，而不是再把它加回来。
  // 没有时间戳的旧数据按「最早的已收藏」处理。太旧（90 天）的取消记录会被清掉。
  const TOMBSTONE_TTL = 90 * 24 * 3600 * 1000;
  function mergeFavs(localMeta, localSet, remote, now) {
    const remoteMeta = { ...(remote?.favMeta || {}) };
    for (const id of remote?.favorites || []) if (!remoteMeta[id]) remoteMeta[id] = [0, 1];
    const merged = {};
    for (const id of new Set([...Object.keys(localMeta), ...localSet, ...Object.keys(remoteMeta)])) {
      const a = localMeta[id] || (localSet.has(id) ? [0, 1] : null);
      const b = remoteMeta[id] || null;
      const pick = !a ? b : !b ? a : b[0] > a[0] ? b : a; // 时间相同保留本地
      if (pick[1] === 0 && now - pick[0] > TOMBSTONE_TTL) continue;
      merged[id] = pick;
    }
    return { ids: Object.keys(merged).filter((id) => merged[id][1] === 1), meta: merged };
  }

  // 合并：收藏逐项比时间；每组设置整体比「最后修改时间」，更新的一边赢
  function merge(remote) {
    merging = true;
    const { ids, meta } = mergeFavs(state.favMeta, state.favorites, remote, Date.now());
    setFavorites(ids, meta);
    let appliedCards = false;
    for (const g of Object.keys(GROUPS)) {
      if (!on(g) || !remote?.settings) continue;
      const { keys, sort, cloud } = GROUPS[g];
      // 云端旧数据只有统一的 settingsAt，两组都按它算
      const remoteAt = Number(remote[cloud] ?? remote.settingsAt) || 0;
      const localAt = getAt(g);
      // 旧数据没有时间戳：两边都没记录时，沿用「本次会话没改过就听云端的」
      const useRemote = remoteAt > localAt || (remoteAt === 0 && localAt === 0 && !settingsDirty[g]);
      if (!useRemote) continue;
      const part = {};
      for (const k of keys) if (k in remote.settings) part[k] = remote.settings[k];
      window.MLB_settings.set(part);
      if (sort) {
        const [key, dir] = String(remote.settings.sort || "").split(":");
        if (SORTS[key] && (dir === "asc" || dir === "desc")) {
          state.sort = { key, dir };
          lsSet(SORT_KEY, key + ":" + dir);
          syncSort();
        }
        appliedCards = true;
      }
      if (remoteAt) setAt(g, remoteAt);
    }
    if (appliedCards && state.plugins.length) render();
    refreshSeen(); // 云端带来的改动不算本地改动
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
      if (user && ownMaster()) merge(data.data);
      if (dirty && !timer) flush(); // 握手排的队在 merge 里已经带走，这里是兜底
      refreshSync();
    } catch {
      // 拿不到会话不等于没登录，可能是网络抖了一下。说清楚，别让人以为是同步坏了。
      renderAccount();
      const n = $("syncState");
      if (n) n.textContent = "未连接云端";
    }
  }

  // 总开关：关闭只是停止同步（本机数据原样保留）；
  // 打开时做一次完整的来回，各组设置以这台设备当前的为准（刚点开关就是明确的操作），收藏逐项合并。
  $("syncMasterSwitch").addEventListener("click", () => {
    const next = !ownMaster();
    lsSet(SYNC_KEYS.master, next ? "1" : "0");
    liquidThumb($("syncMasterSwitch"), 18, next);
    if (next) {
      for (const g of Object.keys(GROUPS)) if (own(g)) { setAt(g, Date.now()); settingsDirty[g] = true; }
      renderAccount();
      syncNow();
    } else {
      clearTimeout(timer);
      dirty = false;
      renderAccount();
      toast("已关闭云端同步，收藏和设置只保存在本机");
    }
  });

  // 两个子开关：开启时，以这台设备当前的这一组为准上传；关闭时只记下选择
  for (const [g, id] of [["look", "syncLookSwitch"], ["cards", "syncCardsSwitch"]]) {
    $(id).addEventListener("click", () => {
      if (!ownMaster()) return;
      const next = !own(g);
      lsSet(SYNC_KEYS[g], next ? "1" : "0");
      $(id).setAttribute("aria-checked", String(next));
      liquidThumb($(id), 18, next);
      const label = GROUPS[g].label;
      if (next) { setAt(g, Date.now()); settingsDirty[g] = true; push(); toast(`已开启${label}同步，本机的${label}已上传`); }
      else toast(`已关闭${label}同步，这台设备独立保存${label}`);
    });
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
    dirty = false;
    settingsDirty.look = settingsDirty.cards = false;
    lastSyncAt = 0;
    pushWarned = false;
    setHint(false);
    renderAccount();
    toast("已退出登录，本机数据保留");
  });

  refreshSeen();
  init();
})();
