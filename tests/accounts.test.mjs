// 统一账号：绑定、解绑、冲突、老用户的数据还在原来的 ID 上。
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { onRequestGet as onGithubLogin } from "../functions/api/auth/login.js";
import { onRequestGet as onGithubCallback } from "../functions/api/auth/callback.js";
import { onRequestGet as onGoogleLogin } from "../functions/api/auth/google/index.js";
import { onRequestGet as onGoogleCallback } from "../functions/api/auth/google/callback.js";
import { onRequestGet as onAccount } from "../functions/api/account/index.js";
import { onRequestDelete as onUnlink } from "../functions/api/account/identities/[kind].js";
import { onRequestDelete as onDeletePasskey } from "../functions/api/auth/passkey/[id].js";
import { onRequestPost as onConflict } from "../functions/api/account/conflict.js";
import { onRequestGet as onMe, onRequestPut } from "../functions/api/me.js";
import { seal, unseal } from "../functions/_lib/auth.js";
import { stageConflictToken } from "../functions/_lib/accounts.js";
import { listCredentials, putCredential } from "../functions/_lib/passkeys.js";
import { b64urlEncode } from "../functions/_lib/webauthn.js";
import { resetGoogleCerts } from "../functions/_lib/google-auth.js";
import { resetSyncCache } from "../functions/_lib/sync-store.js";

const SECRET = "test-session-secret";
const ORIGIN = "https://olivia-loon-box.pages.dev";
const GITHUB = { GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret", SESSION_SECRET: SECRET };
const GOOGLE = { GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "google-client-secret", SESSION_SECRET: SECRET };

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const jwk = await crypto.subtle.exportKey("jwk", publicKey);
jwk.kid = "acct-k1";

function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function signJwt(payload) {
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "acct-k1" })));
  const b = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, enc.encode(`${h}.${b}`));
  return `${h}.${b}.${b64url(sig)}`;
}
function claims(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: GOOGLE.GOOGLE_CLIENT_ID,
    sub: "10001",
    email: "ada@gmail.com",
    email_verified: true,
    name: "阿达",
    picture: "https://lh3.googleusercontent.com/a/abc",
    iat: now,
    exp: now + 3600,
    ...extra,
  };
}

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.db, this.sql, p); }
  exec() {
    const st = this.db.prepare(this.sql);
    const read = /^\s*SELECT/i.test(this.sql) || /RETURNING/i.test(this.sql);
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
  return {
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try { const out = stmts.map((s) => s.exec()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}
function memoryKv() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
}
function cookieValue(res, name) {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith(name + "="));
  if (!raw || raw.includes("Max-Age=0")) return "";
  return raw.split(";")[0].slice(name.length + 1);
}
function jar(res, prev = "") {
  const map = new Map();
  for (const part of prev.split(";").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    const name = pair.slice(0, i);
    if (c.includes("Max-Age=0")) map.delete(name);
    else map.set(name, pair.slice(i + 1));
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join("; ");
}
async function sessionCookie(payload) {
  const token = await seal({ exp: Math.floor(Date.now() / 1000) + 3600, ...payload }, SECRET);
  return "mlb_session=" + token;
}
const envWith = (extra) => ({ ...GITHUB, ...GOOGLE, ...extra });

function mockGithub(id, login) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("access_token")) return Response.json({ access_token: "tok" });
    if (u.includes("api.github.com/user")) return Response.json({ id, login });
    throw new Error("unexpected " + u);
  };
}
function mockGoogle(extra) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/token")) return Response.json({ id_token: await signJwt(claims(extra)) });
    if (u.includes("/certs")) return Response.json({ keys: [jwk] }, { headers: { "cache-control": "public, max-age=3600" } });
    throw new Error("unexpected " + u);
  };
}

async function githubCallback(env, cookie, id = 42, login = "ada") {
  mockGithub(id, login);
  const start = await onGithubLogin({
    request: new Request(ORIGIN + "/api/auth/login", { headers: cookie ? { cookie } : {} }),
    env,
  });
  const next = jar(start, cookie);
  return onGithubCallback({
    request: new Request(ORIGIN + "/api/auth/callback?code=c&state=" + cookieValue(start, "mlb_state"), { headers: { cookie: next } }),
    env,
  });
}

