// Google 登录：ID Token 校验、授权跳转、回调发 Cookie。node --test tests/google-auth.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { onRequestGet } from "../functions/api/auth/google/index.js";
import { onRequestGet as onCallback } from "../functions/api/auth/google/callback.js";
import { onRequestGet as onMe } from "../functions/api/me.js";
import { unseal } from "../functions/_lib/auth.js";
import {
  codeChallenge,
  publicSessionUser,
  resetGoogleCerts,
  safeGooglePicture,
  verifyGoogleIdToken,
} from "../functions/_lib/google-auth.js";

const CLIENT_ID = "123-abc.apps.googleusercontent.com";
const SECRET = "test-session-secret";
const ENV = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "google-client-secret", SESSION_SECRET: SECRET };
const ORIGIN = "https://olivia-loon-box.pages.dev";

const { publicKey, privateKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const jwk = await crypto.subtle.exportKey("jwk", publicKey);
jwk.kid = "k1";

const { privateKey: otherKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);

function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwt(key, payload, kid = "k1", alg = "RS256") {
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg, typ: "JWT", kid })));
  const b = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${b}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

function claims(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    sub: "10001",
    email: "Ada@Gmail.com",
    email_verified: true,
    name: "阿达",
    picture: "https://lh3.googleusercontent.com/a/abc=s96-c",
    iat: now,
    exp: now + 3600,
    ...extra,
  };
}

function certsResponse(keys = [jwk]) {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
  });
}

// 测试体会改全局 fetch 和证书缓存，按定义顺序串行跑，避免互相覆盖。
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

serial("头像地址只接受 Google 的 https 图片", () => {
  assert.equal(safeGooglePicture("https://lh3.googleusercontent.com/a/x"), "https://lh3.googleusercontent.com/a/x");
  assert.equal(safeGooglePicture("http://lh3.googleusercontent.com/a/x"), "");
  assert.equal(safeGooglePicture("https://evil.example/a.png"), "");
  assert.equal(safeGooglePicture("javascript:alert(1)"), "");
});

