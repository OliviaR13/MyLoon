// Cloudflare Pages Function：POST /api/manifest
// 1. 带令牌：调用 Turnstile siteverify 校验，通过后返回清单，并下发一个 30 分钟有效的签名 Cookie。
// 2. 不带令牌：只要 Cookie 有效（签名正确且未过期）就直接返回清单，刷新不必重新验证。
// 需要的环境变量（Pages 项目 → Settings → Variables and Secrets）：
//   TURNSTILE_SECRET     Turnstile 小组件的 Secret key（设为 Secret；同时用作 Cookie 的签名密钥）
//   TURNSTILE_HOSTNAMES  允许的前端域名，逗号分隔，例如 myloon.pages.dev
import manifest from "../../manifest.json";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACTION = "load_manifest"; // 需与 app.js 中 CONFIG.turnstile.action 一致
const COOKIE = "mlb_verified";
const TTL = 30 * 60; // 免验证时长（秒）

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const forbidden = (reason) => json({ error: "forbidden", reason }, 403);

/* ---------- Cookie 签名：值为 "过期时间戳.HMAC" ---------- */
const enc = new TextEncoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hmacKey = (secret) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

async function signCookie(secret) {
  const exp = Math.floor(Date.now() / 1000) + TTL;
  const sig = toB64(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(String(exp))));
  return `${COOKIE}=${exp}.${sig}; Max-Age=${TTL}; Path=/api; HttpOnly; Secure; SameSite=Lax`;
}

async function hasValidCookie(request, secret) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([\\w-]+)`));
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64(m[2]), enc.encode(m[1]));
  } catch {
    return false;
  }
}

export async function onRequestPost({ request, env }) {
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_HOSTNAMES) return json({ error: "server_misconfigured" }, 500);
  const hostnames = new Set(env.TURNSTILE_HOSTNAMES.split(",").map((h) => h.trim()).filter(Boolean));

  let token;
  try { ({ token } = await request.json()); } catch {}

  // 没有令牌：只接受仍在有效期内的签名 Cookie
  if (!token) {
    return (await hasValidCookie(request, env.TURNSTILE_SECRET)) ? json(manifest) : forbidden("no_token");
  }
  if (typeof token !== "string" || token.length > 2048) return forbidden("no_token");

  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.set("remoteip", ip);

  let result;
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error("siteverify " + res.status);
    result = await res.json();
  } catch {
    return forbidden("siteverify_unreachable");
  }

  // reason 只包含错误码、action 和访问域名，便于排查，不含密钥
  if (!result.success) return forbidden("siteverify_failed:" + (result["error-codes"] || []).join(","));
  if (result.action !== ACTION) return forbidden("action_mismatch:" + result.action);
  if (!hostnames.has(result.hostname)) return forbidden("hostname_mismatch:" + result.hostname);

  return json(manifest, 200, { "Set-Cookie": await signCookie(env.TURNSTILE_SECRET) });
}
