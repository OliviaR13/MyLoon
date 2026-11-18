// 通行密钥存在 KV 绑定 PASSKEYS。不占用同步用的 MLB_KV / MLB_DB。
//   cred:<credentialId>  公钥、计数器、所属账号
//   user:<userId>        这个账号的凭证 ID 列表
//   chal:<challenge>     一次性挑战，TTL 5 分钟，用过即删
import { SESSION_TTL } from "./auth.js";
import { b64urlDecode, b64urlEncode } from "./webauthn.js";

export const CHALLENGE_TTL = 300;
export const MAX_PASSKEYS = 8;

export function passkeyConfigError(env) {
  if (!env?.PASSKEYS && !env?.SESSION_SECRET) return "需要在 Pages 绑定 KV 命名空间 PASSKEYS，并设置 SESSION_SECRET";
  if (!env?.PASSKEYS) return "需要在 Pages 绑定 KV 命名空间 PASSKEYS";
  if (!env?.SESSION_SECRET) return "需要设置 SESSION_SECRET 才能签发登录 Cookie";
  return "";
}

const credKey = (id) => `cred:${id}`;
const userKey = (id) => `user:${id}`;
const chalKey = (id) => `chal:${id}`;

export async function saveChallenge(kv, challenge, kind, extra = {}) {
  await kv.put(
    chalKey(challenge),
    JSON.stringify({ kind, userId: extra.userId || "", exp: Date.now() + CHALLENGE_TTL * 1000 }),
    { expirationTtl: CHALLENGE_TTL },
  );
}

// 取出并删除。第二次再用同一个挑战会失败。
export async function takeChallenge(kv, challenge, kind) {
  if (!challenge || challenge.length > 200) return null;
  const key = chalKey(challenge);
  const raw = await kv.get(key);
  if (!raw) return null;
  await kv.delete(key);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || data.kind !== kind || !Number.isFinite(data.exp) || data.exp < Date.now()) return null;
  return data;
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

export async function putCredential(kv, record) {
  const ids = await readIndex(kv, record.userId);
  if (!ids.includes(record.credentialId) && ids.length >= MAX_PASSKEYS) {
    const err = new Error("too_many");
    err.code = "too_many";
    throw err;
  }
  const next = ids.includes(record.credentialId) ? ids : [...ids, record.credentialId];
  await kv.put(credKey(record.credentialId), JSON.stringify(record));
  await kv.put(userKey(record.userId), JSON.stringify(next));
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

export async function deleteCredential(kv, userId, credentialId) {
  const ids = await readIndex(kv, String(userId));
  if (!ids.includes(credentialId)) return false;
  await kv.delete(credKey(credentialId));
  await kv.put(userKey(String(userId)), JSON.stringify(ids.filter((id) => id !== credentialId)));
  return true;
}

export function newChallenge() {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function userHandle(userId) {
  return b64urlEncode(new TextEncoder().encode(String(userId)));
}
