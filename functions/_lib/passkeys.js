// 通行密钥资料保存在 PASSKEYS；挑战消费与 credential ID 唯一性由现有 MLB_DB 原子保证。
//   cred:<credentialId>  公钥、计数器、所属账号
//   user:<userId>        这个账号的凭证 ID 列表
//   D1 passkey_challenges 一次性挑战，TTL 5 分钟，用过即原子删除
import { SESSION_TTL, cookie, getCookie, seal, unseal } from "./auth.js";
import { b64urlDecode, b64urlEncode } from "./webauthn.js";

export const CHALLENGE_TTL = 300;
export const MAX_PASSKEYS = 8;

export function passkeyConfigError(env) {
  if (!env?.PASSKEYS && !env?.SESSION_SECRET) return "需要在 Pages 绑定 KV 命名空间 PASSKEYS，并设置 SESSION_SECRET";
  if (!env?.PASSKEYS) return "需要在 Pages 绑定 KV 命名空间 PASSKEYS";
  if (!env?.MLB_DB) return "需要绑定现有 D1 数据库 MLB_DB，以保证挑战和凭证 ID 原子唯一";
  if (!env?.SESSION_SECRET) return "需要设置 SESSION_SECRET 才能签发登录 Cookie";
  return "";
}

const credKey = (id) => `cred:${id}`;
const userKey = (id) => `user:${id}`;

const chalReady = new WeakMap();

function ensureChalTable(DB) {
  let pending = chalReady.get(DB);
  if (!pending) {
    pending = DB.prepare(
      "CREATE TABLE IF NOT EXISTS passkey_challenges (challenge TEXT PRIMARY KEY, kind TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', exp INTEGER NOT NULL)",
    ).run().catch((err) => {
      chalReady.delete(DB);
      throw err;
    });
    chalReady.set(DB, pending);
  }
  return pending;
}

export async function saveChallenge(env, challenge, kind, extra = {}) {
  const exp = Date.now() + CHALLENGE_TTL * 1000;
  const userId = extra.userId || "";
  if (!env?.MLB_DB) throw new Error("passkey_d1_required");
  if (env?.MLB_DB) {
    await ensureChalTable(env.MLB_DB);
    await env.MLB_DB.prepare(
      "INSERT OR REPLACE INTO passkey_challenges (challenge, kind, user_id, exp) VALUES (?1, ?2, ?3, ?4)",
    ).bind(challenge, kind, userId, exp).run();
  }
}

export async function challengeCookie(env, challenge, kind) {
  const token = await seal({
    typ: "chal",
    challenge,
    kind,
    exp: Math.floor(Date.now() / 1000) + CHALLENGE_TTL,
  }, env.SESSION_SECRET, "passkey-chal");
  return cookie("mlb_chal", token, { maxAge: CHALLENGE_TTL });
}

async function challengeCookieOk(request, env, challenge, kind) {
  const data = await unseal(getCookie(request, "mlb_chal"), env.SESSION_SECRET, "passkey-chal");
  return !!data && data.typ === "chal" && data.challenge === challenge && data.kind === kind;
}

async function takeFromD1(DB, challenge, kind) {
  await ensureChalTable(DB);
  const out = await DB.prepare(
    "DELETE FROM passkey_challenges WHERE challenge = ?1 AND kind = ?2 RETURNING user_id, exp",
  ).bind(challenge, kind).all();
  const row = out.results?.[0];
  if (!row || !Number.isFinite(row.exp) || row.exp < Date.now()) return null;
  return { kind, userId: row.user_id || "" };
}

// 取出并删除。必须使用 D1 DELETE … RETURNING，避免两个请求同时读到同一条。
// 另外必须带上签发挑战时写下的 Cookie，这样别人拿到挑战值也用不了。
export async function takeChallenge(env, challenge, kind, request) {
  if (!challenge || challenge.length > 200) return null;
  if (!(await challengeCookieOk(request, env, challenge, kind))) return null;
  // 一次性挑战只允许走 D1 的原子 DELETE … RETURNING；KV 回退无法防止并发重放。
  if (!env?.MLB_DB) return null;
  return takeFromD1(env.MLB_DB, challenge, kind);
}

function cleanText(v, max) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function profileFromSession(user) {
  const provider = user.provider === "google" ? "google" : "github";
  const id = String(user.id ?? "");
  if (!id || id.length > 128) return null;
  return {
    userId: id,
    provider,
    login: cleanText(user.login, 80) || (provider === "google" ? "Google 用户" : "GitHub 用户"),
    name: cleanText(user.name, 80),
    email: cleanText(user.email, 120),
    picture: cleanText(user.picture, 300),
  };
}

export function sessionFromProfile(profile) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  if (profile.provider === "google") {
    return {
      id: profile.userId,
      login: profile.login,
      name: profile.name || profile.login,
      email: profile.email,
      picture: profile.picture,
      provider: "google",
      exp,
    };
  }
  const id = /^\d+$/.test(profile.userId) ? Number(profile.userId) : profile.userId;
  return { id, login: profile.login, exp };
}

