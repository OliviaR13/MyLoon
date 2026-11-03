// 云端同步的 D1 存储。
//
// 为什么用 D1 而不是 KV：KV 是「先读、合并、再写回」，两个请求同时到达时会读到同一份旧数据，
// 后写的盖掉先写的，而且 KV 最终一致，别的机房可能一分钟内还读到旧值。
// 这里每个收藏一行、每组设置一行，写入是单条 SQL 的「较新者胜」upsert：
// 不需要先读，D1 对单条语句是原子的，所以不管两个请求谁先到谁后到，结果都一样。
//
// 需要 D1 绑定 MLB_DB（和安装统计共用同一个数据库）。表在第一次访问时自动创建。
// 第一次访问时，该用户在 KV 里的旧数据会自动迁移过来（需要 MLB_KV 还绑着；没有也没关系）。
import { SETTING_GROUPS } from "./sync-merge.js";

const TOMBSTONE_TTL = 90 * 24 * 3600 * 1000; // 「已取消」记录保留 90 天
export const MAX_FAVS = 400; // 每个用户的收藏记录（含已取消）上限

let ready = null;
const migrated = new Set(); // 本实例里已确认迁移过的用户，省一次查询

// 测试用：清掉「已建表 / 已迁移」的缓存（线上一个 D1 绑定从头到尾是同一个库，不需要）
export function resetSyncCache() {
  ready = null;
  migrated.clear();
}