serial("PKCE challenge 是 verifier 的 SHA-256", async () => {
  const challenge = await codeChallenge("abc");
  assert.equal(challenge, "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
});

serial("合法的 ID Token 能解出小写邮箱、名字和头像", async () => {
  const token = await signJwt(privateKey, claims());
  globalThis.fetch = async () => certsResponse();
  const profile = await verifyGoogleIdToken(token, CLIENT_ID);
  assert.equal(profile.sub, "10001");
  assert.equal(profile.email, "ada@gmail.com");
  assert.equal(profile.name, "阿达");
  assert.match(profile.picture, /^https:\/\/lh3\.googleusercontent\.com\//);
});

serial("受众、签发者、过期、未验证邮箱、错误签名、alg=none 都拒绝", async () => {
  globalThis.fetch = async () => certsResponse();
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await verifyGoogleIdToken(await signJwt(privateKey, claims({ aud: "other" })), CLIENT_ID), null);
  assert.equal(await verifyGoogleIdToken(await signJwt(privateKey, claims({ iss: "https://evil.example" })), CLIENT_ID), null);
  assert.equal(await verifyGoogleIdToken(await signJwt(privateKey, claims({ exp: now - 120 })), CLIENT_ID), null);
  assert.equal(await verifyGoogleIdToken(await signJwt(privateKey, claims({ email_verified: false })), CLIENT_ID), null);
  assert.equal(await verifyGoogleIdToken(await signJwt(privateKey, claims({ azp: "other-client" })), CLIENT_ID), null);
  assert.equal(await verifyGoogleIdToken(await signJwt(otherKey, claims()), CLIENT_ID), null);
  assert.equal(await verifyGoogleIdToken(await signJwt(privateKey, claims(), "k1", "none"), CLIENT_ID), null);
  const okAud = await verifyGoogleIdToken(await signJwt(privateKey, claims({ aud: [CLIENT_ID, "extra"] })), CLIENT_ID);
  assert.equal(okAud.email, "ada@gmail.com");
});

serial("非 https 头像不会写进资料，邮箱仍可用", async () => {
  globalThis.fetch = async () => certsResponse();
  const profile = await verifyGoogleIdToken(await signJwt(privateKey, claims({ picture: "http://lh3.googleusercontent.com/a/x" })), CLIENT_ID);
  assert.equal(profile.picture, "");
  assert.equal(profile.email, "ada@gmail.com");
});

serial("没配齐环境变量时返回 enabled:false，跳转则回到首页说明未配置", async () => {
  const url = ORIGIN + "/api/auth/google";
  const partial = { GOOGLE_CLIENT_ID: CLIENT_ID, SESSION_SECRET: SECRET };
  const probe = await onRequestGet({
    request: new Request(url, { headers: { Accept: "application/json" } }),
    env: partial,
  });
  assert.equal(probe.status, 200);
  const body = await probe.json();
  assert.deepEqual(body, { enabled: false });
  assert.equal(JSON.stringify(body).includes(CLIENT_ID), false);

  const nav = await onRequestGet({
    request: new Request(url, { headers: { "Sec-Fetch-Mode": "navigate", Accept: "text/html,application/json" } }),
    env: {},
  });
  assert.equal(nav.status, 302);
  assert.match(nav.headers.get("Location"), /login_error=google_config$/);
});

serial("配齐之后，页面询问得到 enabled:true，浏览器跳转才去 Google", async () => {
  const url = ORIGIN + "/api/auth/google";
  const probe = await onRequestGet({
    request: new Request(url, { headers: { Accept: "application/json", "Sec-Fetch-Mode": "cors" } }),
    env: ENV,
  });
  assert.deepEqual(await probe.json(), { enabled: true });

  const nav = await onRequestGet({
    request: new Request(url, { headers: { "Sec-Fetch-Mode": "navigate", Accept: "text/html,application/json" } }),
    env: ENV,
  });
  assert.equal(nav.status, 302);
  const loc = new URL(nav.headers.get("Location"));
  assert.equal(loc.origin + loc.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(loc.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(loc.searchParams.get("redirect_uri"), ORIGIN + "/api/auth/google/callback");
  assert.equal(loc.searchParams.get("response_type"), "code");
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  assert.equal(loc.searchParams.get("scope"), "openid email profile");
  assert.equal(loc.searchParams.has("client_secret"), false);
  const cookies = nav.headers.getSetCookie();
  assert.equal(cookies.some((c) => c.startsWith("mlb_state=") && c.includes("HttpOnly") && c.includes("Path=/api/auth")), true);
  assert.equal(cookies.some((c) => c.startsWith("mlb_pkce=") && c.includes("HttpOnly")), true);
});

function callbackRequest(query, cookie = "mlb_state=st; mlb_pkce=verifier") {
  return new Request(ORIGIN + "/api/auth/google/callback?" + query, { headers: { Cookie: cookie } });
}

serial("用户取消授权、state 不对、换票失败，都不会发登录 Cookie", async () => {
  const denied = await onCallback({ request: callbackRequest("error=access_denied"), env: ENV });
  assert.match(denied.headers.get("Location"), /login_error=google_denied$/);
  assert.equal(denied.headers.getSetCookie().some((c) => c.startsWith("mlb_session=")), false);

  const badState = await onCallback({ request: callbackRequest("code=abc&state=nope"), env: ENV });
  assert.match(badState.headers.get("Location"), /login_error=google_state$/);

  globalThis.fetch = async () => new Response("no", { status: 400 });
  const exchanged = await onCallback({ request: callbackRequest("code=abc&state=st"), env: ENV });
  assert.match(exchanged.headers.get("Location"), /login_error=google_exchange$/);
  assert.equal(exchanged.headers.getSetCookie().some((c) => c.includes("mlb_session=") && !c.includes("Max-Age=0")), false);
});

serial("回调校验通过后写入 Google 会话，/api/me 能读出名字和头像", async () => {
  const token = await signJwt(privateKey, claims());
  let posted = "";
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("oauth2.googleapis.com/token")) {
      posted = String(init.body);
      return new Response(JSON.stringify({ id_token: token, access_token: "should-not-leak" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/oauth2/v3/certs")) return certsResponse();
    throw new Error("unexpected " + u);
  };
  const res = await onCallback({ request: callbackRequest("code=the-code&state=st"), env: ENV });
  assert.match(res.headers.get("Location"), /\/\?login=google$/);
  assert.match(posted, /code=the-code/);
  assert.match(posted, /code_verifier=verifier/);
  assert.match(posted, /client_secret=google-client-secret/);
  assert.match(posted, new RegExp("redirect_uri=" + encodeURIComponent(ORIGIN + "/api/auth/google/callback").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(res.headers.get("Location").includes("should-not-leak"), false);
  assert.equal(res.headers.get("Location").includes("the-code"), false);

  const raw = res.headers.getSetCookie().find((c) => c.startsWith("mlb_session="));
  const sessionToken = raw.split(";")[0].slice("mlb_session=".length);
  const session = await unseal(sessionToken, SECRET);
  assert.equal(session.provider, "google");
  assert.equal(session.id, "google:10001");
  assert.equal(session.name, "阿达");
  assert.equal(session.email, "ada@gmail.com");
  assert.match(session.picture, /^https:\/\/lh3\.googleusercontent\.com\//);
  assert.equal(session.access_token, undefined);

  const me = await onMe({
    request: new Request(ORIGIN + "/api/me", { headers: { Cookie: `mlb_session=${sessionToken}` } }),
    env: { SESSION_SECRET: SECRET },
  });
  const { user } = await me.json();
  assert.equal(user.provider, "google");
  assert.equal(user.name, "阿达");
  assert.equal(user.email, "ada@gmail.com");
  assert.match(user.picture, /^https:\/\/lh3\.googleusercontent\.com\//);
});

serial("签名不对的 ID Token 不会登录", async () => {
  const token = await signJwt(otherKey, claims());
  globalThis.fetch = async (url) => {
    if (String(url).includes("/token")) {
      return new Response(JSON.stringify({ id_token: token }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return certsResponse();
  };
  const res = await onCallback({ request: callbackRequest("code=abc&state=st"), env: ENV });
  assert.match(res.headers.get("Location"), /login_error=google_verify$/);
  assert.equal(res.headers.getSetCookie().some((c) => c.startsWith("mlb_session=") && c.includes("Max-Age=2592000")), false);
});

serial("GitHub 老会话仍只返回用户名，不会被当成 Google", () => {
  const user = publicSessionUser({ id: 42, login: "tester" });
  assert.equal(user.provider, "github");
  assert.equal(user.name, "tester");
  assert.equal(user.picture, "");
  assert.equal(user.email, "");
});
