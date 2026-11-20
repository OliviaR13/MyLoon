// 注销冷静期：申请、拦截登录、取消、到期删除、失败恢复、并发。
// node --test tests/account-deletion.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cookie, getSession, issueSession } from "../functions/_lib/auth.js";
import {
  DELETION_GRACE_MS,
  cancelDeletion,
  loginGate,
  purgeAccount,
  purgeDueAccounts,
  requestDeletion,
} from "../functions/_lib/account-deletion.js";
import { conflictMarker, confirmConflict, linkAccount, loginAccount, stageConflictToken } from "../functions/_lib/accounts.js";
import { encodeCbor } from "../functions/_lib/cbor.js";
import { putCredential } from "../functions/_lib/passkeys.js";
import { resetSyncCache } from "../functions/_lib/sync-store.js";
import { b64urlDecode, b64urlEncode } from "../functions/_lib/webauthn.js";
import { onRequestGet as onMe, onRequestPut } from "../functions/api/me.js";
import { onRequestGet as githubCallback } from "../functions/api/auth/callback.js";
import { onRequestGet as googleCallback } from "../functions/api/auth/google/callback.js";
import { onRequestPost as loginOptions } from "../functions/api/auth/passkey/login/options.js";
import { onRequestPost as loginVerify } from "../functions/api/auth/passkey/login/verify.js";
import { onRequestPost as registerVerify } from "../functions/api/auth/passkey/register/verify.js";
import { onRequestPost as createDeletion } from "../functions/api/account/deletion/index.js";
import { onRequestPost as deletionOptions } from "../functions/api/account/deletion/options.js";
import { onRequestGet as deletionStatus } from "../functions/api/account/deletion/status.js";
import { onRequestPost as cancelRoute } from "../functions/api/account/deletion/cancel.js";
import { onRequestPost as continueRoute } from "../functions/api/account/deletion/continue.js";

const SECRET = "test-session-secret";
const ORIGIN = "https://olivia-loon-box.pages.dev";
const DAY = 24 * 60 * 60 * 1000;

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
  return {
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try { const out = stmts.map((s) => s.exec()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    raw: db,
  };
}
function memoryKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    async get(k, type) {
      if (!m.has(k)) return null;
      const value = m.get(k);
      if (type === "json") {
        try { return JSON.parse(value); } catch { return null; }
      }
      return value;
    },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map((name) => ({ name })), list_complete: true }; },
    dump: m,
  };
}
function envBase(extra = {}) {
  return { SESSION_SECRET: SECRET, MLB_DB: fakeD1(), MLB_KV: memoryKv(), PASSKEYS: memoryKv(), ...extra };
}
function post(url, body, cookieHeader = "") {
  return new Request(url, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", cookie: cookieHeader },
    body: JSON.stringify(body ?? {}),
  });
}
async function sessionFor(env, id, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  const token = await issueSession(env, { id, login: "ada", exp: now + 3600, ra: now, ...extra });
  return `mlb_session=${token}`;
}
function setCookie(res, name) {
  return res.headers.getSetCookie().find((c) => c.startsWith(name + "=")) || "";
}
async function row(env, id) {
  return env.MLB_DB.prepare("SELECT * FROM account_deletions WHERE user_id = ?1").bind(id).first();
}

test("没有 D1 时注销失败关闭", async () => {
  const env = { SESSION_SECRET: SECRET };
  const res = await createDeletion({ request: post(ORIGIN + "/api/account/deletion", {}), env });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "deletion_unavailable");
});

test("正常提交后进入冷静期，重复提交不改日期，旧会话立即失效", async () => {
  const env = envBase();
  const cookieHeader = await sessionFor(env, "42");
  const first = await createDeletion({
    request: post(ORIGIN + "/api/account/deletion", { userId: "someone-else", scheduledAt: 1 }, cookieHeader),
    env,
  });
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.status, "pending");
  assert.equal(body.scheduledAt - body.requestedAt, DELETION_GRACE_MS);
  assert.match(setCookie(first, "mlb_session"), /Max-Age=0/);
  const saved = await row(env, "42");
  assert.equal(saved.status, "pending");
  assert.equal(saved.requested_at, body.requestedAt);
  assert.equal(saved.scheduled_at, body.scheduledAt);
  assert.equal(await row(env, "someone-else"), null);
  await assert.rejects(() => requestDeletion(env, "42"), (err) => err.code === "already_pending");
  const still = await row(env, "42");
  assert.equal(still.requested_at, saved.requested_at);
  assert.equal(still.scheduled_at, saved.scheduled_at);
  const again = await createDeletion({
    request: post(ORIGIN + "/api/account/deletion", { userId: "someone-else" }, cookieHeader),
    env,
  });
  assert.equal(again.status, 401);

  const old = await getSession(new Request(ORIGIN + "/api/me", { headers: { cookie: cookieHeader } }), env);
  assert.equal(old, null);
  const me = await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: cookieHeader } }), env });
  assert.equal((await me.json()).user, null);
  const put = await onRequestPut({
    request: post(ORIGIN + "/api/me", { favorites: ["x"] }, cookieHeader),
    env,
  });
  assert.equal(put.status, 401);
  const reg = await registerVerify({
    request: post(ORIGIN + "/api/auth/passkey/register/verify", { rawId: "aa" }, cookieHeader),
    env,
  });
  assert.equal(reg.status, 401);
});

