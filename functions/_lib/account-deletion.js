// 账号注销冷静期。申请记在 D1，14 天后由定时任务或登录时的到期检查永久删除。
// 没有 MLB_DB 时这个功能失败关闭。时间用 Unix 毫秒，和 deleted_accounts.deleted_at、同步数据一致。
//
// 关联数据（清账号时都要处理，且只能按这一个 user_id / account_id）：
//   D1  accounts.id
//       identities.account_id
//       pending_conflicts.account_id / other_account_id
//       user_favs.uid、user_settings.uid、user_meta.uid
//       passkey_challenges.user_id
//       passkey_credential_claims.user_id
//       revoked_sessions.account_id
//       session_epochs.id
//       deletion_tickets.user_id
//       account_deletions.user_id（完成后保留一段时间再删）
//   KV  PASSKEYS  user:<id>、cred:<credentialId>
//       MLB_KV    u:<id>、acct:<id>、acct:id:<kind>:<subject>、epoch:<id>
//                 rsid:<sid>（值等于这个账号时才删）
//   保留  deleted_accounts / MLB_KV dead:<id>：旧 Cookie 必须继续失效，只存账号 ID 和时间，没有个人资料。
//
// 清账号必须同时有 MLB_DB、PASSKEYS、MLB_KV。通行密钥和云端同步都会写进这两个 KV，
// 绑定不在就不能证明已经删干净，所以不能跳过再标 completed。
// 顺序：先删 KV 里的记录，再删指向它们的索引；D1 的 passkey_credential_claims 最后删，
// 这样中途失败下次还能找到要删的 cred:<id>。
import { authUnavailable } from "./auth-error.js";
import { clearCookie, cookie, getCookie, seal, unseal } from "./auth.js";
import { markAccountDeleted } from "./account-tomb.js";
import { bumpEpoch } from "./session-epoch.js";

export const DELETION_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
export const REAUTH_WINDOW_SEC = 10 * 60;
export const TICKET_TTL_SEC = 10 * 60;
const PURGE_LEASE_MS = 5 * 60 * 1000;
const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const ready = new WeakMap();

function httpError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function requireDb(env) {
  if (!env?.MLB_DB) throw httpError("deletion_d1_required");
  return env.MLB_DB;
}

function bindingError(name) {
  const err = new Error("missing_binding:" + name);
  err.code = "missing_binding";
  return err;
}

// 启动和每次清除都用这一份。PASSKEYS 和 MLB_KV 不是可选项：
// 没绑就无法知道这个账号有没有通行密钥或旧的 KV 同步数据。
export function missingPurgeBindings(env) {
  const missing = [];
  if (!env?.MLB_DB || typeof env.MLB_DB.prepare !== "function") missing.push("MLB_DB");
  const passkeys = env?.PASSKEYS;
  if (!passkeys || typeof passkeys.get !== "function" || typeof passkeys.delete !== "function") missing.push("PASSKEYS");
  const kv = env?.MLB_KV;
  if (!kv || typeof kv.get !== "function" || typeof kv.delete !== "function" || typeof kv.list !== "function") missing.push("MLB_KV");
  return missing;
}

function assertPurgeBindings(env) {
  const missing = missingPurgeBindings(env);
  if (missing.includes("MLB_DB")) throw httpError("deletion_d1_required");
  if (missing.length) throw bindingError(missing[0]);
}

export function ensureDeletionSchema(DB) {
  let pending = ready.get(DB);
  if (!pending) {
    pending = DB.batch([
      DB.prepare(`CREATE TABLE IF NOT EXISTS account_deletions (
        user_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        requested_at INTEGER,
        scheduled_at INTEGER,
        cancelled_at INTEGER,
        completed_at INTEGER,
        lease_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`),
      DB.prepare("CREATE INDEX IF NOT EXISTS account_deletions_due ON account_deletions (status, scheduled_at)"),
      DB.prepare(`CREATE TABLE IF NOT EXISTS deletion_tickets (
        jti TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        exp INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`),
    ]).catch((err) => {
      ready.delete(DB);
      throw err;
    });
    ready.set(DB, pending);
  }
  return pending;
}

async function rowOf(DB, userId) {
  await ensureDeletionSchema(DB);
  return DB.prepare(
    "SELECT user_id, status, requested_at, scheduled_at, cancelled_at, completed_at, lease_until, updated_at FROM account_deletions WHERE user_id = ?1",
  ).bind(String(userId)).first();
}

