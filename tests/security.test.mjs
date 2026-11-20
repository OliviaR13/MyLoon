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
import { challengeCookie, deleteCredential, putCredential, saveChallenge, takeChallenge } from "../functions/_lib/passkeys.js";
import { confirmConflict, stageConflictToken } from "../functions/_lib/accounts.js";
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
  const kv = {
    get: async (k) => {
      if (fail) throw new Error("kv down");
      return m.has(k) ? m.get(k) : null;
    },
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
  kv.DB = fakeD1();
  return kv;
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

function sessionToken(fields) {
  return seal({
    sv: 0,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...fields,
  }, SECRET, "session");
}

test("退出登录只作废当前会话，另一台设备仍保持登录", async () => {
  const kv = memoryKv();
  const env = { SESSION_SECRET: SECRET, MLB_KV: kv, MLB_DB: kv.DB };
  const here = await sessionToken({ id: 7, login: "bee", sid: "sid-device-a" });
  const other = await sessionToken({ id: 7, login: "bee", sid: "sid-device-b" });
  const legacy = await sessionToken({ id: 7, login: "bee" });
  const out = await onLogout({
    request: new Request(ORIGIN + "/api/logout", { method: "POST", headers: { origin: ORIGIN, cookie: "mlb_session=" + here } }),
    env,
  });
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("Set-Cookie").includes("all="), false);
  assert.match(out.headers.get("Set-Cookie"), /mlb_session=;/);
  const gone = await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + here } }), env });
  assert.equal((await gone.json()).user, null);
  const stays = await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + other } }), env });
  assert.equal((await stays.json()).user.login, "bee");
  const old = await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + legacy } }), env });
  assert.equal((await old.json()).user.login, "bee");

  const denied = await onLogout({
    request: new Request(ORIGIN + "/api/logout?all=1", { method: "POST", headers: { origin: ORIGIN, cookie: "mlb_session=" + other } }),
    env,
  });
  assert.equal(denied.status, 200);
  const still = await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + legacy } }), env });
  assert.equal((await still.json()).user.login, "bee");
});

test("没有 Origin 的退出请求被拒绝", async () => {
  const res = await onLogout({
    request: new Request(ORIGIN + "/api/logout", { method: "POST" }),
    env: { SESSION_SECRET: SECRET },
  });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "forbidden");
});

test("作废名单读失败时鉴权失败关闭，过期记录会被清掉", async () => {
  const kv = {
    get: async (k) => {
      if (String(k).startsWith("rsid:")) throw new Error("down");
      return null;
    },
    put: async () => {},
    delete: async () => {},
  };
  const token = await sessionToken({ id: 3, login: "cat", sid: "sid-broken1" });
  const req = new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + token } });
  await assert.rejects(() => getSession(req, { SESSION_SECRET: SECRET, MLB_KV: kv }), (err) => err.code === "auth_unavailable");

  const db = new DatabaseSync(":memory:");
  const env = {
    SESSION_SECRET: SECRET,
    MLB_DB: { prepare: (sql) => new Stmt(db, sql), async batch(stmts) { return stmts.map((s) => s.exec()); } },
  };
  const sid = "sid-expired1";
  await getSession(new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + await sessionToken({ id: 4, login: "d", sid }) } }), env);
  db.prepare("INSERT OR REPLACE INTO revoked_sessions (sid, account_id, expires_at) VALUES (?, ?, ?)").run(sid, "4", Math.floor(Date.now() / 1000) - 5);
  const live = await getSession(new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + await sessionToken({ id: 4, login: "d", sid }) } }), env);
  assert.equal(live.login, "d");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM revoked_sessions").get().n, 0);
});

