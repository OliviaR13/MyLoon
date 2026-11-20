// 固定窗口限流。按「IP 的哈希 + 路由」计数，不保存原始 IP。
// 优先使用已有 D1。认证敏感路由在 D1 缺失或故障时失败关闭；公开统计路由保留可用性优先的降级。
import { json } from "./auth.js";

const WINDOW = 60;
const LIMITS = {
  install: 60,
  manifest: 30,
  "passkey-reg-opt": 20,
  "passkey-reg-ver": 20,
  "passkey-login-opt": 20,
  "passkey-login-ver": 20,
  "auth-github": 30,
  "auth-google": 30,
  conflict: 10,
  "account-delete": 5,
  "account-delete-act": 10,
};

const ready = new WeakMap();
const FAIL_CLOSED = new Set(["passkey-reg-opt", "passkey-reg-ver", "passkey-login-opt", "passkey-login-ver", "auth-github", "auth-google", "conflict", "account-delete", "account-delete-act"]);
const enc = new TextEncoder();

function ensureTable(DB) {
  let pending = ready.get(DB);
  if (!pending) {
    pending = DB.prepare(
      "CREATE TABLE IF NOT EXISTS rate_limits (k TEXT NOT NULL, win INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, win))",
    ).run().catch((err) => {
      ready.delete(DB);
      throw err;
    });
    ready.set(DB, pending);
  }
  return pending;
}

function pepper(env) {
  return env?.SESSION_SECRET || env?.TURNSTILE_SECRET || env?.INSTALL_HASH_SECRET || "mlb-rate-limit";
}

async function bucketKey(request, env, route) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`${pepper(env)}|${route}|${ip}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return hex;
}

function limited(retryAfter) {
  return json({ error: "rate_limited" }, 429, { "retry-after": String(retryAfter) });
}

async function hitD1(DB, k, win) {
  await ensureTable(DB);
  const out = await DB.prepare(
    `INSERT INTO rate_limits (k, win, n) VALUES (?1, ?2, 1)
     ON CONFLICT(k, win) DO UPDATE SET n = n + 1
     RETURNING n`,
  ).bind(k, win).all();
  return Number(out.results?.[0]?.n) || 1;
}

async function hitKv(KV, k, win) {
  const key = `rl:${k}:${win}`;
  const n = (Number(await KV.get(key)) || 0) + 1;
  await KV.put(key, String(n), { expirationTtl: WINDOW * 2 });
  return n;
}

// 返回 429 响应，或 null 表示可以继续。
export async function rateLimit(request, env, route) {
  const limit = LIMITS[route];
  if (!limit) return null;
  const win = Math.floor(Date.now() / 1000 / WINDOW);
  const retryAfter = WINDOW - (Math.floor(Date.now() / 1000) % WINDOW);
  try {
    if (FAIL_CLOSED.has(route) && !env?.MLB_DB) return json({ error: "rate_limit_unavailable" }, 503);
    if (!env?.MLB_DB && !env?.MLB_KV) return null;
    const k = await bucketKey(request, env, route);
    const n = env.MLB_DB ? await hitD1(env.MLB_DB, k, win) : await hitKv(env.MLB_KV, k, win);
    if (n > limit) return limited(retryAfter);
    return null;
  } catch (err) {
    console.error("rate_limit_storage", route, err?.message || "error");
    if (FAIL_CLOSED.has(route)) return json({ error: "rate_limit_unavailable" }, 503);
    return null;
  }
}
