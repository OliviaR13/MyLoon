// 通行密钥：挑战一次性、ES256 / RS256 签名、rpId / origin / UP / 计数器。
// node --test tests/passkey.test.mjs
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { seal } from "../functions/_lib/auth.js";
import { encodeCbor } from "../functions/_lib/cbor.js";
import { onRequestGet } from "../functions/api/auth/passkey/index.js";
import { onRequestPost as registerOptions } from "../functions/api/auth/passkey/register/options.js";
import { onRequestPost as registerVerify } from "../functions/api/auth/passkey/register/verify.js";
import { onRequestPost as loginOptions } from "../functions/api/auth/passkey/login/options.js";
import { onRequestPost as loginVerify } from "../functions/api/auth/passkey/login/verify.js";
import { onRequestDelete } from "../functions/api/auth/passkey/[id].js";
import { onRequestGet as onMe } from "../functions/api/me.js";
import { putCredential } from "../functions/_lib/passkeys.js";
import { b64urlDecode, b64urlEncode, counterOk, rpIdFromHost } from "../functions/_lib/webauthn.js";

const SECRET = "test-session-secret";
const ORIGIN = "https://olivia-loon-box.pages.dev";
const RP_ID = "olivia-loon-box.pages.dev";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  return { prepare(sql) {
    let params = [];
    const stmt = db.prepare(sql);
    const api = {
      bind(...values) { params = values; return api; },
      async run() { stmt.run(...params); return { results: [] }; },
      async all() { return { results: stmt.all(...params) }; },
      async first() { return stmt.get(...params) || null; },
    };
    return api;
  } };
}

function memoryKv() {
  const m = new Map();
  const kv = {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
  kv.DB = fakeD1();
  return kv;
}

function envWith(kv = memoryKv()) {
  return { PASSKEYS: kv, SESSION_SECRET: SECRET, MLB_DB: kv.DB };
}

function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function authData({ rpId, flags, signCount, credId, cose }) {
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
  const head = new Uint8Array(37);
  head.set(rpHash, 0);
  head[32] = flags;
  new DataView(head.buffer).setUint32(33, signCount);
  if ((flags & 0x40) === 0) return head;
  const idLen = new Uint8Array(2);
  new DataView(idLen.buffer).setUint16(0, credId.length);
  const coseBytes = cose instanceof Uint8Array ? cose : encodeCbor(cose);
  return concat(head, new Uint8Array(16), idLen, credId, coseBytes);
}

function clientData(type, challenge, origin) {
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

function rawToDer(raw) {
  const int = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0] & 0x80) v = concat(Uint8Array.of(0), v);
    return concat(Uint8Array.of(0x02, v.length), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

async function signEs256(privateKey, data) {
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data));
  return rawToDer(raw);
}

function coseEc(jwk) {
  return new Map([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, b64urlDecode(jwk.x)],
    [-3, b64urlDecode(jwk.y)],
  ]);
}

function coseRsa(jwk) {
  return new Map([
    [1, 3],
    [3, -257],
    [-1, b64urlDecode(jwk.n)],
    [-2, b64urlDecode(jwk.e)],
  ]);
}