export function reauthFresh(user, nowSec = Math.floor(Date.now() / 1000)) {
  const ra = Number(user?.ra);
  return Number.isFinite(ra) && nowSec >= ra && nowSec - ra <= REAUTH_WINDOW_SEC;
}

export async function isAccountBlocked(env, accountId) {
  const id = String(accountId || "");
  if (!id || !env?.MLB_DB) return false;
  try {
    const row = await rowOf(env.MLB_DB, id);
    return row?.status === "pending" || row?.status === "purging";
  } catch (err) {
    if (err?.code === "auth_unavailable") throw err;
    throw authUnavailable();
  }
}

export async function requestDeletion(env, userId, now = Date.now()) {
  const DB = requireDb(env);
  const id = String(userId || "");
  if (!id) throw httpError("unauthorized");
  await ensureDeletionSchema(DB);
  const scheduled = now + DELETION_GRACE_MS;
  const out = await DB.prepare(
    `INSERT INTO account_deletions (user_id, status, requested_at, scheduled_at, cancelled_at, completed_at, lease_until, updated_at)
     VALUES (?1, 'pending', ?2, ?3, NULL, NULL, 0, ?2)
     ON CONFLICT(user_id) DO UPDATE SET
       status = 'pending',
       requested_at = excluded.requested_at,
       scheduled_at = excluded.scheduled_at,
       cancelled_at = NULL,
       completed_at = NULL,
       lease_until = 0,
       updated_at = excluded.updated_at
     WHERE account_deletions.status = 'cancelled'
     RETURNING user_id, requested_at, scheduled_at, status`,
  ).bind(id, now, scheduled).all();
  if (out.results?.length) {
    await bumpEpoch(env, id);
    return publicRow(out.results[0], now);
  }
  const row = await rowOf(DB, id);
  if (row?.status === "pending") throw httpError("already_pending");
  if (row?.status === "purging") throw httpError("deletion_in_progress");
  if (row?.status === "completed") throw httpError("account_deleted");
  throw httpError("storage_error");
}

export async function cancelDeletion(env, userId, now = Date.now()) {
  const DB = requireDb(env);
  const id = String(userId || "");
  await ensureDeletionSchema(DB);
  const out = await DB.prepare(
    `UPDATE account_deletions
     SET status = 'cancelled', requested_at = NULL, scheduled_at = NULL,
         cancelled_at = ?2, lease_until = 0, updated_at = ?2
     WHERE user_id = ?1 AND status = 'pending'
     RETURNING user_id`,
  ).bind(id, now).all();
  if (!out.results?.length) {
    const row = await rowOf(DB, id);
    if (row?.status === "purging" || row?.status === "completed") throw httpError("deletion_in_progress");
    throw httpError("not_pending");
  }
  return true;
}

// 票据删除和状态更新在同一次 batch（一个事务）里。
// 先改 pending 行；changes() 仍是这次 UPDATE 的行数时才删票据。
// 行不是 pending 时两条都不生效，票据还在。正在 purging 的行不会被取消。
export async function cancelWithTicket(env, ticket, now = Date.now()) {
  const DB = requireDb(env);
  const id = String(ticket?.accountId || "");
  const jti = String(ticket?.jti || "");
  if (!id || !jti) throw httpError("not_pending");
  await ensureDeletionSchema(DB);
  const nowSec = Math.floor(now / 1000);
  const [updated] = await DB.batch([
    DB.prepare(
      `UPDATE account_deletions
       SET status = 'cancelled', requested_at = NULL, scheduled_at = NULL,
           cancelled_at = ?2, lease_until = 0, updated_at = ?2
       WHERE user_id = ?1 AND status = 'pending'
         AND EXISTS (
           SELECT 1 FROM deletion_tickets WHERE jti = ?3 AND user_id = ?1 AND exp >= ?4
         )
       RETURNING user_id`,
    ).bind(id, now, jti, nowSec),
    DB.prepare(
      `DELETE FROM deletion_tickets
       WHERE jti = ?3 AND user_id = ?1 AND exp >= ?4 AND (SELECT changes()) = 1
       RETURNING user_id`,
    ).bind(id, now, jti, nowSec),
  ]);
  if (!updated.results?.length) {
    const row = await rowOf(DB, id);
    if (row?.status === "purging" || row?.status === "completed") throw httpError("deletion_in_progress");
    throw httpError("not_pending");
  }
  return true;
}

