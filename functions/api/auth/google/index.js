// GET /api/auth/google
// - 页面用 fetch（Accept: application/json，且不是整页跳转）询问登录是否已配置。
//   没配齐 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET 时返回 { enabled: false }，不报 500。
// - 浏览器点「Google 登录」跳到这里时，签发 state 与 PKCE，再转到 Google 授权页。
import { clearCookie, cookie, getSessionOr503, json } from "../../../_lib/auth.js";
import { sealLinkIntent, sessionAccountId } from "../../../_lib/accounts.js";
import { codeChallenge, googleConfigured, googleRedirectUri, randomToken } from "../../../_lib/google-auth.js";
import { rateLimit } from "../../../_lib/rate-limit.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

function wantsConfig(request) {
  if (request.headers.get("Sec-Fetch-Mode") === "navigate") return false;
  return (request.headers.get("Accept") || "").toLowerCase().includes("application/json");
}

export async function onRequestGet({ request, env }) {
  const enabled = googleConfigured(env);
  if (wantsConfig(request)) return json({ enabled }, 200, { vary: "Accept" });
  if (!enabled) {
    return new Response(null, {
      status: 302,
      headers: { Location: new URL("/?login_error=google_config", request.url).href, "cache-control": "no-store" },
    });
  }

  const limited = await rateLimit(request, env, "auth-google");
  if (limited) return limited;
  const link = new URL(request.url).searchParams.get("intent") === "link";
  const headers = new Headers({ "cache-control": "no-store" });
  if (link) {
    const got = await getSessionOr503(request, env);
    if (got.response) return got.response;
    const user = got.user;
    const accountId = sessionAccountId(user);
    if (!accountId) {
      headers.set("Location", new URL("/?login_error=link_state", request.url).href);
      return new Response(null, { status: 302, headers });
    }
    headers.append("Set-Cookie", cookie("mlb_link", await sealLinkIntent(accountId, env.SESSION_SECRET), { maxAge: 600, path: "/api/auth" }));
  } else {
    headers.append("Set-Cookie", clearCookie("mlb_link", "/api/auth"));
  }

  const state = crypto.randomUUID();
  const nonce = randomToken(16);
  const verifier = randomToken();
  const challenge = await codeChallenge(verifier);
  const redirectUri = googleRedirectUri(request);
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");

  headers.set("Location", url.href);
  headers.append("Set-Cookie", cookie("mlb_state", state, { maxAge: 600, path: "/api/auth" }));
  headers.append("Set-Cookie", cookie("mlb_nonce", nonce, { maxAge: 600, path: "/api/auth" }));
  headers.append("Set-Cookie", cookie("mlb_pkce", verifier, { maxAge: 600, path: "/api/auth" }));
  return new Response(null, { status: 302, headers });
}
