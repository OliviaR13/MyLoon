// 被确认注销的账号 ID。旧的登录 Cookie 仍然签名有效，但读到这里就不再算登录。
const ready = new WeakMap();

function ensureTable(DB) {
  let pending = ready.get(DB);
  if (!pending) {
    pending = DB.prepare("CREATE TABLE IF NOT EXISTS deleted_accounts (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)").run()
      .catch((err) => {
        ready.delete(DB);
        throw err;
      });
    ready.set(DB, pending);
  }
  return pending;
}

export async function isAccountDeleted(env, accountId) {
  const id = String(accountId || "");
  if (!id) return false;
  try {
    if (env?.MLB_DB) {
      await ensureTable(env.MLB_DB);
      const row = await env.MLB_DB.prepare("SELECT 1 AS ok FROM deleted_accounts WHERE id = ?1").bind(id).first();
      return !!row;
    }
    if (env?.MLB_KV) {
      const raw = await env.MLB_KV.get("dead:" + id);
      return raw != null && raw !== "";
    }
  } catch {
    return false;
  }
  return false;
}

export async function markAccountDeleted(env, accountId) {
  const id = String(accountId || "");
  if (!id) return;
  if (env?.MLB_DB) {
    await ensureTable(env.MLB_DB);
    await env.MLB_DB.prepare("INSERT OR REPLACE INTO deleted_accounts (id, deleted_at) VALUES (?1, ?2)").bind(id, Date.now()).run();
    return;
  }
  if (env?.MLB_KV) await env.MLB_KV.put("dead:" + id, String(Date.now()));
}
