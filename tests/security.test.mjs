// 会话作废、失败关闭、同源、限流、安全头、用途密钥。
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { allowListed, getSession, getSessionOr503, sameOrigin, seal, unseal } from "../functions/_lib/auth.js";
import { onRequestPost as onLogout } from "../functions/api/logout.js";
import { onRequestGet as onMe } from "../functions/api/me.js";
import { rateLimit } from "../functions/_lib/rate-limit.js";
import { onRequestGet as onGithubLogin } from "../functions/api/auth/login.js";
import { bumpEpoch } from "../functions/_lib/session-epoch.js";
import { applySecurityHeaders } from "../functions/_lib/security-headers.js";
import { putCredential } from "../functions/_lib/passkeys.js";
import { resetSyncCache } from "../functions/_lib/sync-store.js";

const SECRET = "test-session-secret";
const ORIGIN = "https://olivia-loon-box.pages.dev";

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.db, this.sql, p); }
  exec() {
    const st = this.db.prepare(this.sql);
    const read = /^\s*(SELECT|DELETE)/i.test(this.sql) || /RETURNING/i.test(this.sql);
    return read
      ? { results: st.all(...this.params).map((r) => ({ ...r })) }
      : (st.run(...this.params), { results: [] });
  }
  async first() { return this.exec().results[0] ?? null; }
  async all() { return this.exec(); }
  async run() { return this.exec(); }
}
function fakeD1() {
  resetSyncCache();
  const db = new DatabaseSync(":memory:");
  return { prepare: (sql) => new Stmt(db, sql), async batch(stmts) { return stmts.map((s) => s.exec()); } };
}
function memoryKv(fail = false) {
  const m = new Map();
  return {
    get: async (k) => {
      if (fail) throw new Error("kv down");
      return m.has(k) ? m.get(k) : null;
    },
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
}

test("没有 sv 的旧 Cookie 在代数为 0 时仍有效，抬高后失效", async () => {
  const env = { SESSION_SECRET: SECRET, MLB_DB: fakeD1() };
  const legacy = await seal({ id: 42, login: "ada", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  const req = new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + legacy } });
  assert.equal((await getSession(req, env)).id, 42);
  await bumpEpoch(env, "42");
  assert.equal(await getSession(req, env), null);
  const fresh = await seal({ id: 42, login: "ada", sv: 1, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET, "session");
  const again = new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + fresh } });
  assert.equal((await getSession(again, env)).login, "ada");
});

test("退出登录会抬高代数，另一台设备上的旧 Cookie 失效", async () => {
  const env = { SESSION_SECRET: SECRET, MLB_KV: memoryKv() };
  const token = await seal({ id: 7, login: "bee", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  const headers = { origin: ORIGIN, cookie: "mlb_session=" + token };
  const out = await onLogout({ request: new Request(ORIGIN + "/api/logout", { method: "POST", headers }), env });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("Set-Cookie"), /mlb_session=;/);
  const me = await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + token } }), env });
  assert.equal((await me.json()).user, null);
});

test("墓碑存储出错时鉴权失败关闭，返回 503", async () => {
  const env = { SESSION_SECRET: SECRET, MLB_KV: memoryKv(true) };
  const token = await seal({ id: 1, login: "a", exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  const req = new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + token } });
  await assert.rejects(() => getSession(req, env), (err) => err.code === "auth_unavailable");
  const got = await getSessionOr503(req, env);
  assert.equal(got.response.status, 503);
  assert.equal((await got.response.json()).error, "auth_unavailable");
});

test("改状态的请求没有 Origin 时拒绝，GET 和 Sec-Fetch-Site 仍按原规则", () => {
  const post = (headers) => new Request(ORIGIN + "/api/me", { method: "POST", headers });
  assert.equal(sameOrigin(post({})), false);
  assert.equal(sameOrigin(post({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOrigin(post({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(sameOrigin(post({ referer: ORIGIN + "/settings" })), true);
  assert.equal(sameOrigin(post({ origin: "https://evil.example" })), false);
  assert.equal(sameOrigin(new Request(ORIGIN + "/api/me")), true);
});

test("限流超过窗口后返回 429 和 Retry-After；存储出错时放行", async () => {
  const env = { SESSION_SECRET: SECRET, MLB_DB: fakeD1() };
  const req = () => new Request(ORIGIN + "/api/install", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.8" } });
  let last = null;
  for (let i = 0; i < 61; i++) last = await rateLimit(req(), env, "install");
  assert.equal(last.status, 429);
  assert.equal((await last.json()).error, "rate_limited");
  assert.ok(Number(last.headers.get("retry-after")) > 0);
  const broken = {
    MLB_DB: {
      prepare() {
        return { bind() { return this; }, async all() { throw new Error("down"); } };
      },
    },
  };
  assert.equal(await rateLimit(req(), broken, "install"), null);
});

test("安全头写上 HSTS 和 CSP，接口去掉通配 CORS", async () => {
  const page = applySecurityHeaders(new Response("ok", { headers: { "access-control-allow-origin": "*" } }), new Request(ORIGIN + "/"));
  assert.match(page.headers.get("strict-transport-security"), /max-age=31536000/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(page.headers.get("content-security-policy"), /style-src 'self' 'unsafe-inline'/);
  assert.match(page.headers.get("content-security-policy"), /https:\/\/challenges\.cloudflare\.com/);
  assert.equal(page.headers.get("access-control-allow-origin"), "*");
  const api = applySecurityHeaders(new Response("{}", { headers: { "access-control-allow-origin": "*" } }), new Request(ORIGIN + "/api/me"));
  assert.equal(api.headers.get("access-control-allow-origin"), null);
});

test("已存在的通行密钥 ID 不能被另一个账号覆盖", async () => {
  const kv = memoryKv();
  const row = { userId: "1", provider: "github", login: "a", name: "", email: "", picture: "", coseKey: "AA", alg: -7, signCount: 0, createdAt: 1 };
  await putCredential(kv, { ...row, credentialId: "same" });
  await assert.rejects(() => putCredential(kv, { ...row, userId: "2", credentialId: "same" }), (err) => err.code === "credential_exists");
});

test("GitHub 授权带上 S256，允许名单同时看 GitHub 用户名和 Google 邮箱", async () => {
  const start = await onGithubLogin({
    request: new Request(ORIGIN + "/api/auth/login"),
    env: { GITHUB_CLIENT_ID: "id", SESSION_SECRET: SECRET },
  });
  const loc = new URL(start.headers.get("Location"));
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  assert.ok(loc.searchParams.get("code_challenge"));
  assert.equal(allowListed({ ALLOWED_USERS: "" }, "anyone"), true);
  assert.equal(allowListed({ ALLOWED_USERS: "Ada, bee@gmail.com" }, "ada"), true);
  assert.equal(allowListed({ ALLOWED_USERS: "Ada" }, "bee@gmail.com"), false);
  assert.equal(allowListed({ ALLOWED_USERS: "bee@gmail.com" }, "", "Bee@gmail.com"), true);
});

test("旧的直接签名令牌在指定用途时仍然能解开", async () => {
  const legacy = await seal({ id: 1, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  const next = await seal({ id: 2, exp: Math.floor(Date.now() / 1000) + 60 }, SECRET, "session");
  assert.equal((await unseal(legacy, SECRET, "session")).id, 1);
  assert.equal((await unseal(next, SECRET, "session")).id, 2);
  assert.equal(await unseal(next, SECRET), null);
});