async function finishGoogle(env, start, cookie) {
  const next = jar(start, cookie);
  return onGoogleCallback({
    request: new Request(ORIGIN + "/api/auth/google/callback?code=the-code&state=" + cookieValue(start, "mlb_state"), {
      headers: { cookie: next },
    }),
    env,
  });
}

let tail = Promise.resolve();
function serial(name, fn) {
  const prev = tail;
  let release;
  tail = new Promise((resolve) => { release = resolve; });
  test(name, async () => {
    await prev;
    resetGoogleCerts();
    try { await fn(); }
    finally { release(); }
  });
}

serial("老 GitHub 用户第一次登录后，账号 ID 仍是原来的数字，收藏还在", async () => {
  const db = fakeD1();
  const env = envWith({ MLB_DB: db });
  const old = await sessionCookie({ id: 42, login: "ada" });
  const put = await onRequestPut({
    request: new Request(ORIGIN + "/api/me", {
      method: "PUT",
      headers: { origin: ORIGIN, cookie: old, "content-type": "application/json" },
      body: JSON.stringify({ favMeta: { plugin: [10, 1] } }),
    }),
    env,
  });
  assert.equal(put.status, 200);

  const res = await githubCallback(env, "", 42, "ada");
  assert.equal(new URL(res.headers.get("Location"), ORIGIN).pathname, "/");
  const token = cookieValue(res, "mlb_session");
  const session = await unseal(token, SECRET);
  assert.equal(session.id, 42);
  assert.equal(session.login, "ada");
  assert.equal(session.provider, undefined);

  const me = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + token } }), env })).json();
  assert.deepEqual(me.data.favorites, ["plugin"]);
  const account = await (await onAccount({ request: new Request(ORIGIN + "/api/account", { headers: { cookie: "mlb_session=" + token } }), env })).json();
  assert.equal(account.accountId, "42");
  assert.deepEqual(account.identities, [{ kind: "github", login: "ada" }]);
});

serial("还没重新登录的老会话，打开账号管理时补上身份，不搬动同步数据", async () => {
  const env = envWith({ MLB_DB: fakeD1() });
  const cookie = await sessionCookie({ id: 42, login: "ada" });
  await onRequestPut({
    request: new Request(ORIGIN + "/api/me", {
      method: "PUT",
      headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
      body: JSON.stringify({ favorites: ["keep"] }),
    }),
    env,
  });
  const account = await (await onAccount({ request: new Request(ORIGIN + "/api/account", { headers: { cookie } }), env })).json();
  assert.equal(account.configured, true);
  assert.deepEqual(account.identities, [{ kind: "github", login: "ada" }]);
  const me = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie } }), env })).json();
  assert.deepEqual(me.data.favorites, ["keep"]);
  assert.equal(me.user.id, 42);
});

serial("绑定 Google 后仍用原来的账号；再用 Google 登录也回到这个账号", async () => {
  const env = envWith({ MLB_DB: fakeD1() });
  const first = await githubCallback(env, "", 42, "ada");
  const session = "mlb_session=" + cookieValue(first, "mlb_session");
  await onRequestPut({
    request: new Request(ORIGIN + "/api/me", {
      method: "PUT",
      headers: { origin: ORIGIN, cookie: session, "content-type": "application/json" },
      body: JSON.stringify({ favMeta: { plugin: [3, 1] } }),
    }),
    env,
  });

  mockGoogle({ sub: "20002", email: "bee@gmail.com", name: "蜜蜂" });
  const start = await onGoogleLogin({
    request: new Request(ORIGIN + "/api/auth/google?intent=link", {
      headers: { cookie: session, "Sec-Fetch-Mode": "navigate" },
    }),
    env,
  });
  assert.match(start.headers.get("Location"), /^https:\/\/accounts\.google\.com\//);
  assert.equal(new URL(start.headers.get("Location")).searchParams.get("code_challenge_method"), "S256");
  assert.ok(cookieValue(start, "mlb_link"));
  assert.ok(cookieValue(start, "mlb_pkce"));
  const linked = await finishGoogle(env, start, session);
  assert.match(linked.headers.get("Location"), /login=linked_google$/);
  assert.equal(cookieValue(linked, "mlb_session"), "");

  const account = await (await onAccount({ request: new Request(ORIGIN + "/api/account", { headers: { cookie: session } }), env })).json();
  assert.deepEqual(account.identities.map((i) => i.kind).sort(), ["github", "google"]);
  assert.equal(account.identities.find((i) => i.kind === "google").email, "bee@gmail.com");
  const me = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: session } }), env })).json();
  assert.deepEqual(me.data.favorites, ["plugin"]);

  mockGoogle({ sub: "20002", email: "bee@gmail.com", name: "蜜蜂" });
  const login = await onGoogleLogin({
    request: new Request(ORIGIN + "/api/auth/google", { headers: { "Sec-Fetch-Mode": "navigate" } }),
    env,
  });
  const back = await finishGoogle(env, login, "");
  const again = await unseal(cookieValue(back, "mlb_session"), SECRET);
  assert.equal(again.id, 42);
  assert.equal(again.provider, "google");
  assert.equal(again.email, "bee@gmail.com");
  const me2 = await (await onMe({
    request: new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + cookieValue(back, "mlb_session") } }),
    env,
  })).json();
  assert.deepEqual(me2.data.favorites, ["plugin"]);
  assert.equal(me2.user.id, 42);
});

