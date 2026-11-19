// 单台设备退出：把这张会话的 sid 放进作废名单，其他 sid 继续有效。
// 没绑 D1 / KV 时无法作废，检查直接跳过。存储出错则失败关闭。
import { authUnavailable } from "./auth-error.js";

const ready = new WeakMap();

function ensureTable(DB) {
  let pending = ready.get(DB);
  if (!pending) {
    pending = DB.prepare(
      "CREATE TABLE IF NOT EXISTS revoked_sessions (sid TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL)",
    ).run().catch((err) => {
      ready.delete(DB);
      throw err;
    });
    ready.set(DB, pending);
  }
  return pending;
}

function validSid(sid) {
  return typeof sid === "string" && /^[A-Za-z0-9-]{8,80}$/.test(sid);
}

function key(sid) {
  return "rsid:" + sid;
}

async function sweep(DB, now) {
  try {
    await DB.prepare("DELETE FROM revoked_sessions WHERE expires_at <= ?1").bind(now).run();
  } catch {
    /* 清理失败不影响这次判断 */
  }
}

export async function isSessionRevoked(env, sid) {
  if (!validSid(sid)) return false;
  if (!env?.MLB_DB && !env?.MLB_KV) return false;
  const now = Math.floor(Date.now() / 1000);
  try {
    if (env.MLB_DB) {
      await ensureTable(env.MLB_DB);
      const row = await env.MLB_DB.prepare("SELECT expires_at FROM revoked_sessions WHERE sid = ?1").bind(sid).first();
      await sweep(env.MLB_DB, now);
      return !!row && Number(row.expires_at) > now;
    }
    const raw = await env.MLB_KV.get(key(sid));
    return raw != null && raw !== "";
  } catch {
    throw authUnavailable();
  }
}

export async function revokeSession(env, sid, accountId, exp) {
  if (!validSid(sid)) return;
  if (!env?.MLB_DB && !env?.MLB_KV) return;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Math.max(Number(exp) || 0, now + 60);
  const ttl = Math.min(Math.max(60, expiresAt - now), 30 * 24 * 3600);
  try {
    if (env.MLB_DB) {
      await ensureTable(env.MLB_DB);
      await env.MLB_DB.prepare(
        "INSERT OR REPLACE INTO revoked_sessions (sid, account_id, expires_at) VALUES (?1, ?2, ?3)",
      ).bind(sid, String(accountId || ""), expiresAt).run();
      await sweep(env.MLB_DB, now);
      return;
    }
    await env.MLB_KV.put(key(sid), String(accountId || ""), { expirationTtl: ttl });
  } catch (err) {
    if (err?.code === "auth_unavailable") throw err;
    throw authUnavailable();
  }
}
