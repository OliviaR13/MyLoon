/* GitHub / Google / 通行密钥与云端同步（/api/me、/api/logout、/api/auth/google、/api/auth/passkey）：
   支持收藏逐项时间戳（Tombstone CRDT）合并，以及外观、插件卡片、设置页偏好三组独立时间戳同步。
   没配 Google 客户端或 PASSKEYS 时，对应按钮保持停用，浏览和安装不受影响。 */

import { loginPasskey, passkeySupported, registerPasskey } from "./passkey.js";

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
  let googleEnabled = false;
  let accountsConfigured = false;
  let linked = [];
  let passkeyCreds = [];
  let accountsState = "loading"; // loading | ok | error
  const SIGNED_OUT_SUB = "用 GitHub 账号登录";
  const ONLY_METHOD = "唯一的登录方式";

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
    const manage = $id("accountManage");
    if (manage) manage.hidden = !user;
    $id("accountRow").hidden = !user;
    const head = $id("headAcct");
    if (head) head.hidden = !user;
    $id("syncSection").hidden = !user;
    if (!user) $id("loginSub").textContent = SIGNED_OUT_SUB;
    const loginFoot = $id("loginFoot");
    if (loginFoot) loginFoot.hidden = !!user;
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
      ? "收藏会始终同步。外观、插件卡片和设置页偏好可以分别关闭，关闭后只保存在这台设备。多台设备改了同一项时，以最后一次修改为准。"
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
    if (err.code === "passkeys_not_configured") return toast("通行密钥暂未开放，不影响浏览和安装");
    if (err.code === "too_many") return toast("最多添加 8 把通行密钥");
    if (err.code === "rp_id") return toast("当前网址不支持通行密钥，请用正式域名访问");
    toast("通行密钥没有通过，请重试");
  };

  const fmtWhen = (t) => {
    const at = Number(t);
    if (!Number.isFinite(at) || at <= 0) return "已添加";
    try {
      return "添加于 " + new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return "添加于 " + new Date(at).toLocaleDateString();
    }
  };

  async function refreshPasskeys() {
    const btn = $id("passkeyBtn");
    const sub = $id("passkeySub");
    const add = $id("passkeyAdd");
    const addSub = $id("passkeyAddSub");
    try {
      const res = await api("GET", "/api/auth/passkey");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      passkeyEnabled = data.enabled === true;
      const supported = passkeySupported();
      passkeyCreds = data.credentials || [];
      const full = passkeyCreds.length >= 8;
      if (btn) btn.disabled = !passkeyEnabled || !supported;
      if (add) add.disabled = !passkeyEnabled || !supported || full;
      if (sub) {
        sub.textContent = !passkeyEnabled
          ? "暂未开放，不影响浏览和安装"
          : supported
            ? "用指纹、面容或锁屏密码登录，无需输入账号"
            : "当前浏览器不支持通行密钥";
      }
      if (addSub) {
        addSub.textContent = !supported
          ? "当前浏览器不支持通行密钥"
          : full
            ? "已添加 8 把，达到上限，请先移除不用的"
            : "用指纹、面容或锁屏密码登录这个账号";
      }
      const list = $id("passkeyList");
      if (list) {
        list.replaceChildren();
        const creds = passkeyCreds;
        const last = linked.length + creds.length <= 1;
        if (!creds.length) {
          const empty = document.createElement("div");
          empty.className = "row";
          empty.innerHTML = '<span class="row-text"><span>还没有通行密钥</span><span class="sub">添加后，下次可以直接用它登录</span></span>';
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
          when.textContent = fmtWhen(c.createdAt) + (last ? " · " + ONLY_METHOD : "");
          text.append(title, when);
          const remove = document.createElement("button");
          remove.className = "btn btn-ghost";
          remove.type = "button";
          remove.textContent = "移除";
          remove.disabled = !!user && last;
          if (remove.disabled) remove.title = "至少保留一种登录方式";
          remove.addEventListener("click", async () => {
            remove.disabled = true;
            try {
              const del = await fetch("/api/auth/passkey/" + encodeURIComponent(c.id), { method: "DELETE", credentials: "same-origin", headers: { accept: "application/json" } });
              const body = await del.json().catch(() => ({}));
              if (!del.ok) throw new Error(body.message || "");
              toast("已移除这把通行密钥");
              await refreshAccounts();
            } catch (err) {
              remove.disabled = false;
              toast(err.message || "移除失败，请重试");
            }
          });
          row.append(text, remove);
          list.append(row);
        }
      }
    } catch {
      passkeyEnabled = false;
      if (btn) btn.disabled = true;
      if (add) add.disabled = true;
      if (sub) sub.textContent = "暂时无法连接登录服务，不影响浏览和安装";
    }
    paintLinkRow("github", $id("linkGithubSub"), $id("linkGithubBtn"));
    paintLinkRow("google", $id("linkGoogleSub"), $id("linkGoogleBtn"));
    renderAccount();
  }

  async function afterPasskeyLogin() {
    await pullSession();
    await refreshAccounts();
    toast("已使用通行密钥登录");
  }

  $id("passkeyBtn")?.addEventListener("click", async () => {
    const btn = $id("passkeyBtn");
    if (!btn || btn.disabled) return;
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
      googleEnabled = on;
      btn.disabled = !on;
      sub.textContent = on ? "用 Google 账号登录" : "暂未开放，不影响浏览和安装";
    } catch {
      googleEnabled = false;
      btn.disabled = true;
      sub.textContent = "暂时无法连接登录服务，不影响浏览和安装";
    }
    paintLinkRow("google", $id("linkGoogleSub"), $id("linkGoogleBtn"));
  }

  logoutBtn?.addEventListener("click", async () => {
    if (!asking()) { askLogout(true); return; }
    askLogout(false);
    clearTimeout(timer);
    logoutBtn.disabled = true;
    // 400ms 防抖窗口里的最后几次改动，退出前先上传，免得云端少了它们（最多等 3 秒）
    if (dirty && ownMaster() && !merging) {
      const settle = async () => {
        if (inflight) await inflight;
        if (dirty) await flush();
      };
      await Promise.race([settle().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
    }
    try {
      const res = await api("POST", "/api/logout");
      if (!res.ok) throw new Error("HTTP " + res.status);
    } catch {
      logoutBtn.disabled = false;
      toast("退出失败，请检查网络后重试");
      return;
    }
    logoutBtn.disabled = false;
    user = null;
    linked = [];
    accountsConfigured = false;
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
      const pending = q.get("pending");
      if (err === "link_conflict" && pending) {
        openConflict(q.get("provider") === "google" ? "google" : "github", pending);
      } else if (err) {
        const msg = {
          denied: "该 GitHub 账号没有登录权限",
          state: "GitHub 登录已过期，请重试",
          config: "GitHub 登录暂未开放，浏览和安装不受影响",
          google_config: "Google 登录暂未开放，浏览和安装不受影响",
          google_state: "Google 登录已过期，请重试",
          google_denied: "已取消 Google 登录",
          google_exchange: "无法完成 Google 登录，请重试",
          google_verify: "Google 账号校验未通过，请重试",
          link_state: "绑定已过期，请重新操作",
          accounts_config: "暂时不能管理登录方式",
          storage: "暂时无法保存登录方式，请重试",
          link_conflict: q.get("provider") === "google" ? "该 Google 账号已绑定其他账号" : "该 GitHub 账号已绑定其他账号",
          already_linked: q.get("provider") === "google"
            ? "当前账号已绑定另一个 Google 账号，请先解绑再绑定新的"
            : "当前账号已绑定另一个 GitHub 账号，请先解绑再绑定新的",
        }[err] || (String(err).startsWith("google") ? "Google 登录失败，请重试" : "GitHub 登录失败，请重试");
        toast(msg);
      } else if (logged === "github") {
        toast("已使用 GitHub 账号登录");
      } else if (logged === "google") {
        toast("已使用 Google 账号登录");
      } else if (logged === "linked_google") {
        toast("已绑定 Google 账号");
      } else if (logged === "linked_github") {
        toast("已绑定 GitHub 账号");
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
      $id("loginSub").textContent = "暂时连不上云端，收藏和设置先保存在这台设备";
    }
  }

  function openConflict(provider, token) {
    const dialog = $id("conflictDialog");
    const text = $id("conflictText");
    const confirm = $id("conflictConfirm");
    const cancel = $id("conflictCancel");
    if (!dialog || !text || !confirm || !cancel || typeof dialog.showModal !== "function") {
      toast(provider === "google" ? "该 Google 账号已绑定其他账号" : "该 GitHub 账号已绑定其他账号");
      return;
    }
    const name = provider === "google" ? "Google" : "GitHub";
    text.textContent = "这个 " + name + " 账号已经属于另一个账号。继续的话，另一个账号会被注销，它的收藏、设置和通行密钥会被永久删除，这个 " + name + " 登录则转到当前账号。此操作无法撤销。";
    const close = () => { if (dialog.open) dialog.close(); };
    cancel.onclick = close;
    dialog.oncancel = (e) => { e.preventDefault(); close(); };
    confirm.onclick = async () => {
      confirm.disabled = true;
      try {
        const res = await fetch("/api/account/conflict", {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || "这次确认已经失效，请重新绑定");
        close();
        toast("已注销另一个账号，并完成绑定");
        await pullSession();
        await refreshAccounts();
      } catch (err) {
        confirm.disabled = false;
        toast(err.message || "这次确认已经失效，请重新绑定");
      }
    };
    confirm.disabled = false;
    dialog.showModal();
  }

  function paintLinkRow(kind, sub, btn) {
    if (!sub || !btn) return;
    const row = linked.find((item) => item.kind === kind);
    const last = linked.length + passkeyCreds.length <= 1;
    const unlink = !!row;
    btn.textContent = unlink ? "解绑" : "绑定";
    btn.dataset.mode = unlink ? "unlink" : "link";
    btn.title = "";
    if (accountsState !== "ok") {
      sub.textContent = accountsState === "loading" ? "正在读取…" : "暂时无法读取";
      btn.disabled = true;
      return;
    }
    if (row) {
      const who = kind === "github" ? (row.login || "已绑定") : (row.email || row.name || "已绑定");
      sub.textContent = last ? who + " · " + ONLY_METHOD : who;
    } else {
      sub.textContent = kind === "google" && !googleEnabled ? "暂未开放，不影响浏览和安装" : "未绑定";
    }
    btn.disabled = !accountsConfigured || (unlink ? last : kind === "google" && !googleEnabled);
    if (unlink && last) btn.title = "至少保留一种登录方式";
  }

  async function refreshAccounts() {
    const foot = $id("accountManageFoot");
    if (!user) {
      linked = [];
      accountsConfigured = false;
      accountsState = "loading";
      await refreshPasskeys();
      return;
    }
    try {
      const res = await api("GET", "/api/account");
      const data = await res.json();
      if (!res.ok) throw new Error();
      accountsConfigured = data.configured === true;
      linked = data.identities || [];
      accountsState = "ok";
      if (foot) {
        foot.textContent = accountsConfigured
          ? "绑定后，可以用其中任意一种方式登录同一个账号，收藏和设置保持不变。已被其他账号绑定的登录方式不会自动合并，转移前会请你确认。至少保留一种登录方式。"
          : "站点暂未开放登录方式管理，目前只能用当前方式登录。";
      }
    } catch {
      accountsConfigured = false;
      accountsState = "error";
      if (foot) foot.textContent = "暂时无法读取已绑定的登录方式，不影响浏览和安装。";
    }
    paintLinkRow("github", $id("linkGithubSub"), $id("linkGithubBtn"));
    paintLinkRow("google", $id("linkGoogleSub"), $id("linkGoogleBtn"));
    await refreshPasskeys();
  }

  async function unlink(kind) {
    const btn = $id(kind === "github" ? "linkGithubBtn" : "linkGoogleBtn");
    if (btn) btn.disabled = true;
    try {
      const res = await fetch("/api/account/identities/" + kind, { method: "DELETE", credentials: "same-origin", headers: { accept: "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || "解绑失败，请重试");
      toast(kind === "google" ? "已解绑 Google" : "已解绑 GitHub");
      await refreshAccounts();
    } catch (err) {
      toast(err.message || "解绑失败，请重试");
      await refreshAccounts();
    }
  }

  $id("linkGithubBtn")?.addEventListener("click", () => {
    const btn = $id("linkGithubBtn");
    if (!btn || btn.disabled) return;
    if (btn.dataset.mode === "unlink") { unlink("github"); return; }
    location.assign("/api/auth/login?intent=link");
  });
  $id("linkGoogleBtn")?.addEventListener("click", () => {
    const btn = $id("linkGoogleBtn");
    if (!btn || btn.disabled) return;
    if (btn.dataset.mode === "unlink") { unlink("google"); return; }
    location.assign("/api/auth/google?intent=link");
  });

  refreshSeen();
  loadGoogle();
  initSession().finally(() => refreshAccounts());
}