async function readIndex(kv, userId) {
  const raw = await kv.get(userKey(userId));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export async function listCredentials(kv, userId) {
  const ids = await readIndex(kv, String(userId));
  const out = [];
  for (const id of ids) {
    const raw = await kv.get(credKey(id));
    if (!raw) continue;
    try {
      const rec = JSON.parse(raw);
      out.push({ id, createdAt: rec.createdAt || 0 });
    } catch {
      /* 坏记录跳过 */
    }
  }
  return out;
}

// 刚写入的占位可能还没把公钥写进 KV。这段时间内即使 KV 还是空的，也不许别人抢走。
const CLAIM_HOLD_MS = 60_000;

const credentialReady = new WeakMap();

async function ensureCredentialTable(DB) {
  let pending = credentialReady.get(DB);
  if (!pending) {
    pending = DB.prepare(
      "CREATE TABLE IF NOT EXISTS passkey_credential_claims (credential_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL)",
    ).run().catch((err) => {
      credentialReady.delete(DB);
      throw err;
    });
    credentialReady.set(DB, pending);
  }
  return pending;
}

function credentialTaken() {
  const err = new Error("credential_exists");
  err.code = "credential_exists";
  return err;
}

// 返回被替换掉的旧账号；没有旧账号时返回空字符串。
// 新 ID 用 INSERT … ON CONFLICT DO NOTHING，并发时只有一个成功。
// KV 记录已经不在、且占位超过 CLAIM_HOLD_MS 时，用 created_at 做条件更新接管。
// 条件对不上就放弃，所以不会有两个账号同时拥有同一把密钥。
async function claimCredential(DB, kv, record) {
  if (!DB) throw new Error("passkey_d1_required");
  await ensureCredentialTable(DB);
  const id = record.credentialId;
  const userId = String(record.userId);
  const now = Date.now();
  const inserted = await DB.prepare(
    "INSERT INTO passkey_credential_claims (credential_id, user_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(credential_id) DO NOTHING RETURNING credential_id",
  ).bind(id, userId, now).all();
  if (inserted.results?.length) return "";

  if (await kv.get(credKey(id))) throw credentialTaken();
  const row = await DB.prepare(
    "SELECT user_id, created_at FROM passkey_credential_claims WHERE credential_id = ?1",
  ).bind(id).first();
  if (!row || Date.now() - Number(row.created_at) < CLAIM_HOLD_MS) throw credentialTaken();
  const won = await DB.prepare(
    `UPDATE passkey_credential_claims SET user_id = ?1, created_at = ?2
     WHERE credential_id = ?3 AND user_id = ?4 AND created_at = ?5
     RETURNING credential_id`,
  ).bind(userId, now, id, String(row.user_id), row.created_at).all();
  if (!won.results?.length) throw credentialTaken();
  return String(row.user_id) === userId ? "" : String(row.user_id);
}

async function releaseClaim(DB, credentialId, userId) {
  if (!DB) return;
  await DB.prepare(
    "DELETE FROM passkey_credential_claims WHERE credential_id = ?1 AND user_id = ?2",
  ).bind(credentialId, String(userId)).run();
}

export async function putCredential(kv, record, DB = kv.DB) {
  const existing = await kv.get(credKey(record.credentialId));
  if (existing) {
    const err = new Error("credential_exists");
    err.code = "credential_exists";
    throw err;
  }
  const ids = await readIndex(kv, record.userId);
  if (!ids.includes(record.credentialId) && ids.length >= MAX_PASSKEYS) {
    const err = new Error("too_many");
    err.code = "too_many";
    throw err;
  }
  const previousUser = await claimCredential(DB, kv, record);
  const next = ids.includes(record.credentialId) ? ids : [...ids, record.credentialId];
  try {
    if (previousUser) {
      const prevIds = await readIndex(kv, previousUser);
      if (prevIds.includes(record.credentialId)) {
        await kv.put(userKey(previousUser), JSON.stringify(prevIds.filter((id) => id !== record.credentialId)));
      }
    }
    await kv.put(credKey(record.credentialId), JSON.stringify(record));
    await kv.put(userKey(record.userId), JSON.stringify(next));
  } catch (err) {
    // 公钥没写上就撤掉占位。撤掉失败时保留 KV，避免只留下一个无法再注册的 ID。
    try {
      await releaseClaim(DB, record.credentialId, record.userId);
      await kv.delete(credKey(record.credentialId));
    } catch {
      /* 占位还在且超过 CLAIM_HOLD_MS 后，注册可以再接管 */
    }
    throw err;
  }
}

export async function getCredential(kv, credentialId) {
  if (!credentialId) return null;
  const raw = await kv.get(credKey(credentialId));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    if (!rec || rec.credentialId !== credentialId || !rec.userId || !rec.coseKey) return null;
    const coseKey = b64urlDecode(rec.coseKey);
    if (!coseKey) return null;
    return { ...rec, coseKeyBytes: coseKey };
  } catch {
    return null;
  }
}

export async function updateSignCount(kv, credentialId, signCount) {
  const raw = await kv.get(credKey(credentialId));
  if (!raw) return;
  const rec = JSON.parse(raw);
  rec.signCount = signCount;
  await kv.put(credKey(credentialId), JSON.stringify(rec));
}

export async function deleteCredential(kv, userId, credentialId, DB = kv.DB) {
  const uid = String(userId);
  const ids = await readIndex(kv, uid);
  if (!ids.includes(credentialId)) return false;
  // 先放开 D1 占位。删除失败就不动 KV，这把密钥仍然只属于当前账号，可以重试。
  if (DB) {
    await ensureCredentialTable(DB);
    await releaseClaim(DB, credentialId, uid);
  }
  await kv.delete(credKey(credentialId));
  await kv.put(userKey(uid), JSON.stringify(ids.filter((id) => id !== credentialId)));
  return true;
}

export function newChallenge() {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function userHandle(userId) {
  return b64urlEncode(new TextEncoder().encode(String(userId)));
}