async function es256Pair() {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return { ...kp, jwk: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}

async function sessionCookie(user) {
  const token = await seal({ ...user, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return `mlb_session=${token}`;
}

function post(url, body, cookie) {
  const headers = { origin: new URL(url).origin, "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return new Request(url, { method: "POST", headers, body: body ? JSON.stringify(body) : "{}" });
}

function withChal(cookie, res) {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith("mlb_chal=") && !c.includes("Max-Age=0"));
  const chal = raw ? raw.split(";")[0] : "";
  return [cookie, chal].filter(Boolean).join("; ");
}

test("RP ID 取主机名，IP 地址不行，预览子域和 localhost 可以", () => {
  assert.equal(rpIdFromHost("olivia-loon-box.pages.dev"), "olivia-loon-box.pages.dev");
  assert.equal(rpIdFromHost("abc.olivia-loon-box.pages.dev"), "abc.olivia-loon-box.pages.dev");
  assert.equal(rpIdFromHost("localhost"), "localhost");
  assert.equal(rpIdFromHost("127.0.0.1"), null);
  assert.equal(rpIdFromHost("::1"), null);
  assert.equal(counterOk(0, 0), true);
  assert.equal(counterOk(0, 1), true);
  assert.equal(counterOk(2, 2), false);
  assert.equal(counterOk(3, 2), false);
});

test("没绑定 PASSKEYS 或没有 SESSION_SECRET 时返回明确错误", async () => {
  const url = ORIGIN + "/api/auth/passkey/login/options";
  const res = await loginOptions({ request: post(url), env: { SESSION_SECRET: SECRET } });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, "passkeys_not_configured");
  assert.match(body.message, /PASSKEYS/);
  const status = await onRequestGet({ request: new Request(ORIGIN + "/api/auth/passkey"), env: {} });
  const listed = await status.json();
  assert.equal(listed.enabled, false);
  assert.match(listed.message, /PASSKEYS/);
  assert.match(listed.message, /SESSION_SECRET/);
});

test("ES256 注册后可以用通行密钥登录，挑战不能再用", async () => {
  const kv = memoryKv();
  const env = envWith(kv);
  const cookie = await sessionCookie({ id: 42, login: "ada" });
  const optRes = await registerOptions({
    request: post(ORIGIN + "/api/auth/passkey/register/options", {}, cookie),
    env,
  });
  assert.equal(optRes.status, 200);
  const opt = await optRes.json();
  assert.equal(opt.rp.id, RP_ID);
  assert.equal(opt.authenticatorSelection.residentKey, "required");

  const pair = await es256Pair();
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const cose = coseEc(pair.jwk);
  const regAuth = await authData({ rpId: RP_ID, flags: 0x41, signCount: 0, credId, cose });
  const regClient = clientData("webauthn.create", opt.challenge, ORIGIN);
  const regBody = {
    type: "public-key",
    rawId: b64urlEncode(credId),
    response: {
      clientDataJSON: b64urlEncode(regClient),
      attestationObject: b64urlEncode(encodeCbor(new Map([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", regAuth],
      ]))),
    },
  };
  const reg = await registerVerify({
    request: post(ORIGIN + "/api/auth/passkey/register/verify", regBody, withChal(cookie, optRes)),
    env,
  });
  assert.equal(reg.status, 200, JSON.stringify(await reg.clone().json()));
  const again = await registerVerify({
    request: post(ORIGIN + "/api/auth/passkey/register/verify", regBody, withChal(cookie, optRes)),
    env,
  });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error, "challenge");

  const loginOptRes = await loginOptions({
    request: post(ORIGIN + "/api/auth/passkey/login/options", {}),
    env,
  });
  const loginOpt = await loginOptRes.json();
  const loginAuth = await authData({ rpId: RP_ID, flags: 0x01, signCount: 1 });
  const loginClient = clientData("webauthn.get", loginOpt.challenge, ORIGIN);
  const signed = concat(loginAuth, new Uint8Array(await crypto.subtle.digest("SHA-256", loginClient)));
  const signature = await signEs256(pair.privateKey, signed);
  const loginRes = await loginVerify({
    request: post(ORIGIN + "/api/auth/passkey/login/verify", {
      type: "public-key",
      rawId: b64urlEncode(credId),
      response: {
        clientDataJSON: b64urlEncode(loginClient),
        authenticatorData: b64urlEncode(loginAuth),
        signature: b64urlEncode(signature),
        userHandle: b64urlEncode(new TextEncoder().encode("42")),
      },
    }, withChal("", loginOptRes)),
    env,
  });
  assert.equal(loginRes.status, 200, JSON.stringify(await loginRes.clone().json()));
  const set = loginRes.headers.get("Set-Cookie");
  assert.match(set, /mlb_session=/);
  const me = await onMe({
    request: new Request(ORIGIN + "/api/me", { headers: { cookie: set.split(";")[0] } }),
    env,
  });
  const meBody = await me.json();
  assert.equal(meBody.user.login, "ada");
  assert.equal(meBody.user.id, 42);
  assert.equal(meBody.user.provider, "github");

  const replay = await loginVerify({
    request: post(ORIGIN + "/api/auth/passkey/login/verify", {
      type: "public-key",
      rawId: b64urlEncode(credId),
      response: {
        clientDataJSON: b64urlEncode(loginClient),
        authenticatorData: b64urlEncode(loginAuth),
        signature: b64urlEncode(signature),
      },
    }),
    env,
  });
  assert.equal((await replay.json()).error, "challenge");
});

test("错误的签名、来源、UP 和 rpIdHash 都会拒绝", async () => {
  const kv = memoryKv();
  const env = envWith(kv);
  const cookie = await sessionCookie({ id: 7, login: "bee", provider: "google", name: "蜜蜂", email: "bee@gmail.com", picture: "https://lh3.googleusercontent.com/a/bee" });
  const optRes = await registerOptions({
    request: post(ORIGIN + "/api/auth/passkey/register/options", {}, cookie),
    env,
  });
  const opt = await optRes.json();
  const pair = await es256Pair();
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const regAuth = await authData({ rpId: RP_ID, flags: 0x45, signCount: 0, credId, cose: coseEc(pair.jwk) });
  const regClient = clientData("webauthn.create", opt.challenge, ORIGIN);
  assert.equal((await registerVerify({
    request: post(ORIGIN + "/api/auth/passkey/register/verify", {
      type: "public-key",
      rawId: b64urlEncode(credId),
      response: {
        clientDataJSON: b64urlEncode(regClient),
        attestationObject: b64urlEncode(encodeCbor(new Map([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", regAuth],
        ]))),
      },
    }, withChal(cookie, optRes)),
    env,
  })).status, 200);

  async function loginWith({ rpId = RP_ID, origin = ORIGIN, flags = 0x01, signCount = 1, mutate } = {}) {
    const loginOptRes = await loginOptions({
      request: post(ORIGIN + "/api/auth/passkey/login/options", {}),
      env,
    });
    const loginOpt = await loginOptRes.json();
    const loginAuth = await authData({ rpId, flags, signCount });
    const loginClient = clientData("webauthn.get", loginOpt.challenge, origin);
    const signed = concat(loginAuth, new Uint8Array(await crypto.subtle.digest("SHA-256", loginClient)));
    let signature = await signEs256(pair.privateKey, signed);
    if (mutate) signature = mutate(signature);
    return loginVerify({
      request: post(ORIGIN + "/api/auth/passkey/login/verify", {
        type: "public-key",
        rawId: b64urlEncode(credId),
        response: {
          clientDataJSON: b64urlEncode(loginClient),
          authenticatorData: b64urlEncode(loginAuth),
          signature: b64urlEncode(signature),
        },
      }, withChal("", loginOptRes)),
      env,
    });
  }

  const badSig = await loginWith({ mutate: (sig) => { const c = new Uint8Array(sig); c[c.length - 1] ^= 1; return c; } });
  assert.equal((await badSig.json()).error, "signature");
  const badOrigin = await loginWith({ origin: "https://evil.example" });
  assert.equal((await badOrigin.json()).error, "origin");
  const noUp = await loginWith({ flags: 0x00 });
  assert.equal((await noUp.json()).error, "user_present");
  const badRp = await loginWith({ rpId: "evil.example" });
  assert.equal((await badRp.json()).error, "rp_id");

  const ok = await loginWith({ signCount: 4 });
  assert.equal(ok.status, 200);
  const me = await onMe({
    request: new Request(ORIGIN + "/api/me", { headers: { cookie: ok.headers.get("Set-Cookie").split(";")[0] } }),
    env,
  });
  const user = (await me.json()).user;
  assert.equal(user.provider, "google");
  assert.equal(user.email, "bee@gmail.com");
  assert.equal(user.name, "蜜蜂");

  const cloned = await loginWith({ signCount: 4 });
  assert.equal((await cloned.json()).error, "counter");
  const back = await loginWith({ signCount: 3 });
  assert.equal((await back.json()).error, "counter");
});

test("RS256 公钥可以注册并登录", async () => {
  const kv = memoryKv();
  const env = envWith(kv);
  const cookie = await sessionCookie({ id: 9, login: "rsa" });
  const optRes = await registerOptions({
    request: post(ORIGIN + "/api/auth/passkey/register/options", {}, cookie),
    env,
  });
  const opt = await optRes.json();
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const regAuth = await authData({ rpId: RP_ID, flags: 0x41, signCount: 0, credId, cose: coseRsa(jwk) });
  const regClient = clientData("webauthn.create", opt.challenge, ORIGIN);
  const reg = await registerVerify({
    request: post(ORIGIN + "/api/auth/passkey/register/verify", {
      type: "public-key",
      rawId: b64urlEncode(credId),
      response: {
        clientDataJSON: b64urlEncode(regClient),
        attestationObject: b64urlEncode(encodeCbor(new Map([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", regAuth],
        ]))),
      },
    }, withChal(cookie, optRes)),
    env,
  });
  assert.equal(reg.status, 200, JSON.stringify(await reg.clone().json()));

  const loginOptRes = await loginOptions({
    request: post(ORIGIN + "/api/auth/passkey/login/options", {}),
    env,
  });
  const loginOpt = await loginOptRes.json();
  const loginAuth = await authData({ rpId: RP_ID, flags: 0x01, signCount: 0 });
  const loginClient = clientData("webauthn.get", loginOpt.challenge, ORIGIN);
  const signed = concat(loginAuth, new Uint8Array(await crypto.subtle.digest("SHA-256", loginClient)));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, signed));
  const loginRes = await loginVerify({
    request: post(ORIGIN + "/api/auth/passkey/login/verify", {
      type: "public-key",
      rawId: b64urlEncode(credId),
      response: {
        clientDataJSON: b64urlEncode(loginClient),
        authenticatorData: b64urlEncode(loginAuth),
        signature: b64urlEncode(signature),
      },
    }, withChal("", loginOptRes)),
    env,
  });
  assert.equal(loginRes.status, 200, JSON.stringify(await loginRes.clone().json()));
});