function publicRow(row, now) {
  const scheduledAt = Number(row.scheduled_at);
  const remainingMs = Math.max(0, scheduledAt - now);
  return {
    status: row.status,
    requestedAt: Number(row.requested_at),
    scheduledAt,
    cancelledAt: row.cancelled_at == null ? null : Number(row.cancelled_at),
    remainingDays: Math.ceil(remainingMs / DAY_MS),
  };
}

export async function deletionStatus(env, userId, now = Date.now()) {
  const DB = requireDb(env);
  const row = await rowOf(DB, userId);
  if (!row || row.status !== "pending") return null;
  if (Number(row.scheduled_at) <= now) return { due: true };
  return publicRow(row, now);
}

async function claimPurge(DB, userId, now) {
  await ensureDeletionSchema(DB);
  const out = await DB.prepare(
    `UPDATE account_deletions
     SET status = 'purging', lease_until = ?3, updated_at = ?2
     WHERE user_id = ?1 AND (
       (status = 'pending' AND scheduled_at <= ?2) OR
       (status = 'purging' AND lease_until <= ?2)
     )
     RETURNING user_id`,
  ).bind(String(userId), now, now + PURGE_LEASE_MS).all();
  return !!out.results?.length;
}

async function markCompleted(DB, userId, now) {
  const out = await DB.prepare(
    `UPDATE account_deletions
     SET status = 'completed', completed_at = ?2, lease_until = 0, updated_at = ?2
     WHERE user_id = ?1 AND status = 'purging'
     RETURNING user_id`,
  ).bind(String(userId), now).all();
  return !!out.results?.length;
}

