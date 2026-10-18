/* GitHub 账号与云端同步（/api/me、/api/logout）：
   支持收藏逐项时间戳（Tombstone CRDT）合并，以及外观、插件卡片两组独立时间戳同步。
   云端数据格式没有变：服务端（functions/api/me.js）原样兼容。设置页偏好那一组（fullDefault / panelAt）已经下线，
   客户端不再读写它，云端里残留的旧值会被忽略。 */

import { SYNC_KEYS, LEGACY_AT, TOMBSTONE_TTL, SORT_KEY, LOGIN_HINT_KEY } from "./config.js";
import { $id, setSwitch, lsGet, lsSet, lsRemove, confirmable } from "./dom.js";
import { SORTS, state, getSettings, setSettings } from "./state.js";
import { toast } from "./toast.js";
import { render, setFavorites } from "./render.js";
import { syncSort } from "./search-sort.js";

const GROUPS = {
  look: { keys: ["theme", "reduceMotion"], at: "myloon_box_look_at", cloud: "lookAt", label: "外观" },
  cards: { keys: ["showDesc", "showVer", "showCat", "compact", "pinFavs"], sort: true, at: "myloon_box_cards_at", cloud: "cardsAt", label: "插件卡片设置" },
};

const api = (method, url, body) =>
  fetch(url, {
    method,
    headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body && JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
    keepalive: method === "PUT",
  });

const hhmm = (t) => {
  const d = new Date(t);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};