test("未登录不能注册；可以移除自己的通行密钥；IP 主机被拒绝", async () => {
  const kv = memoryKv();
  const env = envWith(kv);
  const anon = await registerOptions({
    request: post(ORIGIN + "/api/auth/passkey/register/options", {}),
    env,
  });
  assert.equal(anon.status, 401);

  const cookie = await sessionCookie({ id: 3, login: "cat" });
  const optRes = await registerOptions({
    request: post(ORIGIN + "/api/auth/passkey/register/options", {}, cookie),
    env,
  });
  const opt = await optRes.json();
  const pair = await es256Pair();
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const regClient = clientData("webauthn.create", opt.challenge, ORIGIN);
  const reg = await registerVerify({
    request: post(ORIGIN + "/api/auth/passkey/register/verify", {
      type: "public-key",
      rawId: b64urlEncode(credId),
      response: {
        clientDataJSON: b64urlEncode(regClient),
        attestationObject: b64urlEncode(encodeCbor(new Map([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", await authData({ rpId: RP_ID, flags: 0x41, signCount: 0, credId, cose: coseEc(pair.jwk) })],
        ]))),
      },
    }, withChal(cookie, optRes)),
    env,
  });
  const { id } = await reg.json();
  const listed = await (await onRequestGet({
    request: new Request(ORIGIN + "/api/auth/passkey", { headers: { cookie } }),
    env,
  })).json();
  assert.deepEqual(listed.credentials.map((c) => c.id), [id]);

  const removed = await onRequestDelete({
    request: new Request(ORIGIN + "/api/auth/passkey/" + id, { method: "DELETE", headers: { origin: ORIGIN, cookie } }),
    env,
    params: { id },
  });
  assert.equal(removed.status, 200);
  const after = await (await onRequestGet({
    request: new Request(ORIGIN + "/api/auth/passkey", { headers: { cookie } }),
    env,
  })).json();
  assert.deepEqual(after.credentials, []);

  const ip = await loginOptions({
    request: post("http://127.0.0.1/api/auth/passkey/login/options", {}),
    env,
  });
  assert.equal(ip.status, 400);
  assert.equal((await ip.json()).error, "rp_id");

  const preview = await (await loginOptions({
    request: post("https://abc123.olivia-loon-box.pages.dev/api/auth/passkey/login/options", {}),
    env,
  })).json();
  assert.equal(preview.rpId, "abc123.olivia-loon-box.pages.dev");
});

