// 每个账号一个会话代数。新 Cookie 带上 sv；代数被抬高之后，更旧的 Cookie（包括没有 sv 的）全部失效。
// 没绑 D1 / KV 时无法作废，代数当作 0，旧 Cookie 继续有效。
import { authUnavailable } from "./auth-error.js";

const ready = new WeakMap();

function ensureTable(DB) {
  let pending = ready.get(DB);
  if (!pending) {
    pending = DB.prepare(
      "CREATE TABLE IF NOT EXISTS session_epochs (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL)",
    ).run().catch((err) => {
      ready.delete(DB);
      throw err;
    });
    ready.set(DB, pending);
  }
  return pending;
}

function key(id) {
  return "epoch:" + id;
}

export function epochAllows(user, epoch) {
  const current = Number(epoch) || 0;
  if (user?.sv == null) return current === 0;
  return Number(user.sv) === current;
}

export async function currentEpoch(env, accountId) {
  const id = String(accountId || "");
  if (!id) return 0;
  try {
    if (env?.MLB_DB) {
      await ensureTable(env.MLB_DB);
      const row = await env.MLB_DB.prepare("SELECT epoch FROM session_epochs WHERE id = ?1").bind(id).first();
      return Number(row?.epoch) || 0;
    }
    if (env?.MLB_KV) {
      const raw = await env.MLB_KV.get(key(id));
      return Number(raw) || 0;
    }
  } catch {
    throw authUnavailable();
  }
  return 0;
}

export async function bumpEpoch(env, accountId) {
  const id = String(accountId || "");
  if (!id) return 0;
  try {
    if (env?.MLB_DB) {
      const DB = env.MLB_DB;
      await ensureTable(DB);
      const out = await DB.prepare(
        `INSERT INTO session_epochs (id, epoch) VALUES (?1, 1)
         ON CONFLICT(id) DO UPDATE SET epoch = epoch + 1
         RETURNING epoch`,
      ).bind(id).all();
      return Number(out.results?.[0]?.epoch) || 1;
    }
    if (env?.MLB_KV) {
      const next = (Number(await env.MLB_KV.get(key(id))) || 0) + 1;
      await env.MLB_KV.put(key(id), String(next));
      return next;
    }
  } catch (err) {
    if (err?.code === "auth_unavailable") throw err;
    throw authUnavailable();
  }
  return 0;
}
