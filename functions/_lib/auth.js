// 登录相关的公共函数：签名 Cookie、会话读取、JSON 响应
import { isAccountDeleted } from "./account-tomb.js";
import { isAuthUnavailable } from "./auth-error.js";
import { bumpEpoch, currentEpoch, epochAllows } from "./session-epoch.js";
import { isSessionRevoked } from "./revoked-sessions.js";
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const HKDF_SALT = enc.encode("mlb-hkdf-v1");

const hmacKey = (secret) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

// 新令牌按用途从现有密钥派生 HMAC 密钥。旧令牌仍用原来的密钥直接签名，校验时两种都认。
async function purposeKey(secret, purpose) {
  if (!purpose) return hmacKey(secret);
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: enc.encode(purpose) },
    base,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export const SESSION_TTL = 30 * 24 * 3600; // 登录有效期：30 天

async function sealWith(payload, secret, purpose) {
  const body = b64(enc.encode(JSON.stringify(payload)));
  const sig = b64(await crypto.subtle.sign("HMAC", await purposeKey(secret, purpose), enc.encode(body)));
  return `${body}.${sig}`;
}

async function unsealWith(token, secret, purpose) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await purposeKey(secret, purpose), unb64(sig), enc.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64(body)));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

// purpose 省略时仍用原来的密钥，测试和旧调用保持不变。
// 带了 purpose 的新令牌用派生密钥；校验时如果对不上，再试旧密钥。
export async function seal(payload, secret, purpose = "") {
  return sealWith(payload, secret, purpose);
}

export async function unseal(token, secret, purpose = "") {
  const current = await unsealWith(token, secret, purpose);
  if (current || !purpose) return current;
  return unsealWith(token, secret, "");
}

export const getCookie = (req, name) => {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : "";
};

// 修复：默认 Path 统一为 "/"，并处理 Max-Age
export const cookie = (name, value, { maxAge, path = "/" } = {}) => {
  let cookieStr = `${name}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
  if (typeof maxAge === "number") {
    cookieStr += `; Max-Age=${maxAge}`;
  }
  return cookieStr;
};

// 删除 Cookie。除了 Max-Age=0，再补一个过去的 Expires：
// 只写 Max-Age=0 在部分 WebKit 版本上不会真正删掉 Cookie，而 Expires 是所有
// 实现都认的兜底写法。删 Cookie 必须双写，别嫌啰嗦。
export const clearCookie = (name, path = "/") =>
  `${name}=; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

// 当前登录用户：{ id, login } 或 null。被注销的账号、或代数已经抬高的旧 Cookie，不再算登录。
// 墓碑或代数存储读失败时抛 auth_unavailable，由接口返回 503，而不是当成未登录。
export async function getSession(request, env) {
  if (!env?.SESSION_SECRET) return null;
  const user = await unseal(getCookie(request, "mlb_session"), env.SESSION_SECRET, "session");
  if (!user || user.id == null) return null;
  if (await isAccountDeleted(env, String(user.id))) return null;
  const epoch = await currentEpoch(env, String(user.id));
  if (!epochAllows(user, epoch)) return null;
  // 迁移期旧 Cookie 没有 sid：用账号级稳定标识纳入作废名单。
  // 旧设备会共享这个兼容 sid，因此注销一个旧会话会同时注销该账号的所有旧格式会话；
  // 新签发的会话仍使用独立随机 sid，不影响其他新设备。
  if (!user.sid) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("legacy-session|" + String(user.id))));
    user.sid = "legacy-" + [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (await isSessionRevoked(env, user.sid)) return null;
  return user;
}

export async function issueSession(env, payload) {
  const sv = payload.sv == null ? await currentEpoch(env, String(payload.id)) : payload.sv;
  const sid = typeof payload.sid === "string" && payload.sid ? payload.sid : crypto.randomUUID();
  return seal({ ...payload, sv, sid }, env.SESSION_SECRET, "session");
}

// 抬高代数并给当前浏览器换一张新会话，这样这一台还登录着，其他设备全部退出。
export async function rotateSession(env, user) {
  const sv = await bumpEpoch(env, String(user.id));
  const token = await seal({ ...user, sv, sid: crypto.randomUUID() }, env.SESSION_SECRET, "session");
  return cookie("mlb_session", token, { maxAge: SESSION_TTL });
}

export async function getSessionOr503(request, env) {
  try {
    return { user: await getSession(request, env) };
  } catch (err) {
    if (isAuthUnavailable(err)) return { response: json({ error: "auth_unavailable" }, 503) };
    throw err;
  }
}

// ALLOWED_USERS：逗号分隔的 GitHub 用户名和 Google 邮箱，不区分大小写。
// 空着表示不限制。通行密钥沿用注册时记下的用户名或邮箱。
export function allowListed(env, ...ids) {
  const list = String(env?.ALLOWED_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true;
  return ids.some((id) => id && list.includes(String(id).trim().toLowerCase()));
}

// GET / HEAD：没有 Origin 时放行（和原来一样）。
// 会改状态的请求必须带同源 Origin，或 Sec-Fetch-Site: same-origin，或同源 Referer。
export function sameOrigin(request) {
  const here = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return !origin || origin === here;
  if (origin) return origin === here;
  const site = (request.headers.get("Sec-Fetch-Site") || "").toLowerCase();
  if (site) return site === "same-origin";
  const referer = request.headers.get("Referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === here;
  } catch {
    return false;
  }
}