serial("Google 已属于另一个账号时拒绝绑定，两边的数据都不合并", async () => {
  const env = envWith({ MLB_DB: fakeD1() });
  mockGoogle({ sub: "10001", email: "ada@gmail.com" });
  const googleStart = await onGoogleLogin({
    request: new Request(ORIGIN + "/api/auth/google", { headers: { "Sec-Fetch-Mode": "navigate" } }),
    env,
  });
  const googleLogin = await finishGoogle(env, googleStart, "");
  const googleSession = "mlb_session=" + cookieValue(googleLogin, "mlb_session");
  await onRequestPut({
    request: new Request(ORIGIN + "/api/me", {
      method: "PUT",
      headers: { origin: ORIGIN, cookie: googleSession, "content-type": "application/json" },
      body: JSON.stringify({ favMeta: { g: [1, 1] } }),
    }),
    env,
  });

  const github = await githubCallback(env, "", 42, "ada");
  const session = "mlb_session=" + cookieValue(github, "mlb_session");
  await onRequestPut({
    request: new Request(ORIGIN + "/api/me", {
      method: "PUT",
      headers: { origin: ORIGIN, cookie: session, "content-type": "application/json" },
      body: JSON.stringify({ favMeta: { gh: [2, 1] } }),
    }),
    env,
  });

  mockGoogle({ sub: "10001", email: "ada@gmail.com" });
  const start = await onGoogleLogin({
    request: new Request(ORIGIN + "/api/auth/google?intent=link", { headers: { cookie: session, "Sec-Fetch-Mode": "navigate" } }),
    env,
  });
  const linked = await finishGoogle(env, start, session);
  const loc = new URL(linked.headers.get("Location"));
  assert.equal(loc.searchParams.get("login_error"), "link_conflict");
  assert.equal(loc.searchParams.get("provider"), "google");
  assert.ok(loc.searchParams.get("pending"));
  assert.equal(cookieValue(linked, "mlb_session"), "");

  const mine = await (await onAccount({ request: new Request(ORIGIN + "/api/account", { headers: { cookie: session } }), env })).json();
  assert.deepEqual(mine.identities, [{ kind: "github", login: "ada" }]);
  const theirs = await (await onAccount({ request: new Request(ORIGIN + "/api/account", { headers: { cookie: googleSession } }), env })).json();
  assert.equal(theirs.accountId, "google:10001");
  assert.equal(theirs.identities.find((i) => i.kind === "google").email, "ada@gmail.com");
  const me = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: session } }), env })).json();
  assert.deepEqual(me.data.favorites, ["gh"]);
  const meGoogle = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: googleSession } }), env })).json();
  assert.deepEqual(meGoogle.data.favorites, ["g"]);
});

function conflictPost(cookie, token, origin = ORIGIN) {
  const headers = { cookie, "content-type": "application/json" };
  if (origin) headers.origin = origin;
  return new Request(ORIGIN + "/api/account/conflict", {
    method: "POST",
    headers,
    body: JSON.stringify({ token }),
  });
}