test("GitHub、Google 和通行密钥登录都停在注销页，不发正常会话", async () => {
  const env = envBase({
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
  });
  await requestDeletion(env, "42");
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("access_token")) return Response.json({ access_token: "tok" });
    if (u.includes("api.github.com/user")) return Response.json({ id: 42, login: "ada" });
    throw new Error("unexpected");
  };
  try {
    const gh = await githubCallback({
      request: new Request(ORIGIN + "/api/auth/callback?code=c&state=st", {
        headers: { cookie: "mlb_state=st; mlb_gh_pkce=verifier" },
      }),
      env,
    });
    assert.equal(gh.status, 302);
    assert.equal(new URL(gh.headers.get("location"), ORIGIN).pathname, "/deletion.html");
    assert.match(setCookie(gh, "mlb_deletion"), /^mlb_deletion=/);
    assert.match(setCookie(gh, "mlb_session"), /Max-Age=0/);
  } finally {
    globalThis.fetch = previousFetch;
  }

  await requestDeletion(env, "google:10001");
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  jwk.kid = "del-k1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "del-k1" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "google-client",
    sub: "10001",
    email: "ada@gmail.com",
    email_verified: true,
    name: "阿达",
    nonce: "nonce-1",
    iat: now,
    exp: now + 600,
  })).toString("base64url");
  const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${header}.${payload}`))).toString("base64url");
  const jwt = `${header}.${payload}.${sig}`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com/token")) return Response.json({ id_token: jwt });
    if (u.includes("oauth2/v3/certs")) return Response.json({ keys: [jwk] });
    throw new Error("unexpected");
  };
  try {
    const g = await googleCallback({
      request: new Request(ORIGIN + "/api/auth/google/callback?code=c&state=st", {
        headers: { cookie: "mlb_state=st; mlb_pkce=verifier; mlb_nonce=nonce-1" },
      }),
      env,
    });
    assert.equal(g.status, 302);
    assert.equal(new URL(g.headers.get("location"), ORIGIN).pathname, "/deletion.html");
    assert.match(setCookie(g, "mlb_deletion"), /^mlb_deletion=/);
    assert.match(setCookie(g, "mlb_session"), /Max-Age=0/);
  } finally {
    globalThis.fetch = previousFetch;
  }

  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, b64urlDecode(pub.x)], [-3, b64urlDecode(pub.y)]]);
  await putCredential(env.PASSKEYS, {
    credentialId: b64urlEncode(credId),
    userId: "42",
    login: "ada",
    coseKey: b64urlEncode(encodeCbor(cose)),
    signCount: 0,
  }, env.MLB_DB);
  const optRes = await loginOptions({ request: post(ORIGIN + "/api/auth/passkey/login/options", {}), env });
  const opt = await optRes.json();
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("olivia-loon-box.pages.dev")));
  const authData = new Uint8Array(37);
  authData.set(rpHash, 0);
  authData[32] = 0x01;
  new DataView(authData.buffer).setUint32(33, 1);
  const client = new TextEncoder().encode(JSON.stringify({
    type: "webauthn.get",
    challenge: opt.challenge,
    origin: ORIGIN,
    crossOrigin: false,
  }));
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData, 0);
  signed.set(new Uint8Array(await crypto.subtle.digest("SHA-256", client)), authData.length);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
  const derInt = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0] & 0x80) v = Uint8Array.of(0, ...v);
    return Uint8Array.of(0x02, v.length, ...v);
  };
  const body = Uint8Array.of(...derInt(raw.slice(0, 32)), ...derInt(raw.slice(32)));
  const signature = Uint8Array.of(0x30, body.length, ...body);
  const chal = setCookie(optRes, "mlb_chal").split(";")[0];
  const pk = await loginVerify({
    request: post(ORIGIN + "/api/auth/passkey/login/verify", {
      type: "public-key",
      rawId: b64urlEncode(credId),
      response: {
        clientDataJSON: b64urlEncode(client),
        authenticatorData: b64urlEncode(authData),
        signature: b64urlEncode(signature),
      },
    }, chal),
    env,
  });
  assert.equal(pk.status, 200);
  assert.equal((await pk.json()).pendingDeletion, true);
  assert.match(setCookie(pk, "mlb_deletion"), /^mlb_deletion=/);
  assert.equal(setCookie(pk, "mlb_session"), "");
});

test("继续注销不改日期；取消后能登录，再次申请重新计算 14 天", async () => {
  const env = envBase();
  await requestDeletion(env, "42");
  const before = await row(env, "42");
  const gate = await loginGate(env, "42");
  assert.equal(gate.action, "pending");
  const ticket = gate.cookie.split(";")[0];
  const kept = await continueRoute({
    request: post(ORIGIN + "/api/account/deletion/continue", {}, ticket),
    env,
  });
  assert.equal(kept.status, 200);
  const afterContinue = await row(env, "42");
  assert.equal(afterContinue.status, "pending");
  assert.equal(afterContinue.requested_at, before.requested_at);
  assert.equal(afterContinue.scheduled_at, before.scheduled_at);
  const spent = await deletionStatus({
    request: new Request(ORIGIN + "/api/account/deletion/status", { headers: { cookie: ticket } }),
    env,
  });
  assert.equal(spent.status, 401);

  const again = await loginGate(env, "42");
  const status = await deletionStatus({
    request: new Request(ORIGIN + "/api/account/deletion/status", { headers: { cookie: again.cookie.split(";")[0] } }),
    env,
  });
  assert.equal(status.status, 200);
  const view = await status.json();
  assert.equal(view.requestedAt, before.requested_at);
  assert.ok(view.remainingDays >= 13 && view.remainingDays <= 14);

  const fresh = await loginGate(env, "42");
  const cancelled = await cancelRoute({
    request: post(ORIGIN + "/api/account/deletion/cancel", {}, fresh.cookie.split(";")[0]),
    env,
  });
  assert.equal(cancelled.status, 200);
  assert.match(setCookie(cancelled, "mlb_session"), /^mlb_session=/);
  const restored = await row(env, "42");
  assert.equal(restored.status, "cancelled");
  assert.equal(restored.scheduled_at, null);
  assert.ok(restored.cancelled_at > 0);
  const sessionCookie = setCookie(cancelled, "mlb_session").split(";")[0];
  const me = await onMe({ request: new Request(ORIGIN + "/api/me", { headers: { cookie: sessionCookie } }), env });
  assert.equal(String((await me.json()).user.id), "42");
  const reuse = await cancelRoute({
    request: post(ORIGIN + "/api/account/deletion/cancel", {}, fresh.cookie.split(";")[0]),
    env,
  });
  assert.equal(reuse.status, 401);

  const freshSession = await sessionFor(env, "42");
  const next = await createDeletion({
    request: post(ORIGIN + "/api/account/deletion", {}, freshSession),
    env,
  });
  assert.equal(next.status, 200);
  const renewed = await row(env, "42");
  assert.equal(renewed.status, "pending");
  assert.ok(renewed.requested_at > before.requested_at);
  assert.equal(renewed.scheduled_at - renewed.requested_at, DELETION_GRACE_MS);
  assert.ok(renewed.scheduled_at > before.scheduled_at);
});

test("未到期不删除；到期删掉该用户的全部关联数据，重复执行和其他用户不受影响", async () => {
  const env = envBase();
  await requestDeletion(env, "victim");
  await requestDeletion(env, "other");
  await env.MLB_DB.batch([
    env.MLB_DB.prepare(`CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)`),
    env.MLB_DB.prepare(`CREATE TABLE IF NOT EXISTS identities (
      kind TEXT NOT NULL, subject TEXT NOT NULL, account_id TEXT NOT NULL,
      label TEXT, name TEXT, email TEXT, picture TEXT, linked_at INTEGER,
      PRIMARY KEY (kind, subject))`),
    env.MLB_DB.prepare(`CREATE TABLE IF NOT EXISTS user_favs (
      uid TEXT NOT NULL, plugin_id TEXT NOT NULL, on_flag INTEGER NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (uid, plugin_id))`),
    env.MLB_DB.prepare(`CREATE TABLE IF NOT EXISTS user_settings (
      uid TEXT NOT NULL, grp TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (uid, grp))`),
  ]);
  const now = Date.now();
  await env.MLB_DB.prepare("INSERT INTO accounts (id, created_at) VALUES (?1, ?2)").bind("victim", now).run();
  await env.MLB_DB.prepare("INSERT INTO accounts (id, created_at) VALUES (?1, ?2)").bind("other", now).run();
  await env.MLB_DB.prepare(
    "INSERT INTO identities (kind, subject, account_id, label, linked_at) VALUES ('github', '9', 'victim', 'ada', ?1)",
  ).bind(now).run();
  await env.MLB_DB.prepare(
    "INSERT INTO identities (kind, subject, account_id, label, linked_at) VALUES ('github', '8', 'other', 'bee', ?1)",
  ).bind(now).run();
  await env.MLB_DB.prepare("INSERT INTO user_favs (uid, plugin_id, on_flag, at) VALUES ('victim', 'p', 1, ?1)").bind(now).run();
  await env.MLB_DB.prepare("INSERT INTO user_favs (uid, plugin_id, on_flag, at) VALUES ('other', 'p', 1, ?1)").bind(now).run();
  await env.MLB_DB.prepare("INSERT INTO user_settings (uid, grp, data, at) VALUES ('victim', 'look', '{}', ?1)").bind(now).run();
  await env.MLB_KV.put("u:victim", "{}");
  await env.MLB_KV.put("acct:victim", JSON.stringify({ identities: { github: { subject: "9" } } }));
  await env.MLB_KV.put("acct:id:github:9", "victim");
  await env.MLB_KV.put("u:other", "{}");
  const credId = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  await putCredential(env.PASSKEYS, {
    credentialId: credId, userId: "victim", coseKey: b64urlEncode(new Uint8Array([1])), signCount: 0,
  }, env.MLB_DB);
  await putCredential(env.PASSKEYS, {
    credentialId: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    userId: "other", coseKey: b64urlEncode(new Uint8Array([1])), signCount: 0,
  }, env.MLB_DB);

  const early = await purgeDueAccounts(env, now);
  assert.equal(early, 0);
  assert.equal((await row(env, "victim")).status, "pending");
  assert.ok(await env.MLB_DB.prepare("SELECT uid FROM user_favs WHERE uid = 'victim'").first());

  await env.MLB_DB.prepare("UPDATE account_deletions SET scheduled_at = ?1 WHERE user_id = 'victim'").bind(now - DAY).run();
  const done = await purgeDueAccounts(env, now);
  assert.equal(done, 1);
  assert.equal((await row(env, "victim")).status, "completed");
  assert.equal(await env.MLB_DB.prepare("SELECT id FROM accounts WHERE id = 'victim'").first(), null);
  assert.equal(await env.MLB_DB.prepare("SELECT account_id FROM identities WHERE account_id = 'victim'").first(), null);
  assert.equal(await env.MLB_DB.prepare("SELECT uid FROM user_favs WHERE uid = 'victim'").first(), null);
  assert.equal(await env.MLB_DB.prepare("SELECT uid FROM user_settings WHERE uid = 'victim'").first(), null);
  assert.equal(await env.MLB_DB.prepare("SELECT credential_id FROM passkey_credential_claims WHERE user_id = 'victim'").first(), null);
  assert.equal(await env.PASSKEYS.get("user:victim"), null);
  assert.equal(await env.PASSKEYS.get("cred:" + credId), null);
  assert.equal(await env.MLB_KV.get("u:victim"), null);
  assert.equal(await env.MLB_KV.get("acct:victim"), null);
  assert.equal(await env.MLB_KV.get("acct:id:github:9"), null);
  assert.ok(await env.MLB_DB.prepare("SELECT id FROM deleted_accounts WHERE id = 'victim'").first());

  assert.equal((await row(env, "other")).status, "pending");
  assert.ok(await env.MLB_DB.prepare("SELECT id FROM accounts WHERE id = 'other'").first());
  assert.ok(await env.MLB_DB.prepare("SELECT uid FROM user_favs WHERE uid = 'other'").first());
  assert.equal(await env.MLB_KV.get("u:other"), "{}");
  assert.ok(await env.PASSKEYS.get("user:other"));

  assert.equal(await purgeDueAccounts(env, now), 0);
  assert.equal((await row(env, "victim")).status, "completed");
});

test("删除中途失败后下次可以继续，取消和删除不会同时成功", async () => {
  const env = envBase();
  await requestDeletion(env, "victim");
  const now = Date.now();
  await env.MLB_DB.prepare("UPDATE account_deletions SET scheduled_at = ?1 WHERE user_id = 'victim'").bind(now - 1000).run();
  let fail = true;
  const original = env.PASSKEYS.delete.bind(env.PASSKEYS);
  env.PASSKEYS.delete = async (key) => {
    if (fail) throw new Error("kv down");
    return original(key);
  };
  await assert.rejects(() => purgeAccount(env, "victim", now), /kv down/);
  assert.equal((await row(env, "victim")).status, "purging");
  assert.equal(await purgeAccount(env, "victim", now + 1000), false);

  fail = false;
  assert.equal(await purgeAccount(env, "victim", now + 6 * 60 * 1000), true);
  assert.equal((await row(env, "victim")).status, "completed");

  const env2 = envBase();
  await requestDeletion(env2, "race");
  const start = Date.now();
  await env2.MLB_DB.prepare("UPDATE account_deletions SET scheduled_at = ?1 WHERE user_id = 'race'").bind(start - 1000).run();
  const [cancelled, purged] = await Promise.allSettled([
    cancelDeletion(env2, "race", start),
    purgeAccount(env2, "race", start),
  ]);
  const cancelOk = cancelled.status === "fulfilled";
  const purgeOk = purged.status === "fulfilled" && purged.value === true;
  assert.equal(Number(cancelOk) + Number(purgeOk), 1);
  const final = await row(env2, "race");
  assert.ok(final.status === "cancelled" || final.status === "completed");
});

test("旧会话、绑定和冲突确认都不能绕过冷静期，有通行密钥时必须用通行密钥确认", async () => {
  const env = envBase();
  await loginAccount(env, { kind: "github", subject: "9", label: "ada", name: "阿达", email: "", picture: "" });
  await requestDeletion(env, "9");
  await assert.rejects(
    () => linkAccount(env, { id: "mine" }, { kind: "github", subject: "9", label: "ada", name: "阿达", email: "", picture: "" }),
    (err) => err.code === "pending_deletion",
  );
  const token = await stageConflictToken(env, "mine", "9", {
    kind: "github", subject: "9", label: "ada", name: "阿达", email: "", picture: "",
  });
  const marker = await conflictMarker(token);
  await assert.rejects(
    () => confirmConflict(env, { id: "mine" }, token, marker),
    (err) => err.code === "pending_deletion",
  );

  const session = await sessionFor(env, "pk");
  await putCredential(env.PASSKEYS, {
    credentialId: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    userId: "pk",
    coseKey: b64urlEncode(new Uint8Array([1])),
    signCount: 0,
  }, env.MLB_DB);
  const opt = await deletionOptions({ request: post(ORIGIN + "/api/account/deletion/options", {}, session), env });
  assert.equal(opt.status, 200);
  assert.equal((await opt.json()).mode, "passkey");
  const denied = await createDeletion({ request: post(ORIGIN + "/api/account/deletion", {}, session), env });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, "reauth_required");
  const noTicket = await cancelRoute({ request: post(ORIGIN + "/api/account/deletion/cancel", {}, session), env });
  assert.equal(noTicket.status, 401);
});

test("未重新验证不能申请；票据只属于拿到它的账号", async () => {
  const env = envBase();
  const now = Math.floor(Date.now() / 1000);
  const stale = await issueSession(env, { id: "42", login: "ada", exp: now + 3600 });
  const denied = await createDeletion({
    request: post(ORIGIN + "/api/account/deletion", {}, `mlb_session=${stale}`),
    env,
  });
  assert.equal(denied.status, 401);
  assert.equal(await row(env, "42"), null);

  await requestDeletion(env, "42");
  const gate = await loginGate(env, "42");
  const other = await deletionStatus({
    request: new Request(ORIGIN + "/api/account/deletion/status", { headers: { cookie: gate.cookie.split(";")[0] } }),
    env,
  });
  const body = await other.json();
  assert.equal(body.userId, undefined);
  assert.equal(body.requestedAt > 0, true);
  assert.equal(setCookie(other, "mlb_deletion"), "");
});
