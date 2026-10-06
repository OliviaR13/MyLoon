// GET /api/me：当前登录用户和云端数据；PUT /api/me：保存收藏和设置
// 需要 KV 绑定：MLB_KV（Pages 项目 → Settings → Bindings）
import { getSession, json, sameOrigin } from "../_lib/auth.js";

const MAX_BODY = 64 * 1024;
const TOMBSTONE_TTL = 90 * 24 * 3600 * 1000; // 「已取消」记录保留 90 天

// 只保留已知字段，限制数量和长度
function clean(d) {
  // favMeta：{ id: [时间戳, 1 已收藏 / 0 已取消] }，用于多设备合并
  const favMeta = {};
  const fm = d?.favMeta;
  if (fm && typeof fm === "object" && !Array.isArray(fm)) {
    for (const [id, v] of Object.entries(fm).slice(0, 400)) {
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
  const s = d?.settings || {};
  const settings = {};
  if (["system", "light", "dark"].includes(s.theme)) settings.theme = s.theme;
  for (const k of ["showDesc", "showVer", "showCat", "pinFavs", "compact", "reduceMotion"]) if (typeof s[k] === "boolean") settings[k] = s[k];
  if (typeof s.sort === "string" && /^(date|name):(asc|desc)$/.test(s.sort)) settings.sort = s.sort;
  return { favorites, favMeta, settings, settingsAt, updatedAt: Date.now() };
}

export async function onRequestGet({ request, env }) {
  const user = await getSession(request, env);
  if (!user) return json({ user: null });
  const data = env.MLB_KV ? await env.MLB_KV.get(`u:${user.id}`, "json") : null;
  return json({ user: { id: user.id, login: user.login }, data });
}

export async function onRequestPut({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const user = await getSession(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!env.MLB_KV) return json({ error: "storage_not_configured" }, 500);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: "too_large" }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
  const data = clean(body);
  // 没带 settings（这台设备关闭了「同步外观与显示」）：保留云端原有的设置，不被覆盖
  if (!body || typeof body.settings !== "object" || body.settings === null) {
    const prev = await env.MLB_KV.get(`u:${user.id}`, "json");
    data.settings = prev?.settings || {};
    data.settingsAt = prev?.settingsAt || 0;
  }
  await env.MLB_KV.put(`u:${user.id}`, JSON.stringify(data));
  return json({ ok: true, updatedAt: data.updatedAt });
}