serial("取消确认时两个账号都还在；确认后才注销另一个账号并转走这次的登录方式", async () => {
  const passkeys = memoryKv();
  const env = envWith({ MLB_DB: fakeD1(), PASSKEYS: passkeys });
  mockGoogle({ sub: "10001", email: "ada@gmail.com" });
  const googleStart = await onGoogleLogin({
    request: new Request(ORIGIN + "/api/auth/google", { headers: { "Sec-Fetch-Mode": "navigate" } }),
    env,
  });
  const googleLogin = await finishGoogle(env, googleStart, "");
  const googleSession = "mlb_session=" + cookieValue(googleLogin, "mlb_session");
  await onRequestPut({
    request: new Request(ORIGIN + "/api/me", {
      method: "PUT",
      headers: { origin: ORIGIN, cookie: googleSession, "content-type": "application/json" },
      body: JSON.stringify({ favMeta: { g: [1, 1] } }),
    }),
    env,
  });
  await putCredential(passkeys, {
    credentialId: "other-key", userId: "google:10001", provider: "google", login: "阿达",
    name: "阿达", email: "ada@gmail.com", picture: "", coseKey: b64urlEncode(new Uint8Array([1])), alg: -7, signCount: 0, createdAt: 1,
  });
  mockGithub(99, "side");
  const sideStart = await onGithubLogin({
    request: new Request(ORIGIN + "/api/auth/login?intent=link", { headers: { cookie: googleSession } }),
    env,
  });
  const side = await onGithubCallback({
    request: new Request(ORIGIN + "/api/auth/callback?code=c&state=" + cookieValue(sideStart, "mlb_state"), {
      headers: { cookie: jar(sideStart, googleSession) },
    }),
    env,
  });
  assert.match(side.headers.get("Location"), /login=linked_github$/);

  const github = await githubCallback(env, "", 42, "ada");
  const session = "mlb_session=" + cookieValue(github, "mlb_session");
  await onRequestPut({
    request: new Request(ORIGIN + "/api/me", {
      method: "PUT",
      headers: { origin: ORIGIN, cookie: session, "content-type": "application/json" },
      body: JSON.stringify({ favMeta: { gh: [2, 1] } }),
    }),
    env,
  });
  await putCredential(passkeys, {
    credentialId: "keep-key", userId: "42", provider: "github", login: "ada",
    name: "", email: "", picture: "", coseKey: b64urlEncode(new Uint8Array([2])), alg: -7, signCount: 0, createdAt: 2,
  });

  mockGoogle({ sub: "10001", email: "ada@gmail.com" });
  const start = await onGoogleLogin({
    request: new Request(ORIGIN + "/api/auth/google?intent=link", { headers: { cookie: session, "Sec-Fetch-Mode": "navigate" } }),
    env,
  });
  const linked = await finishGoogle(env, start, session);
  const pending = new URL(linked.headers.get("Location")).searchParams.get("pending");
  assert.ok(pending);

  const mineBefore = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: session } }), env })).json();
  const otherBefore = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: googleSession } }), env })).json();
  assert.deepEqual(mineBefore.data.favorites, ["gh"]);
  assert.deepEqual(otherBefore.data.favorites, ["g"]);

  const noOrigin = await onConflict({ request: conflictPost(session, pending, ""), env });
  assert.equal(noOrigin.status, 403);
  const evil = await onConflict({ request: conflictPost(session, pending, "https://evil.example"), env });
  assert.equal(evil.status, 403);
  const expired = await seal({
    typ: "conflict", jti: "expired", accountId: "42", otherAccountId: "google:10001",
    kind: "google", subject: "10001", exp: Math.floor(Date.now() / 1000) - 30,
  }, SECRET);
  assert.equal((await onConflict({ request: conflictPost(session, expired), env })).status, 400);
  const forged = await seal({
    typ: "conflict", jti: crypto.randomUUID(), accountId: "42", otherAccountId: "google:10001",
    kind: "google", subject: "10001", exp: Math.floor(Date.now() / 1000) + 300,
  }, "wrong-secret");
  assert.equal((await onConflict({ request: conflictPost(session, forged), env })).status, 400);
  const ghost = await seal({
    typ: "conflict", jti: crypto.randomUUID(), accountId: "42", otherAccountId: "google:10001",
    kind: "google", subject: "10001", exp: Math.floor(Date.now() / 1000) + 300,
  }, SECRET);
  assert.equal((await onConflict({ request: conflictPost(session, ghost), env })).status, 400);
  const stillOther = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: googleSession } }), env })).json();
  assert.deepEqual(stillOther.data.favorites, ["g"]);
  assert.equal(stillOther.user.id, "google:10001");

  const ok = await onConflict({ request: conflictPost(session, pending), env });
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  const again = await onConflict({ request: conflictPost(session, pending), env });
  assert.equal(again.status, 400);

  const account = await (await onAccount({ request: new Request(ORIGIN + "/api/account", { headers: { cookie: session } }), env })).json();
  assert.deepEqual(account.identities.map((i) => i.kind).sort(), ["github", "google"]);
  assert.equal(account.identities.find((i) => i.kind === "github").login, "ada");
  assert.equal(account.identities.find((i) => i.kind === "google").email, "ada@gmail.com");
  assert.deepEqual(account.passkeys.map((c) => c.id), ["keep-key"]);
  assert.deepEqual(await listCredentials(passkeys, "google:10001"), []);
  const mine = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: session } }), env })).json();
  assert.deepEqual(mine.data.favorites, ["gh"]);
  assert.equal(mine.user.id, 42);
  const gone = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: googleSession } }), env })).json();
  assert.equal(gone.user, null);

  const fresh = await githubCallback(env, "", 99, "side");
  const sideSession = await unseal(cookieValue(fresh, "mlb_session"), SECRET);
  assert.equal(sideSession.id, 99);
  const sideData = await (await onMe({
    request: new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + cookieValue(fresh, "mlb_session") } }),
    env,
  })).json();
  assert.equal(sideData.data, null);
});