async function deleteRevokedKv(kv, accountId) {
  let cursor;
  do {
    const page = await kv.list({ prefix: "rsid:", cursor });
    for (const item of page.keys || []) {
      const value = await kv.get(item.name);
      if (value != null && String(value) === String(accountId)) await kv.delete(item.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

function idsFromIndex(raw) {
  if (raw == null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string" && id) : [];
  } catch {
    return [];
  }
}

async function claimCredentialIds(DB, accountId) {
  await DB.prepare(
    "CREATE TABLE IF NOT EXISTS passkey_credential_claims (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
  ).run();
  const out = await DB.prepare(
    "SELECT credential_id FROM passkey_credential_claims WHERE user_id = ?1",
  ).bind(accountId).all();
  return (out.results || []).map((row) => row.credential_id).filter((id) => typeof id === "string" && id);
}

// 不调用 deleteCredential：那条路径会先删 D1 占位。这里必须先删 KV，占位留到 deleteD1Rows。
async function deletePasskeys(env, accountId) {
  const kv = env.PASSKEYS;
  const fromIndex = idsFromIndex(await kv.get("user:" + accountId));
  const fromClaims = await claimCredentialIds(env.MLB_DB, accountId);
  const ids = [...new Set([...fromIndex, ...fromClaims])];
  const owned = [];
  for (const id of ids) {
    const raw = await kv.get("cred:" + id);
    if (raw == null || raw === "") continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      throw new Error("passkey_record_unreadable");
    }
    if (record && String(record.userId) === String(accountId)) owned.push(id);
  }
  for (const id of owned) await kv.delete("cred:" + id);
  await kv.delete("user:" + accountId);
}

async function pointerSubjects(env, accountId) {
  const kv = env.MLB_KV;
  const subjects = [];
  const raw = await kv.get("acct:" + accountId);
  let parsed = null;
  if (raw != null && raw !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }
  const identities = parsed?.identities;
  if (identities && typeof identities === "object") {
    for (const [kind, profile] of Object.entries(identities)) {
      if (profile?.subject) subjects.push([kind, String(profile.subject)]);
    }
  }
  await env.MLB_DB.prepare(
    `CREATE TABLE IF NOT EXISTS identities (
      kind TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
      picture TEXT NOT NULL DEFAULT '', linked_at INTEGER NOT NULL, PRIMARY KEY (kind, subject))`,
  ).run();
  const rows = await env.MLB_DB.prepare(
    "SELECT kind, subject FROM identities WHERE account_id = ?1",
  ).bind(accountId).all();
  for (const row of rows.results || []) {
    if (row?.kind && row?.subject) subjects.push([String(row.kind), String(row.subject)]);
  }
  if (parsed === undefined && !(rows.results || []).length) throw new Error("acct_unreadable");
  return subjects;
}

async function deleteSyncedKv(env, accountId) {
  const kv = env.MLB_KV;
  const subjects = await pointerSubjects(env, accountId);
  for (const [kind, subject] of subjects) {
    const value = await kv.get(`acct:id:${kind}:${subject}`);
    if (value != null && String(value) === String(accountId)) await kv.delete(`acct:id:${kind}:${subject}`);
  }
  await kv.delete("u:" + accountId);
  await kv.delete("epoch:" + accountId);
  await deleteRevokedKv(kv, accountId);
  await kv.delete("acct:" + accountId);
}

async function deleteD1Rows(DB, accountId) {
  await DB.batch([
    DB.prepare("CREATE TABLE IF NOT EXISTS user_favs (uid TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, fav INTEGER NOT NULL, PRIMARY KEY (uid, id))"),
    DB.prepare("CREATE TABLE IF NOT EXISTS user_settings (uid TEXT NOT NULL, grp TEXT NOT NULL, at INTEGER NOT NULL, val TEXT NOT NULL, PRIMARY KEY (uid, grp))"),
    DB.prepare("CREATE TABLE IF NOT EXISTS user_meta (uid TEXT PRIMARY KEY, updated_at INTEGER)"),
    DB.prepare("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)"),
    DB.prepare("CREATE TABLE IF NOT EXISTS identities (kind TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', picture TEXT NOT NULL DEFAULT '', linked_at INTEGER NOT NULL, PRIMARY KEY (kind, subject))"),
    DB.prepare("CREATE TABLE IF NOT EXISTS pending_conflicts (jti TEXT PRIMARY KEY, account_id TEXT NOT NULL, other_account_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', picture TEXT NOT NULL DEFAULT '', exp INTEGER NOT NULL)"),
    DB.prepare("CREATE TABLE IF NOT EXISTS passkey_challenges (challenge TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', exp INTEGER NOT NULL)"),
    DB.prepare("CREATE TABLE IF NOT EXISTS passkey_credential_claims (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    DB.prepare("CREATE TABLE IF NOT EXISTS revoked_sessions (sid TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL)"),
    DB.prepare("CREATE TABLE IF NOT EXISTS session_epochs (id TEXT PRIMARY KEY, epoch INTEGER NOT NULL)"),
  ]);
  await DB.batch([
    DB.prepare("DELETE FROM user_favs WHERE uid = ?1").bind(accountId),
    DB.prepare("DELETE FROM user_settings WHERE uid = ?1").bind(accountId),
    DB.prepare("DELETE FROM user_meta WHERE uid = ?1").bind(accountId),
    DB.prepare("DELETE FROM identities WHERE account_id = ?1").bind(accountId),
    DB.prepare("DELETE FROM accounts WHERE id = ?1").bind(accountId),
    DB.prepare("DELETE FROM pending_conflicts WHERE account_id = ?1 OR other_account_id = ?1").bind(accountId),
    DB.prepare("DELETE FROM passkey_challenges WHERE user_id = ?1").bind(accountId),
    DB.prepare("DELETE FROM passkey_credential_claims WHERE user_id = ?1").bind(accountId),
    DB.prepare("DELETE FROM revoked_sessions WHERE account_id = ?1").bind(accountId),
    DB.prepare("DELETE FROM session_epochs WHERE id = ?1").bind(accountId),
    DB.prepare("DELETE FROM deletion_tickets WHERE user_id = ?1").bind(accountId),
  ]);
}

// 认领之后才检查绑定。缺绑定或任何一步抛错都停在 purging，不标 completed。
// KV 记录先于它的索引删除；passkey_credential_claims 在 deleteD1Rows 里最后删。
export async function purgeAccount(env, userId, now = Date.now()) {
  const DB = requireDb(env);
  const id = String(userId || "");
  if (!id) return false;
  if (!(await claimPurge(DB, id, now))) return false;
  assertPurgeBindings(env);
  await deletePasskeys(env, id);
  await deleteSyncedKv(env, id);
  await deleteD1Rows(DB, id);
  await markAccountDeleted(env, id);
  return markCompleted(DB, id, Date.now());
}

export async function purgeDueAccounts(env, now = Date.now()) {
  const DB = requireDb(env);
  await ensureDeletionSchema(DB);
  const nowSec = Math.floor(now / 1000);
  await DB.prepare("DELETE FROM deletion_tickets WHERE exp < ?1").bind(nowSec).run();
  await DB.prepare(
    "DELETE FROM account_deletions WHERE status IN ('cancelled', 'completed') AND updated_at < ?1",
  ).bind(now - AUDIT_RETENTION_MS).run();
  const due = await DB.prepare(
    `SELECT user_id FROM account_deletions
     WHERE (status = 'pending' AND scheduled_at <= ?1)
        OR (status = 'purging' AND lease_until <= ?1)
     LIMIT 50`,
  ).bind(now).all();
  let purged = 0;
  for (const row of due.results || []) {
    try {
      if (await purgeAccount(env, row.user_id, now)) purged += 1;
    } catch (err) {
      console.error("account_purge", err?.message || "error");
    }
  }
  return purged;
}

export async function settleDeletion(env, accountId, now = Date.now()) {
  const id = String(accountId || "");
  if (!id) return { action: "allow" };
  if (!env?.MLB_DB) return { action: "allow" };
  let row;
  try {
    row = await rowOf(env.MLB_DB, id);
  } catch {
    return { action: "unavailable" };
  }
  if (!row || row.status === "cancelled") return { action: "allow" };
  if (row.status === "completed") return { action: "deleted" };
  const due = row.status === "purging" || (row.status === "pending" && Number(row.scheduled_at) <= now);
  if (due) {
    try {
      await purgeAccount(env, id, now);
    } catch {
      return { action: "deleted" };
    }
    const again = await rowOf(env.MLB_DB, id);
    if (!again || again.status === "cancelled") return { action: "allow" };
    return { action: "deleted" };
  }
  if (row.status !== "pending") return { action: "allow" };
  return { action: "pending" };
}

export async function loginGate(env, accountId, now = Date.now()) {
  const settled = await settleDeletion(env, accountId, now);
  if (settled.action !== "pending") return settled;
  const id = String(accountId);
  if (!env.SESSION_SECRET) return { action: "unavailable" };
  const exp = Math.floor(now / 1000) + TICKET_TTL_SEC;
  const jti = crypto.randomUUID();
  await env.MLB_DB.prepare(
    "INSERT INTO deletion_tickets (jti, user_id, exp, created_at) VALUES (?1, ?2, ?3, ?4)",
  ).bind(jti, id, exp, now).run();
  const ticket = await seal({ typ: "deletion", jti, accountId: id, exp }, env.SESSION_SECRET, "deletion-ticket");
  return {
    action: "pending",
    cookie: cookie("mlb_deletion", ticket, { maxAge: TICKET_TTL_SEC }),
  };
}

async function ticketPayload(request, env) {
  if (!env?.SESSION_SECRET || !env?.MLB_DB) return null;
  const data = await unseal(getCookie(request, "mlb_deletion"), env.SESSION_SECRET, "deletion-ticket");
  if (!data || data.typ !== "deletion" || typeof data.jti !== "string" || !data.accountId) return null;
  return data;
}

export async function readDeletionTicket(request, env, now = Date.now()) {
  const data = await ticketPayload(request, env);
  if (!data || Number(data.exp) < Math.floor(now / 1000)) return null;
  await ensureDeletionSchema(env.MLB_DB);
  const row = await env.MLB_DB.prepare(
    "SELECT user_id, exp FROM deletion_tickets WHERE jti = ?1",
  ).bind(data.jti).first();
  if (!row || String(row.user_id) !== String(data.accountId) || Number(row.exp) < Math.floor(now / 1000)) return null;
  return { accountId: String(row.user_id), jti: data.jti };
}

export async function consumeDeletionTicket(request, env, now = Date.now()) {
  const data = await ticketPayload(request, env);
  if (!data) return null;
  await ensureDeletionSchema(env.MLB_DB);
  const out = await env.MLB_DB.prepare(
    "DELETE FROM deletion_tickets WHERE jti = ?1 AND user_id = ?2 AND exp >= ?3 RETURNING user_id",
  ).bind(data.jti, String(data.accountId), Math.floor(now / 1000)).all();
  if (!out.results?.length) return null;
  return String(out.results[0].user_id);
}

export function clearDeletionCookie() {
  return clearCookie("mlb_deletion");
}

export async function sealReauthIntent(accountId, secret) {
  return seal({
    typ: "reauth",
    accountId: String(accountId),
    exp: Math.floor(Date.now() / 1000) + 600,
  }, secret, "reauth");
}

export async function readReauthIntent(request, env) {
  const raw = getCookie(request, "mlb_reauth");
  if (!raw) return { present: false, valid: false };
  const data = env?.SESSION_SECRET ? await unseal(raw, env.SESSION_SECRET, "reauth") : null;
  if (!data || data.typ !== "reauth" || !data.accountId) return { present: true, valid: false };
  return { present: true, valid: true, accountId: String(data.accountId) };
}