test("超过 8 把通行密钥时拒绝再添加", async () => {
  const kv = memoryKv();
  const profile = { userId: "3", provider: "github", login: "cat", name: "", email: "", picture: "" };
  for (let i = 0; i < 8; i++) {
    await putCredential(kv, { ...profile, credentialId: "k" + i, coseKey: b64urlEncode(new Uint8Array([1])), alg: -7, signCount: 0, createdAt: i });
  }
  await assert.rejects(() => putCredential(kv, { ...profile, credentialId: "k9", coseKey: "AA", alg: -7, signCount: 0, createdAt: 9 }), (err) => err.code === "too_many");
  await assert.rejects(() => putCredential(kv, { ...profile, credentialId: "k0", coseKey: "AA", alg: -7, signCount: 0, createdAt: 10 }), (err) => err.code === "credential_exists");
});

test("已有 8 把通行密钥时，注册选项直接返回 too_many，不再弹出验证", async () => {
  const kv = memoryKv();
  const env = envWith(kv);
  const profile = { userId: "5", provider: "github", login: "dog", name: "", email: "", picture: "" };
  for (let i = 0; i < 8; i++) {
    await putCredential(kv, { ...profile, credentialId: "d" + i, coseKey: b64urlEncode(new Uint8Array([1])), alg: -7, signCount: 0, createdAt: i + 1 });
  }
  const cookie = await sessionCookie({ id: 5, login: "dog" });
  const res = await registerOptions({
    request: post(ORIGIN + "/api/auth/passkey/register/options", {}, cookie),
    env,
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "too_many");
});
