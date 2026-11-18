// GET /api/auth/google
// - 页面用 fetch（Accept: application/json，且不是整页跳转）询问登录是否已配置。
//   没配齐 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET 时返回 { enabled: false }，不报 500。
// - 浏览器点「Google 登录」跳到这里时，签发 state 与 PKCE，再转到 Google 授权页。
import { cookie, json } from "../../../_lib/auth.js";
import { codeChallenge, googleConfigured, googleRedirectUri, randomToken } from "../../../_lib/google-auth.js";

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

  const state = crypto.randomUUID();
  const verifier = randomToken();
  const challenge = await codeChallenge(verifier);
  const redirectUri = googleRedirectUri(request);
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");

  const headers = new Headers({ Location: url.href, "cache-control": "no-store" });
  headers.append("Set-Cookie", cookie("mlb_state", state, { maxAge: 600, path: "/api/auth" }));
  headers.append("Set-Cookie", cookie("mlb_pkce", verifier, { maxAge: 600, path: "/api/auth" }));
  return new Response(null, { status: 302, headers });
}
