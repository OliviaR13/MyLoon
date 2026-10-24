// GET /api/stats：各插件的安装次数
// 返回 { enabled, total: { id: 总次数 }, week: { id: 最近 7 天（含今天）次数 } }
// 没绑定 D1（MLB_DB）或读取失败时 enabled 为 false，前端据此隐藏统计相关的界面
import { json } from "../_lib/auth.js";
import { ensureSchema, daysAgo } from "../_lib/stats-db.js";

export async function onRequestGet({ env }) {
  const DB = env.MLB_DB;
  if (!DB) return json({ enabled: false }, 200, { "cache-control": "public, max-age=300" });
  try {
    await ensureSchema(DB);
    const { results } = await DB
      .prepare("SELECT id, SUM(n) AS total, SUM(CASE WHEN day >= ? THEN n ELSE 0 END) AS week FROM installs GROUP BY id")
      .bind(daysAgo(6))
      .all();
    const total = {}, week = {};
    for (const r of results || []) {
      total[r.id] = r.total;
      if (r.week) week[r.id] = r.week;
    }
    return json({ enabled: true, total, week }, 200, { "cache-control": "public, max-age=60" });
  } catch {
    return json({ enabled: false }, 200, { "cache-control": "no-store" });
  }
}