serial("确认凭证如果指向当前账号，不会注销当前账号", async () => {
  const env = envWith({ MLB_DB: fakeD1() });
  const cookie = await sessionCookie({ id: 42, login: "ada" });
  await onRequestPut({
    request: new Request(ORIGIN + "/api/me", {
      method: "PUT",
      headers: { origin: ORIGIN, cookie, "content-type": "application/json" },
      body: JSON.stringify({ favMeta: { keep: [4, 1] } }),
    }),
    env,
  });
  const token = await stageConflictToken(env, "42", "42", {
    kind: "github", subject: "42", label: "ada", name: "", email: "", picture: "",
  });
  const res = await onConflict({ request: conflictPost(cookie, token), env });
  assert.equal(res.status, 200);
  const me = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie } }), env })).json();
  assert.equal(me.user.id, 42);
  assert.deepEqual(me.data.favorites, ["keep"]);
});

serial("不能解绑最后一种登录方式；有通行密钥时可以解绑，解绑后的登录方式不会回到旧账号", async () => {
  const passkeys = memoryKv();
  const env = envWith({ MLB_DB: fakeD1(), PASSKEYS: passkeys });
  const first = await githubCallback(env, "", 42, "ada");
  const session = "mlb_session=" + cookieValue(first, "mlb_session");
  await onRequestPut({
    request: new Request(ORIGIN + "/api/me", {
      method: "PUT",
      headers: { origin: ORIGIN, cookie: session, "content-type": "application/json" },
      body: JSON.stringify({ favMeta: { keep: [9, 1] } }),
    }),
    env,
  });

  const blocked = await onUnlink({
    request: new Request(ORIGIN + "/api/account/identities/github", { method: "DELETE", headers: { origin: ORIGIN, cookie: session } }),
    env,
    params: { kind: "github" },
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, "last_method");

  await putCredential(passkeys, {
    credentialId: "cred1",
    userId: "42",
    provider: "github",
    login: "ada",
    name: "",
    email: "",
    picture: "",
    coseKey: b64urlEncode(new Uint8Array([1])),
    alg: -7,
    signCount: 0,
    createdAt: 1,
  });
  const removed = await onUnlink({
    request: new Request(ORIGIN + "/api/account/identities/github", { method: "DELETE", headers: { origin: ORIGIN, cookie: session } }),
    env,
    params: { kind: "github" },
  });
  assert.equal(removed.status, 200);
  const left = await (await onAccount({ request: new Request(ORIGIN + "/api/account", { headers: { cookie: session } }), env })).json();
  assert.deepEqual(left.identities, []);
  assert.equal(left.passkeys.length, 1);

  const again = await githubCallback(env, "", 42, "ada");
  const next = await unseal(cookieValue(again, "mlb_session"), SECRET);
  assert.notEqual(next.id, 42);
  assert.match(String(next.id), /^a:/);
  const oldData = await (await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: session } }), env })).json();
  assert.deepEqual(oldData.data.favorites, ["keep"]);
  const newData = await (await onMe({
    request: new Request(ORIGIN + "/api/me", { headers: { cookie: "mlb_session=" + cookieValue(again, "mlb_session") } }),
    env,
  })).json();
  assert.equal(newData.data, null);

  const lastKey = await onDeletePasskey({
    request: new Request(ORIGIN + "/api/auth/passkey/cred1", { method: "DELETE", headers: { origin: ORIGIN, cookie: session } }),
    env,
    params: { id: "cred1" },
  });
  assert.equal(lastKey.status, 409);
  assert.equal((await lastKey.json()).message, "至少保留一种登录方式");
});