export function ensureSyncSchema(DB) {
  if (!ready) {
    ready = DB.batch([
      // 收藏：一个插件一行。at 是最后修改时间，fav 1 已收藏 / 0 已取消
      DB.prepare("CREATE TABLE IF NOT EXISTS user_favs (uid TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, fav INTEGER NOT NULL, PRIMARY KEY (uid, id))"),
      // 设置：外观 / 插件卡片 / 设置页偏好三组，各一行，val 是该组的 JSON
      DB.prepare("CREATE TABLE IF NOT EXISTS user_settings (uid TEXT NOT NULL, grp TEXT NOT NULL, at INTEGER NOT NULL, val TEXT NOT NULL, PRIMARY KEY (uid, grp))"),
      // 有这一行 = 该用户已经处理过 KV 迁移；updated_at 为空 = 还没有任何云端数据
      DB.prepare("CREATE TABLE IF NOT EXISTS user_meta (uid TEXT PRIMARY KEY, updated_at INTEGER)"),
    ]).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

// 收藏：较新者胜；时间相同时「已收藏」胜（顺序无关，误丢收藏比误留收藏代价大）
const UPSERT_FAVS = `INSERT INTO user_favs (uid, id, at, fav)
  SELECT ?1, j.key, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]') FROM json_each(?2) AS j WHERE true
  ON CONFLICT(uid, id) DO UPDATE SET at = excluded.at, fav = excluded.fav
  WHERE excluded.at > user_favs.at OR (excluded.at = user_favs.at AND excluded.fav > user_favs.fav)`;

// 设置：这一组的新时间 >= 已有时间才采用；组内只覆盖新提交里带了的键
const UPSERT_GROUP = `INSERT INTO user_settings (uid, grp, at, val) VALUES (?1, ?2, ?3, ?4)
  ON CONFLICT(uid, grp) DO UPDATE SET at = excluded.at, val = json_patch(user_settings.val, excluded.val)
  WHERE excluded.at >= user_settings.at`;

function favStatements(DB, uid, favMeta) {
  return Object.keys(favMeta).length ? [DB.prepare(UPSERT_FAVS).bind(uid, JSON.stringify(favMeta))] : [];
}

// 把 clean() 之后的 settings 按组拆开。组时间的规则和 mergeSettings 一致：
// 带了值却没带时间的老客户端按 0（最旧）；这一组什么都没带就跳过。
function groupStatements(DB, uid, data) {
  const out = [];
  for (const [at, keys] of Object.entries(SETTING_GROUPS)) {
    const vals = {};
    for (const k of keys) if (data.settings && k in data.settings) vals[k] = data.settings[k];
    const hasValues = Object.keys(vals).length > 0;
    const nextAt = Number.isFinite(data[at]) ? data[at] : hasValues ? 0 : null;
    if (nextAt === null) continue;
    out.push(DB.prepare(UPSERT_GROUP).bind(uid, at, nextAt, JSON.stringify(vals)));
  }
  return out;
}

// 第一次访问时把 KV 里的旧数据搬过来。所有写入都是「较新者胜」，所以多个请求同时迁移、
// 或迁移和新的 PUT 交错，结果都一样。KV 里的原数据不动，留着当备份。
async function ensureMigrated(DB, KV, uid) {
  if (migrated.has(uid)) return;
  const row = await DB.prepare("SELECT 1 AS ok FROM user_meta WHERE uid = ?1").bind(uid).first();
  if (!row) {
    const prev = KV ? await KV.get(`u:${uid}`, "json") : null;
    const stmts = [];
    if (prev) {
      const favMeta = {};
      for (const id of prev.favorites || []) favMeta[id] = [0, 1];
      Object.assign(favMeta, prev.favMeta || {});
      const legacyAt = Number(prev.settingsAt) || 0;
      const asData = {
        settings: prev.settings || {},
        // 旧数据可能只有统一的 settingsAt：外观、卡片两组沿用它；设置页偏好是后加的，没有就是 0
        lookAt: Number(prev.lookAt ?? legacyAt) || 0,
        cardsAt: Number(prev.cardsAt ?? legacyAt) || 0,
        panelAt: Number(prev.panelAt) || 0,
      };
      stmts.push(...favStatements(DB, uid, favMeta), ...groupStatements(DB, uid, asData));
    }
    stmts.push(
      DB.prepare("INSERT OR IGNORE INTO user_meta (uid, updated_at) VALUES (?1, ?2)").bind(uid, prev ? Number(prev.updatedAt) || Date.now() : null)
    );
    await DB.batch(stmts);
  }
  migrated.add(uid);
}

// 读：返回和以前 KV 里一样形状的对象；该用户还没有任何云端数据时返回 null
export async function loadFromD1(DB, KV, uid) {
  await ensureSyncSchema(DB);
  await ensureMigrated(DB, KV, uid);
  const [favs, groups, meta] = await DB.batch([
    DB.prepare("SELECT id, at, fav FROM user_favs WHERE uid = ?1 ORDER BY at, id").bind(uid),
    DB.prepare("SELECT grp, at, val FROM user_settings WHERE uid = ?1").bind(uid),
    DB.prepare("SELECT updated_at FROM user_meta WHERE uid = ?1").bind(uid),
  ]);
  const updatedAt = meta.results[0]?.updated_at ?? null;
  if (updatedAt === null && !favs.results.length && !groups.results.length) return null;

  const favMeta = {};
  for (const r of favs.results) favMeta[r.id] = [r.at, r.fav];
  const settings = {};
  const ats = { lookAt: 0, cardsAt: 0, panelAt: 0 };
  for (const g of groups.results) {
    if (!(g.grp in ats)) continue;
    ats[g.grp] = g.at;
    try { Object.assign(settings, JSON.parse(g.val)); } catch { /* 坏数据跳过，不影响其余 */ }
  }
  return {
    favorites: Object.keys(favMeta).filter((id) => favMeta[id][1] === 1),
    favMeta,
    settings,
    settingsAt: Math.max(ats.lookAt, ats.cardsAt),
    ...ats,
    updatedAt: updatedAt ?? 0,
  };
}

// 写：data 是 clean() 之后的新提交。没有「先读再写」，每条语句各自按时间戳决定要不要生效
export async function saveToD1(DB, KV, uid, data, now = Date.now()) {
  await ensureSyncSchema(DB);
  await ensureMigrated(DB, KV, uid);

  let favMeta = data.favMeta;
  // 旧客户端只带 favorites（没有逐项时间）：把它当作「此刻的完整列表」，列表里没有的已收藏项记为取消
  if (!Object.keys(favMeta).length && data.favorites.length) {
    const cur = await DB.prepare("SELECT id FROM user_favs WHERE uid = ?1 AND fav = 1").bind(uid).all();
    favMeta = {};
    for (const r of cur.results) favMeta[r.id] = [now, 0];
    for (const id of data.favorites) favMeta[id] = [now, 1];
  }

  await DB.batch([
    ...favStatements(DB, uid, favMeta),
    ...groupStatements(DB, uid, data),
    // 清掉太旧的「已取消」记录，再把总数压回上限（先丢已取消的、最旧的）
    DB.prepare("DELETE FROM user_favs WHERE uid = ?1 AND fav = 0 AND at < ?2").bind(uid, now - TOMBSTONE_TTL),
    DB.prepare(
      `DELETE FROM user_favs WHERE uid = ?1 AND id IN (
         SELECT id FROM user_favs WHERE uid = ?1 ORDER BY fav ASC, at ASC
         LIMIT MAX(0, (SELECT COUNT(*) FROM user_favs WHERE uid = ?1) - ?2))`
    ).bind(uid, MAX_FAVS),
    DB.prepare("INSERT INTO user_meta (uid, updated_at) VALUES (?1, ?2) ON CONFLICT(uid) DO UPDATE SET updated_at = excluded.updated_at").bind(uid, data.updatedAt),
  ]);
}
