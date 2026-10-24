// POST /api/install：记一次安装点击。body：{ "id": "<插件 id>" }
// - 只接受清单里存在的插件 id
// - 同一个 IP 同一天对同一个插件只计一次（存加盐哈希，不存 IP）
// - 需要 D1 绑定 MLB_DB；没绑定时返回 501，前端会忽略
import manifest from "../../manifest.json";
import { json, sameOrigin } from "../_lib/auth.js";
import { ensureSchema, today } from "../_lib/stats-db.js";

const IDS = new Set((manifest.plugins || []).map((p) => String(p.id || p.file)));
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function onRequestPost({ request, env }) {
  // 浏览器发 POST 一定带 Origin；没有或不同源都不收
  if (!request.headers.get("Origin") || !sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const DB = env.MLB_DB;
  if (!DB) return json({ error: "stats_not_configured" }, 501);

  let id;
  try { ({ id } = await request.json()); } catch { return json({ error: "bad_json" }, 400); }
  if (typeof id !== "string" || !IDS.has(id)) return json({ error: "unknown_plugin" }, 400);

  const day = today();
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const salt = env.TURNSTILE_SECRET || env.SESSION_SECRET || "mlb";
  const h = hex(await crypto.subtle.digest("SHA-256", enc.encode(`${salt}|${ip}|${id}|${day}`)));

  try {
    await ensureSchema(DB);
    const seen = await DB.prepare("INSERT OR IGNORE INTO install_seen (h, day) VALUES (?, ?)").bind(h, day).run();
    if (!seen.meta.changes) return json({ ok: true, counted: false });
    await DB.prepare("INSERT INTO installs (id, day, n) VALUES (?, ?, 1) ON CONFLICT(id, day) DO UPDATE SET n = n + 1").bind(id, day).run();
    // 顺手清理前几天的去重记录（约每 50 次请求一次）
    if (Math.random() < 0.02) await DB.prepare("DELETE FROM install_seen WHERE day < ?").bind(day).run();
    return json({ ok: true, counted: true });
  } catch {
    return json({ error: "storage_error" }, 500);
  }
}