export function initAccount() {
  let user = null;
  let timer = 0;
  let merging = false;
  let dirty = false;
  let inflight = null;
  let lastSyncAt = 0;
  let pushWarned = false;
  let syncing = false;

  const setHint = (on) => (on ? lsSet(LOGIN_HINT_KEY, "1") : lsRemove(LOGIN_HINT_KEY));
  const ownMaster = () => lsGet(SYNC_KEYS.master) !== "0";
  const own = (g) => lsGet(SYNC_KEYS[g]) !== "0";
  if (lsGet(SYNC_KEYS.cards) === null) lsSet(SYNC_KEYS.cards, own("look") ? "1" : "0");
  const on = (g) => ownMaster() && own(g);

  // 已下线的「设置页偏好」同步组留下的本机记录，清掉
  ["myloon_box_sync_panel", "myloon_box_panel_at"].forEach(lsRemove);

  const getAt = (g) => {
    const v = lsGet(GROUPS[g].at);
    return v !== null ? Number(v) || 0 : Number(lsGet(LEGACY_AT)) || 0;
  };
  const setAt = (g, t) => lsSet(GROUPS[g].at, String(t));
  const settingsDirty = { look: false, cards: false };

  const groupValues = (g) => {
    const s = getSettings();
    const out = {};
    for (const k of GROUPS[g].keys) out[k] = s[k];
    if (GROUPS[g].sort) out.sort = state.sort.key + ":" + state.sort.dir;
    return out;
  };

  const seen = {};
  const refreshSeen = () => {
    for (const g of Object.keys(GROUPS)) seen[g] = JSON.stringify(groupValues(g));
  };

  function refreshSync() {
    const n = $id("syncState");
    if (!n) return;
    if (!user) { n.textContent = "未登录"; return; }
    if (!ownMaster()) { n.textContent = "已关闭，只保存在这台设备"; return; }
    if (inflight || syncing) { n.textContent = "正在同步…"; return; }
    if (dirty) { n.textContent = "有改动，稍后自动同步"; return; }
    n.textContent = lastSyncAt ? "已同步 · " + hhmm(lastSyncAt) : "已同步";
  }

  function renderAccount() {
    const m = ownMaster();
    $id("loginRow").hidden = !!user;
    $id("accountRow").hidden = !user;
    // 登录后，同一张卡片里才出现同步相关的行
    for (const id of ["syncRow", "syncLookRow", "syncCardsRow"]) $id(id).hidden = !user;
    $id("syncFoot").hidden = !user;
    if (user) $id("loginSub").textContent = "登录后，收藏和设置可以在多台设备间同步";
    setSwitch($id("syncMasterSwitch"), m);
    $id("syncNowRow").hidden = !user || !m;
    for (const [g, id] of [["look", "syncLook"], ["cards", "syncCards"]]) {
      $id(id + "Row").dataset.off = String(!m);
      const sw = $id(id + "Switch");
      setSwitch(sw, own(g));
      sw.disabled = !m;
    }
    $id("syncFoot").textContent = m
      ? "收藏始终同步，逐个插件合并。外观和插件卡片可以分别关闭，关闭后只保存在这台设备；多台设备改了同一项时，以最后一次修改为准。启动页、设置页的全屏与布局只存本机，不上传。"
      : "云端同步已关闭：收藏和设置只保存在这台设备，不会上传，也不会读取云端的内容。";
    if (user) {
      $id("acctName").textContent = user.login;
      $id("acctAvatar").src = "https://github.com/" + encodeURIComponent(user.login) + ".png?size=48";
    }
    refreshSync();
  }

  const snapshot = () => {
    const out = { favorites: [...state.favorites], favMeta: state.favMeta };
    const settings = {};
    let at = 0;
    for (const g of Object.keys(GROUPS)) {
      if (!on(g)) continue;
      Object.assign(settings, groupValues(g));
      out[GROUPS[g].cloud] = getAt(g);
      at = Math.max(at, getAt(g));
    }
    if (Object.keys(settings).length) {
      out.settings = settings;
      out.settingsAt = at;
    }
    return out;
  };

  function warn(msg) {
    if (pushWarned) return;
    pushWarned = true;
    toast(msg);
  }

  async function flush() {
    if (inflight) return;
    if (!user || merging || !ownMaster()) return;
    inflight = (async () => {
      try {
        const res = await api("PUT", "/api/me", snapshot());
        if (res.ok) {
          dirty = false;
          lastSyncAt = Date.now();
          pushWarned = false;
          return;
        }
        const detail = await res.json().catch(() => ({}));
        if (detail.error === "storage_not_configured") warn("云端存储还没配置好，收藏和设置先保存在这台设备");
        else if (res.status === 401) warn("登录已过期，请重新登录后再同步");
        else warn("同步失败（HTTP " + res.status + "），稍后自动重试");
      } catch {
        // 网络中断或页面卸载时保留 dirty，待下次恢复时补发
      } finally {
        inflight = null;
        refreshSync();
      }
    })();
    return inflight;
  }

  function mergeFavs(localMeta, localSet, remote, now) {
    const remoteMeta = { ...(remote?.favMeta || {}) };
    for (const id of remote?.favorites || []) if (!remoteMeta[id]) remoteMeta[id] = [0, 1];
    const merged = {};
    for (const id of new Set([...Object.keys(localMeta), ...localSet, ...Object.keys(remoteMeta)])) {
      const a = localMeta[id] || (localSet.has(id) ? [0, 1] : null);
      const b = remoteMeta[id] || null;
      const pick = !a ? b : !b ? a : b[0] > a[0] ? b : a;
      if (pick[1] === 0 && now - pick[0] > TOMBSTONE_TTL) continue;
      merged[id] = pick;
    }
    return { ids: Object.keys(merged).filter((id) => merged[id][1] === 1), meta: merged };
  }

  function merge(remote) {
    merging = true;
    const { ids, meta } = mergeFavs(state.favMeta, state.favorites, remote, Date.now());
    setFavorites(ids, meta);
    let appliedCards = false;
    for (const g of Object.keys(GROUPS)) {
      if (!on(g) || !remote?.settings) continue;
      const { keys, sort, cloud } = GROUPS[g];
      const remoteAt = Number(remote[cloud] ?? remote.settingsAt) || 0;
      const localAt = getAt(g);
      const useRemote = remoteAt > localAt || (remoteAt === 0 && localAt === 0 && !settingsDirty[g]);
      if (!useRemote) continue;
      const part = {};
      for (const k of keys) if (k in remote.settings) part[k] = remote.settings[k];
      setSettings(part);
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
    refreshSeen();
    merging = false;
    push();
  }

  async function syncNow() {
    if (!user || syncing || !ownMaster()) return;
    syncing = true;
    clearTimeout(timer);
    const b = $id("syncNowBtn");
    if (b) b.disabled = true;
    refreshSync();
    try {
      const res = await api("GET", "/api/me");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (!data.user) {
        user = null;
        setHint(false);
        renderAccount();
        toast("登录已过期，请重新登录");
        return;
      }
      pushWarned = false;
      merge(data.data);
      await flush();
      if (!dirty) toast("已同步");
      else if (!pushWarned) toast("还没同步上去，稍后会自动重试");
    } catch {
      toast("同步失败，请检查网络连接后重试");
    } finally {
      syncing = false;
      if (b) b.disabled = false;
      refreshSync();
    }
  }

  const push = () => {
    if (!ownMaster()) return;
    dirty = true;
    clearTimeout(timer);
    if (user && !merging) timer = setTimeout(flush, 400);
    refreshSync();
  };

  $id("syncNowBtn")?.addEventListener("click", syncNow);
  document.addEventListener("favs:change", push);
  document.addEventListener("settings:change", () => {
    let changed = false;
    for (const g of Object.keys(GROUPS)) {
      const cur = JSON.stringify(groupValues(g));
      if (cur === seen[g]) continue;
      seen[g] = cur;
      if (!on(g)) continue;
      settingsDirty[g] = true;
      setAt(g, Date.now());
      changed = true;
    }
    if (changed) push();
  });

  const leave = () => {
    if (dirty) {
      clearTimeout(timer);
      flush();
    }
  };
  window.addEventListener("pagehide", leave);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") leave();
    else if (dirty && user && !merging) {
      clearTimeout(timer);
      flush();
    }
  });

  $id("syncMasterSwitch")?.addEventListener("click", () => {
    const next = !ownMaster();
    lsSet(SYNC_KEYS.master, next ? "1" : "0");
    if (next) {
      for (const g of Object.keys(GROUPS)) {
        if (own(g)) {
          setAt(g, Date.now());
          settingsDirty[g] = true;
        }
      }
      renderAccount();
      syncNow();
    } else {
      clearTimeout(timer);
      dirty = false;
      renderAccount();
      toast("云端同步已关闭，收藏与设置仅保存在本地");
    }
  });

  for (const [g, id] of [["look", "syncLookSwitch"], ["cards", "syncCardsSwitch"]]) {
    $id(id)?.addEventListener("click", () => {
      if (!ownMaster()) return;
      const next = !own(g);
      lsSet(SYNC_KEYS[g], next ? "1" : "0");
      setSwitch($id(id), next);
      const label = GROUPS[g].label;
      if (next) {
        setAt(g, Date.now());
        settingsDirty[g] = true;
        push();
        toast(`已开启${label}同步，已将这台设备的${label}上传到云端`);
      } else {
        toast(`已关闭${label}同步，${label}只保存在这台设备`);
      }
    });
  }

  /* 退出登录的内联确认（借自 Bencho Confirm）：按钮自己变成确认，不弹窗、不挪位置。
     第一次点：文字滑成「确认退出」并变红，左边展开「取消」，按钮底部一条细线在 4 秒内烧尽，烧完自动恢复；第二次点才真正退出 */
  const ASK_MS = 4000;
  const logoutBtn = $id("logoutBtn");
  const logoutBox = $id("logoutConfirm");
  const logoutCancel = $id("logoutCancel");
  const logoutSwap = logoutBtn ? confirmable(logoutBtn, "确认退出") : null;
  let askTimer = 0;
  const asking = () => !!logoutBox?.hasAttribute("data-ask");
  function askLogout(on) {
    if (!logoutBox || !logoutSwap) return;
    clearTimeout(askTimer);
    logoutBox.toggleAttribute("data-ask", on);
    logoutCancel.tabIndex = on ? 0 : -1;
    logoutCancel.setAttribute("aria-hidden", String(!on));
    if (on) {
      logoutBtn.style.setProperty("--ask-ms", ASK_MS + "ms");
      logoutSwap.on(ASK_MS + 400);
      askTimer = setTimeout(() => askLogout(false), ASK_MS);
    } else {
      logoutSwap.off();
    }
  }
  logoutCancel?.addEventListener("click", () => askLogout(false));
  logoutBox?.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !asking()) return;
    e.preventDefault();
    e.stopPropagation();
    askLogout(false);
    logoutBtn.focus();
  });
  document.addEventListener("click", (e) => { if (asking() && !logoutBox.contains(e.target)) askLogout(false); });

  logoutBtn?.addEventListener("click", async () => {
    if (!asking()) { askLogout(true); return; }
    askLogout(false);
    clearTimeout(timer);
    try {
      const res = await api("POST", "/api/logout");
      if (!res.ok) throw new Error("HTTP " + res.status);
    } catch {
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
    toast("已退出登录，本地收藏与设置已保留");
  });

  async function initSession() {
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
      if (dirty && !timer) flush();
      refreshSync();
    } catch {
      renderAccount();
      $id("loginSub").textContent = "暂时连不上云端，收藏和设置先保存在这台设备上";
    }
  }

  refreshSeen();
  initSession();
}