test("一次性挑战必须由 D1 原子消费，重复提交不能再次使用", async () => {
  const kv = memoryKv();
  const env = { PASSKEYS: kv, SESSION_SECRET: SECRET, MLB_DB: kv.DB };
  await saveChallenge(env, "abc", "auth");
  const set = await challengeCookie(env, "abc", "auth");
  const req = new Request(ORIGIN + "/api/auth/passkey/login/verify", {
    method: "POST",
    headers: { origin: ORIGIN, cookie: set.split(";")[0] },
  });
  assert.deepEqual(await takeChallenge(env, "abc", "auth", req), { kind: "auth", userId: "" });
  assert.equal(await takeChallenge(env, "abc", "auth", req), null);
  assert.equal(await takeChallenge({ PASSKEYS: kv, SESSION_SECRET: SECRET }, "abc", "auth", req), null);
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
  assert.equal((await rateLimit(req(), {}, "passkey-login-ver")).status, 503);
  assert.equal((await rateLimit(req(), { MLB_DB: { prepare() { return { run: async () => { throw new Error("down"); }, bind() { return this; }, all: async () => { throw new Error("down"); } }; } } }, "passkey-login-ver")).status, 503);
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
    env: { GITHUB_CLIENT_ID: "id", SESSION_SECRET: SECRET, MLB_DB: fakeD1() },
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


test("旧格式会话注销后通过兼容 sid 在服务端失效", async () => {
  const kv = memoryKv();
  const env = { SESSION_SECRET: SECRET, MLB_KV: kv, MLB_DB: kv.DB };
  const legacy = await seal({ id: 81, login: "legacy", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  const cookie = "mlb_session=" + legacy;
  const out = await onLogout({ request: new Request(ORIGIN + "/api/logout", { method: "POST", headers: { origin: ORIGIN, cookie } }), env });
  assert.equal(out.status, 200);
  const after = await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie } }), env });
  assert.equal((await after.json()).user, null);
});

test("并发注册同一 credential ID 只能有一个账号成功占用", async () => {
  const kv = memoryKv();
  const base = { provider: "github", login: "user", name: "", email: "", picture: "", credentialId: "shared-id", coseKey: "AA", alg: -7, signCount: 0, createdAt: Date.now() };
  const results = await Promise.allSettled([
    putCredential(kv, { ...base, userId: "account-a" }),
    putCredential(kv, { ...base, userId: "account-b" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.equal(rejected.reason.code, "credential_exists");
  const stored = JSON.parse(await kv.get("cred:shared-id"));
  assert.ok(stored.userId === "account-a" || stored.userId === "account-b");
});

test("D1 删除失败时通行密钥仍留在原账号，过期的空占位可以被重新注册", async () => {
  const kv = memoryKv();
  const row = { provider: "github", login: "a", name: "", email: "", picture: "", coseKey: "AA", alg: -7, signCount: 0, createdAt: 1 };
  await putCredential(kv, { ...row, userId: "1", credentialId: "keep" });
  const real = kv.DB;
  const failing = {
    prepare(sql) {
      if (/DELETE\s+FROM\s+passkey_credential_claims/i.test(sql)) {
        return { bind() { return this; }, async run() { throw new Error("d1 down"); }, async all() { throw new Error("d1 down"); } };
      }
      return real.prepare(sql);
    },
  };
  await assert.rejects(() => deleteCredential(kv, "1", "keep", failing), (err) => err.message === "d1 down");
  assert.ok(await kv.get("cred:keep"));
  await assert.rejects(
    () => putCredential(kv, { ...row, userId: "2", credentialId: "keep" }, real),
    (err) => err.code === "credential_exists",
  );
  assert.equal(JSON.parse(await kv.get("cred:keep")).userId, "1");

  await kv.delete("cred:keep");
  await assert.rejects(
    () => putCredential(kv, { ...row, userId: "2", credentialId: "keep" }, real),
    (err) => err.code === "credential_exists",
  );
  await real.prepare("UPDATE passkey_credential_claims SET created_at = ?1 WHERE credential_id = ?2")
    .bind(Date.now() - 120_000, "keep").run();
  const raced = await Promise.allSettled([
    putCredential(kv, { ...row, userId: "2", credentialId: "keep" }, real),
    putCredential(kv, { ...row, userId: "3", credentialId: "keep" }, real),
  ]);
  assert.equal(raced.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(raced.find((r) => r.status === "rejected").reason.code, "credential_exists");
  const owner = JSON.parse(await kv.get("cred:keep")).userId;
  assert.ok(owner === "2" || owner === "3");
  const claim = await real.prepare("SELECT user_id FROM passkey_credential_claims WHERE credential_id = ?1").bind("keep").first();
  assert.equal(claim.user_id, owner);
});

test("没有 D1 时不能签发或确认账号冲突", async () => {
  const env = { SESSION_SECRET: SECRET, MLB_KV: memoryKv() };
  const profile = { kind: "github", subject: "9", label: "x", name: "", email: "", picture: "" };
  await assert.rejects(() => stageConflictToken(env, "1", "2", profile), (err) => err.code === "conflict_d1_required");
  await assert.rejects(() => confirmConflict(env, { id: 1 }, "token-token-token-token", "marker"), (err) => err.code === "conflict_d1_required");
});