serial("state 不对或绑定 Cookie 被改过时，不会登录，也不会绑上", async () => {
  const env = envWith({ MLB_DB: fakeD1() });
  const first = await githubCallback(env, "", 7, "bee");
  const session = "mlb_session=" + cookieValue(first, "mlb_session");
  mockGoogle({ sub: "30003", email: "bee@gmail.com" });
  const start = await onGoogleLogin({
    request: new Request(ORIGIN + "/api/auth/google?intent=link", { headers: { cookie: session, "Sec-Fetch-Mode": "navigate" } }),
    env,
  });
  const bad = await onGoogleCallback({
    request: new Request(ORIGIN + "/api/auth/google/callback?code=the-code&state=nope", { headers: { cookie: jar(start, session) } }),
    env,
  });
  assert.match(bad.headers.get("Location"), /login_error=google_state$/);
  const account = await (await onAccount({ request: new Request(ORIGIN + "/api/account", { headers: { cookie: session } }), env })).json();
  assert.deepEqual(account.identities.map((i) => i.kind), ["github"]);

  mockGithub(8, "other");
  const login = await onGithubLogin({
    request: new Request(ORIGIN + "/api/auth/login?intent=link", { headers: { cookie: session } }),
    env,
  });
  const tampered = jar(login, session).replace(/mlb_link=[^;]*/, "mlb_link=tampered");
  const res = await onGithubCallback({
    request: new Request(ORIGIN + "/api/auth/callback?code=c&state=" + cookieValue(login, "mlb_state"), { headers: { cookie: tampered } }),
    env,
  });
  assert.match(res.headers.get("Location"), /login_error=link_state$/);
  assert.equal(cookieValue(res, "mlb_session"), "");
  const after = await (await onAccount({ request: new Request(ORIGIN + "/api/account", { headers: { cookie: session } }), env })).json();
  assert.deepEqual(after.identities, [{ kind: "github", login: "bee" }]);
});

serial("没有 D1 时用已有的 KV 保存绑定；两个都没有时登录仍可用，但不能绑定", async () => {
  const kv = memoryKv();
  const env = envWith({ MLB_KV: kv });
  const first = await githubCallback(env, "", 42, "ada");
  const session = "mlb_session=" + cookieValue(first, "mlb_session");
  mockGoogle({ sub: "20002", email: "bee@gmail.com", name: "蜜蜂" });
  const start = await onGoogleLogin({
    request: new Request(ORIGIN + "/api/auth/google?intent=link", { headers: { cookie: session, "Sec-Fetch-Mode": "navigate" } }),
    env,
  });
  const linked = await finishGoogle(env, start, session);
  assert.match(linked.headers.get("Location"), /login=linked_google$/);
  const account = await (await onAccount({ request: new Request(ORIGIN + "/api/account", { headers: { cookie: session } }), env })).json();
  assert.equal(account.identities.find((i) => i.kind === "google").email, "bee@gmail.com");

  const bare = envWith({});
  const alone = await githubCallback(bare, "", 9, "solo");
  const solo = await unseal(cookieValue(alone, "mlb_session"), SECRET);
  assert.equal(solo.id, 9);
  const linkStart = await onGithubLogin({
    request: new Request(ORIGIN + "/api/auth/login?intent=link", { headers: { cookie: "mlb_session=" + cookieValue(alone, "mlb_session") } }),
    env: bare,
  });
  mockGithub(8, "other");
  const denied = await onGithubCallback({
    request: new Request(ORIGIN + "/api/auth/callback?code=c&state=" + cookieValue(linkStart, "mlb_state"), {
      headers: { cookie: jar(linkStart, "mlb_session=" + cookieValue(alone, "mlb_session")) },
    }),
    env: bare,
  });
  assert.match(denied.headers.get("Location"), /login_error=accounts_config$/);
  assert.equal(cookieValue(denied, "mlb_session"), "");
});
