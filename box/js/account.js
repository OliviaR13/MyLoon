/* GitHub / Google / 通行密钥与云端同步（/api/me、/api/logout、/api/auth/google、/api/auth/passkey）：
   支持收藏逐项时间戳（Tombstone CRDT）合并，以及外观、插件卡片、设置页偏好三组独立时间戳同步。
   没配 Google 客户端或 PASSKEYS 时，对应按钮保持停用，浏览和安装不受影响。 */

import { conditionalPasskeyAvailable, loginPasskey, passkeySupported, registerPasskey } from "./passkey.js";

import { SYNC_KEYS, LEGACY_AT, TOMBSTONE_TTL, SORT_KEY, LOGIN_HINT_KEY } from "./config.js";
import { $id, setSwitch, lsGet, lsSet, lsRemove, confirmable } from "./dom.js";
import { validSort, state, getSettings, setSettings } from "./state.js";
import { toast } from "./toast.js";
import { render, setFavorites } from "./render.js";
import { syncSort } from "./search-sort.js";

const GROUPS = {
  look: { keys: ["theme", "reduceMotion"], at: "myloon_box_look_at", cloud: "lookAt", label: "外观" },
  cards: { keys: ["showDesc", "showVer", "showCat", "compact", "pinFavs"], sort: true, at: "myloon_box_cards_at", cloud: "cardsAt", label: "插件卡片设置" },
  panel: { keys: ["fullDefault"], at: "myloon_box_panel_at", cloud: "panelAt", label: "设置页偏好", noLegacy: true },
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
  let passkeyEnabled = false;
  let passkeyAbort = null;

  const setHint = (on) => (on ? lsSet(LOGIN_HINT_KEY, "1") : lsRemove(LOGIN_HINT_KEY));
  const ownMaster = () => lsGet(SYNC_KEYS.master) !== "0";
  const own = (g) => lsGet(SYNC_KEYS[g]) !== "0";
  if (lsGet(SYNC_KEYS.cards) === null) lsSet(SYNC_KEYS.cards, own("look") ? "1" : "0");
  const on = (g) => ownMaster() && own(g);

  const getAt = (g) => {
    const v = lsGet(GROUPS[g].at);
    return v !== null ? Number(v) || 0 : GROUPS[g].noLegacy ? 0 : Number(lsGet(LEGACY_AT)) || 0;
  };
  const setAt = (g, t) => lsSet(GROUPS[g].at, String(t));
  const settingsDirty = { look: false, cards: false, panel: false };

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

  function paintAvatar(img, letter, user) {
    if (!img || !letter) return;
    const label = (user.provider === "google" ? user.name || user.login : user.login) || "?";
    const src = user.provider === "google"
      ? (user.picture || "")
      : (user.login ? "https://github.com/" + encodeURIComponent(user.login) + ".png?size=64" : "");
    const showLetter = () => {
      img.hidden = true;
      img.removeAttribute("src");
      letter.hidden = false;
      letter.textContent = Array.from(String(label).trim())[0] || "?";
    };
    img.onerror = showLetter;
    if (!src) { showLetter(); return; }
    letter.hidden = true;
    img.hidden = false;
    img.referrerPolicy = "no-referrer";
    img.alt = "";
    img.src = src;
  }

  function renderAccount() {
    const m = ownMaster();
    $id("loginRow").hidden = !!user;
    $id("googleRow").hidden = !!user;
    const passkeyRow = $id("passkeyRow");
    if (passkeyRow) passkeyRow.hidden = !!user;
    const passkeySection = $id("passkeySection");
    if (passkeySection) passkeySection.hidden = !user || !passkeyEnabled;
    $id("accountRow").hidden = !user;
    const head = $id("headAcct");
    if (head) head.hidden = !user;
    $id("syncSection").hidden = !user;
    if (user) $id("loginSub").textContent = "登录后，收藏和设置可以在多台设备间同步";
    setSwitch($id("syncMasterSwitch"), m);
    $id("syncNowRow").hidden = !user || !m;
    $id("syncFavsRow").dataset.off = String(!m);
    $id("syncFavsState").textContent = m ? "始终同步" : "已暂停";
    for (const [g, id] of [["look", "syncLook"], ["cards", "syncCards"], ["panel", "syncPanel"]]) {
      $id(id + "Row").dataset.off = String(!m);
      const sw = $id(id + "Switch");
      setSwitch(sw, own(g));
      sw.disabled = !m;
    }
    $id("syncFoot").textContent = m
      ? "收藏会始终同步。外观、插件卡片和设置页偏好可以分别关闭，关闭后只保存在这台设备。如果多台设备修改了同一项，以最后一次修改为准。"
      : "云端同步已关闭：收藏和设置只保存在这台设备，不会上传，也不会读取云端的内容。";
    if (user) {
      const google = user.provider === "google";
      $id("acctName").textContent = google ? (user.name || user.login) : user.login;
      const meta = $id("acctMeta");
      if (meta) {
        meta.hidden = false;
        meta.textContent = google ? (user.email ? "Google · " + user.email : "Google") : "GitHub";
      }
      paintAvatar($id("acctAvatar"), $id("acctLetter"), user);
      paintAvatar($id("headAvatar"), $id("headLetter"), user);
      if (head) head.setAttribute("aria-label", "已登录：" + (google ? (user.name || user.email || "Google") : user.login) + "，打开账号设置");
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
      const remoteAt = Number(remote[cloud] ?? (GROUPS[g].noLegacy ? 0 : remote.settingsAt)) || 0;
      const localAt = getAt(g);
      const useRemote = remoteAt > localAt || (remoteAt === 0 && localAt === 0 && !settingsDirty[g]);
      if (!useRemote) continue;
      const part = {};
      for (const k of keys) if (k in remote.settings) part[k] = remote.settings[k];
      setSettings(part);
      if (sort) {
        const [key, dir] = String(remote.settings.sort || "").split(":");
        if (validSort(key, dir)) {
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

  for (const [g, id] of [["look", "syncLookSwitch"], ["cards", "syncCardsSwitch"], ["panel", "syncPanelSwitch"]]) {
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

  $id("googleBtn")?.addEventListener("click", () => {
    const btn = $id("googleBtn");
    if (!btn || btn.disabled) return;
    location.assign("/api/auth/google");
  });

  const passkeyToast = (err) => {
    if (!err || err.name === "NotAllowedError" || err.name === "AbortError") return;
    if (err.code === "passkeys_not_configured") return toast(err.detail || "通行密钥尚未配置，不影响浏览和安装");
    if (err.code === "too_many") return toast("最多添加 8 把通行密钥");
    toast("通行密钥没有通过，请重试");
  };

  async function refreshPasskeys() {
    const btn = $id("passkeyBtn");
    const sub = $id("passkeySub");
    const add = $id("passkeyAdd");
    try {
      const res = await api("GET", "/api/auth/passkey");
      const data = await res.json();
      passkeyEnabled = data.enabled === true;
      if (btn) btn.disabled = !passkeyEnabled || !passkeySupported();
      if (add) add.disabled = !passkeyEnabled || !passkeySupported();
      if (sub) {
        sub.textContent = !passkeyEnabled
          ? "尚未配置，不影响浏览和安装"
          : passkeySupported()
            ? "用已添加的通行密钥登录，无需输入账号"
            : "当前浏览器不支持通行密钥";
      }
      const list = $id("passkeyList");
      if (list) {
        list.replaceChildren();
        const creds = data.credentials || [];
        if (!creds.length) {
          const empty = document.createElement("div");
          empty.className = "row";
          empty.innerHTML = '<span class="row-text"><span>还没有通行密钥</span><span class="sub">添加后才能用通行密钥登录</span></span>';
          list.append(empty);
        }
        for (const c of creds) {
          const row = document.createElement("div");
          row.className = "row";
          const text = document.createElement("span");
          text.className = "row-text";
          const title = document.createElement("span");
          title.textContent = "通行密钥";
          const when = document.createElement("span");
          when.className = "sub";
          const at = Number(c.createdAt);
          when.textContent = Number.isFinite(at) && at > 0 ? "添加于 " + new Date(at).toLocaleDateString() : "已添加";
          text.append(title, when);
          const remove = document.createElement("button");
          remove.className = "btn btn-ghost";
          remove.type = "button";
          remove.textContent = "移除";
          remove.addEventListener("click", async () => {
            remove.disabled = true;
            try {
              const del = await fetch("/api/auth/passkey/" + encodeURIComponent(c.id), { method: "DELETE", credentials: "same-origin", headers: { accept: "application/json" } });
              if (!del.ok) throw new Error();
              toast("已移除这把通行密钥");
              await refreshPasskeys();
            } catch {
              remove.disabled = false;
              toast("移除失败，请重试");
            }
          });
          row.append(text, remove);
          list.append(row);
        }
      }
    } catch {
      passkeyEnabled = false;
      if (btn) btn.disabled = true;
      if (sub) sub.textContent = "暂时无法连接登录服务，不影响浏览和安装";
    }
    renderAccount();
    if (!user && passkeyEnabled) startConditional();
  }

  async function afterPasskeyLogin() {
    passkeyAbort?.abort();
    await pullSession();
    toast("已使用通行密钥登录");
  }

  async function startConditional() {
    if (user || !passkeyEnabled || !await conditionalPasskeyAvailable()) return;
    passkeyAbort?.abort();
    passkeyAbort = new AbortController();
    try {
      await loginPasskey({ mediation: "conditional", signal: passkeyAbort.signal });
      await afterPasskeyLogin();
    } catch (err) {
      if (err?.name === "AbortError" || err?.name === "NotAllowedError") return;
    }
  }

  $id("passkeyBtn")?.addEventListener("click", async () => {
    const btn = $id("passkeyBtn");
    if (!btn || btn.disabled) return;
    passkeyAbort?.abort();
    btn.disabled = true;
    try {
      await loginPasskey();
      await afterPasskeyLogin();
    } catch (err) {
      passkeyToast(err);
    } finally {
      btn.disabled = !passkeyEnabled || !passkeySupported();
    }
  });

  $id("passkeyAdd")?.addEventListener("click", async () => {
    const btn = $id("passkeyAdd");
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
      await registerPasskey();
      toast("已添加通行密钥");
      await refreshPasskeys();
    } catch (err) {
      passkeyToast(err);
    } finally {
      btn.disabled = !passkeyEnabled || !passkeySupported();
    }
  });
  $id("headAcct")?.addEventListener("click", () => $id("settingsBtn")?.click());

  async function loadGoogle() {
    const btn = $id("googleBtn");
    const sub = $id("googleSub");
    if (!btn || !sub) return;
    try {
      const res = await api("GET", "/api/auth/google");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const on = data.enabled === true;
      btn.disabled = !on;
      sub.textContent = on
        ? "使用 Google 账号登录，收藏和设置可以在多台设备间同步"
        : "尚未配置，不影响浏览和安装";
    } catch {
      btn.disabled = true;
      sub.textContent = "暂时无法连接登录服务，不影响浏览和安装";
    }
  }

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
    settingsDirty.look = settingsDirty.cards = settingsDirty.panel = false;
    lastSyncAt = 0;
    pushWarned = false;
    setHint(false);
    renderAccount();
    toast("已退出登录，本地收藏与设置已保留");
    refreshPasskeys();
  });

  async function initSession() {
    const q = new URLSearchParams(location.search);
    const err = q.get("login_error");
    const logged = q.get("login");
    if (err || logged) {
      if (err) {
        const msg = {
          denied: "这个 GitHub 账号没有登录权限",
          state: "登录已过期，请重试",
          config: "登录功能尚未配置",
          google_config: "Google 登录尚未配置，浏览和安装不受影响",
          google_state: "Google 登录已过期，请重试",
          google_denied: "已取消 Google 登录",
          google_exchange: "无法完成 Google 登录，请重试",
          google_verify: "Google 身份校验没有通过，请重试",
        }[err] || (String(err).startsWith("google") ? "Google 登录失败，请重试" : "GitHub 登录失败，请重试");
        toast(msg);
      } else if (logged === "google") {
        toast("已使用 Google 账号登录");
      }
      history.replaceState(null, "", location.pathname);
    }
    await pullSession();
  }

  async function pullSession() {
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
  loadGoogle();
  initSession().finally(() => refreshPasskeys());
}
