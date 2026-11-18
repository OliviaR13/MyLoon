// Google 登录：校验 ID Token、用授权码换票、整理写入会话的资料。
// 客户端 ID 和密钥只从环境变量读取，不写进仓库。访问令牌换完即丢，不保存。

const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

let certCache = { keys: null, exp: 0 };

export function resetGoogleCerts() {
  certCache = { keys: null, exp: 0 };
}

export function googleRedirectUri(request) {
  return new URL("/api/auth/google/callback", request.url).href;
}

export function googleConfigured(env) {
  return !!(env && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET);
}

function b64urlToBytes(s) {
  const str = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = str + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlFromBytes(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));
}

export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlFromBytes(buf);
}

export async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64urlFromBytes(digest);
}

// 只接受 Google 头像 CDN，避免把会话里的地址直接塞进 <img>。
export function safeGooglePicture(value) {
  if (typeof value !== "string" || value.length > 500) return "";
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:") return "";
    if (host !== "googleusercontent.com" && !host.endsWith(".googleusercontent.com")) return "";
    return u.href;
  } catch {
    return "";
  }
}

function cleanName(name) {
  if (typeof name !== "string") return "";
  return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
}

function cleanEmail(email) {
  if (typeof email !== "string") return "";
  const e = email.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return "";
  return e;
}

// 校验 Google 签发的 ID Token。失败返回 null，不抛给调用方（网络错误除外）。
export async function verifyGoogleIdToken(token, clientId, opts = {}) {
  const fetchImpl = opts.fetch || fetch;
  const now = opts.now || Date.now;
  if (!clientId || typeof token !== "string" || token.length < 20 || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)) return null;

  const jwk = await googleCert(header.kid, fetchImpl, now);
  if (!jwk) return null;
  let key;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), data);
  } catch {
    return null;
  }
  if (!ok) return null;

  const t = Math.floor(now() / 1000);
  if (!ISSUERS.has(payload.iss)) return null;
  const audOk = payload.aud === clientId || (Array.isArray(payload.aud) && payload.aud.includes(clientId));
  if (!audOk) return null;
  if (payload.azp && payload.azp !== clientId) return null;
  if (typeof payload.exp !== "number" || payload.exp < t - 60) return null;
  if (typeof payload.iat !== "number" || payload.iat > t + 60) return null;
  if (typeof payload.sub !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(payload.sub)) return null;
  if (payload.email_verified !== true && payload.email_verified !== "true") return null;
  const email = cleanEmail(payload.email);
  if (!email) return null;
  const name = cleanName(payload.name);
  return { sub: payload.sub, email, name, picture: safeGooglePicture(payload.picture) };
}

async function googleCert(kid, fetchImpl, now) {
  let keys = certCache.keys && certCache.exp > now() ? certCache.keys : null;
  if (!keys) keys = await loadCerts(fetchImpl, now);
  if (keys?.some((k) => k.kid === kid)) return keys.find((k) => k.kid === kid);
  keys = await loadCerts(fetchImpl, now, true);
  return keys?.find((k) => k.kid === kid) || null;
}

async function loadCerts(fetchImpl, now, force = false) {
  if (!force && certCache.keys && certCache.exp > now()) return certCache.keys;
  const res = await fetchImpl(CERTS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error("certs " + res.status);
  const body = await res.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  const cc = res.headers?.get?.("cache-control") || "";
  const m = cc.match(/max-age=(\d+)/);
  const ttl = Math.min(Number(m?.[1] || 3600), 24 * 3600) * 1000;
  certCache = { keys, exp: now() + Math.max(ttl, 1000) };
  return keys;
}

// 用授权码换 ID Token。不要把 access_token 留下来。
export async function exchangeGoogleCode({ code, clientId, clientSecret, redirectUri, codeVerifier, fetch: fetchImpl = fetch }) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return typeof json.id_token === "string" ? json.id_token : null;
}

export function googleSession(profile) {
  const name = profile.name || profile.email.split("@")[0] || "Google 用户";
  return {
    id: "google:" + profile.sub,
    login: name,
    name,
    email: profile.email,
    picture: profile.picture || "",
    provider: "google",
  };
}

// /api/me 返回给页面的公开资料。GitHub 老会话没有 provider，仍按原来的用户名显示。
export function publicSessionUser(user) {
  if (!user || user.id == null) return null;
  const provider = user.provider === "google" ? "google" : "github";
  const login = typeof user.login === "string" ? user.login : "";
  if (provider === "google") {
    const name = cleanName(user.name) || login || "Google 用户";
    return {
      id: user.id,
      login: name,
      name,
      provider,
      picture: safeGooglePicture(user.picture),
      email: cleanEmail(user.email),
    };
  }
  return { id: user.id, login, name: login || "已登录", provider, picture: "", email: "" };
}
