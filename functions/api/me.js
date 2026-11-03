// GET /api/me：当前登录用户和云端数据；PUT /api/me：保存收藏和设置
// 存储：优先 D1（绑定 MLB_DB，逐行「较新者胜」写入，并发安全）；没绑 D1 时退回 KV（绑定 MLB_KV）。
// 两个都没绑时同步功能不可用，收藏和设置只保存在本机。
import { getSession, json, sameOrigin } from "../_lib/auth.js";
import { mergeFavMeta, mergeSettings } from "../_lib/sync-merge.js";
import { loadFromD1, saveToD1, MAX_FAVS } from "../_lib/sync-store.js";

const MAX_BODY = 64 * 1024;
const TOMBSTONE_TTL = 90 * 24 * 3600 * 1000; // 「已取消」记录保留 90 天

// 只保留已知字段，限制数量和长度
function clean(d) {
  // favMeta：{ id: [时间戳, 1 已收藏 / 0 已取消] }，用于多设备合并
  const favMeta = {};
  const fm = d?.favMeta;
  if (fm && typeof fm === "object" && !Array.isArray(fm)) {
    for (const [id, v] of Object.entries(fm).slice(0, MAX_FAVS)) {
      if (id.length > 0 && id.length <= 80 && Array.isArray(v) && Number.isFinite(v[0]) && (v[1] === 0 || v[1] === 1)) {
        if (v[1] === 0 && Date.now() - v[0] > TOMBSTONE_TTL) continue; // 太旧的取消记录不再保存
        favMeta[id] = [Math.floor(v[0]), v[1]];
      }
    }
  }
  // 有 favMeta 时，favorites 由它推出，保证两者一致；否则沿用旧格式
  const favorites = Object.keys(favMeta).length
    ? Object.keys(favMeta).filter((id) => favMeta[id][1] === 1)
    : Array.isArray(d?.favorites)
      ? [...new Set(d.favorites.filter((x) => typeof x === "string" && x.length > 0 && x.length <= 80))].slice(0, 300)
      : [];
  const settingsAt = Number.isFinite(d?.settingsAt) ? Math.floor(d.settingsAt) : 0;
  // 外观 / 插件卡片设置各有各的「最后修改时间」。只有旧客户端（两个都没带）才用统一的 settingsAt 顶替；
  // 新客户端只带它开着同步的那一组，没带的那组 null，由 PUT 里保留云端原值。
  const hasGroupAt = Number.isFinite(d?.lookAt) || Number.isFinite(d?.cardsAt);
  const legacyAt = !hasGroupAt && Number.isFinite(d?.settingsAt) ? settingsAt : null;
  const lookAt = Number.isFinite(d?.lookAt) ? Math.floor(d.lookAt) : legacyAt;
  const cardsAt = Number.isFinite(d?.cardsAt) ? Math.floor(d.cardsAt) : legacyAt;
  // 设置页选项是后加的一组，旧客户端和旧数据都没有它：没带就是 null（PUT 里保留云端原值），不用统一时间戳顶替
  const panelAt = Number.isFinite(d?.panelAt) ? Math.floor(d.panelAt) : null;
  const s = d?.settings || {};
  const settings = {};
  if (["system", "light", "dark"].includes(s.theme)) settings.theme = s.theme;
  for (const k of ["showDesc", "showVer", "showCat", "pinFavs", "compact", "reduceMotion", "fullDefault"]) if (typeof s[k] === "boolean") settings[k] = s[k];
  if (typeof s.sort === "string" && /^((date|name):(asc|desc)|(week|total):desc)$/.test(s.sort)) settings.sort = s.sort;
  return { favorites, favMeta, settings, settingsAt, lookAt, cardsAt, panelAt, updatedAt: Date.now() };
}

export async function onRequestGet({ request, env }) {
  const user = await getSession(request, env);
  if (!user) return json({ user: null });
  let data = null;
  try {
    if (env.MLB_DB) data = await loadFromD1(env.MLB_DB, env.MLB_KV, String(user.id));
    else if (env.MLB_KV) data = await env.MLB_KV.get(`u:${user.id}`, "json");
  } catch {
    return json({ error: "storage_error" }, 500);
  }
  return json({ user: { id: user.id, login: user.login }, data });
}

export async function onRequestPut({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const user = await getSession(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!env.MLB_DB && !env.MLB_KV) return json({ error: "storage_not_configured" }, 500);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: "too_large" }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
  const data = clean(body);
  if (env.MLB_DB) {
    try {
      await saveToD1(env.MLB_DB, env.MLB_KV, String(user.id), data);
    } catch {
      return json({ error: "storage_error" }, 500);
    }
    return json({ ok: true, updatedAt: data.updatedAt });
  }
  // ---- 没绑 D1：退回 KV（先读后写，两个请求同时到达时仍可能互相覆盖，所以推荐绑定 D1）----
  // 和云端已有的数据按条目合并（较新者胜），而不是整份覆盖：
  // 两台设备先后提交时，旧快照盖不掉另一台刚做的收藏或设置。
  // 客户端可能只带其中一组设置（另一组关闭了同步）：没带的那组保留云端原值。
  // KV 没有原子的「比较后写入」，而且最终一致（别的机房可能一分钟内还读到旧值）：
  // 两个请求同时到达时，后写的仍可能盖掉先写的。客户端每次同步都会先合并再推送，
  // 漏掉的改动通常下次同步能补回来，但要彻底避免只能用 D1。
  const prev = await env.MLB_KV.get(`u:${user.id}`, "json");
  // 带了 favMeta 才合并；没带（旧客户端）仍按它提交的 favorites 整份替换，这样旧客户端才能取消收藏
  if (Object.keys(data.favMeta).length) {
    const prevMeta = { ...(prev?.favMeta || {}) };
    for (const id of prev?.favorites || []) if (!prevMeta[id]) prevMeta[id] = [0, 1];
    data.favMeta = mergeFavMeta(prevMeta, data.favMeta, Date.now(), TOMBSTONE_TTL, MAX_FAVS);
    data.favorites = Object.keys(data.favMeta).filter((id) => data.favMeta[id][1] === 1);
  }
  const m = mergeSettings(prev, data);
  data.settings = m.settings;
  data.lookAt = m.lookAt;
  data.cardsAt = m.cardsAt;
  data.panelAt = m.panelAt;
  data.settingsAt = Math.max(data.settingsAt, data.lookAt || 0, data.cardsAt || 0);
  await env.MLB_KV.put(`u:${user.id}`, JSON.stringify(data));
  return json({ ok: true, updatedAt: data.updatedAt });
}
