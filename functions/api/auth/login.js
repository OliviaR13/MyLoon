// GET /api/auth/login：跳转到 GitHub 授权页（不申请任何额外权限，只读公开资料）
// ?intent=link 表示已登录用户要把 GitHub 绑到当前账号，而不是换一个账号登录。
import { cookie, clearCookie, getSessionOr503 } from "../../_lib/auth.js";
import { sealLinkIntent, sessionAccountId } from "../../_lib/accounts.js";
import { codeChallenge, randomToken } from "../../_lib/google-auth.js";
import { rateLimit } from "../../_lib/rate-limit.js";

export async function onRequestGet({ request, env }) {
  if (!env.GITHUB_CLIENT_ID || !env.SESSION_SECRET) {
    return new Response(null, { status: 302, headers: { Location: "/?login_error=config", "cache-control": "no-store" } });
  }
  const limited = await rateLimit(request, env, "auth-github");
  if (limited) return limited;
  const link = new URL(request.url).searchParams.get("intent") === "link";
  const headers = new Headers({ "cache-control": "no-store" });
  if (link) {
    const got = await getSessionOr503(request, env);
    if (got.response) return got.response;
    const user = got.user;
    const accountId = sessionAccountId(user);
    if (!accountId) {
      headers.set("Location", "/?login_error=link_state");
      return new Response(null, { status: 302, headers });
    }
    headers.append("Set-Cookie", cookie("mlb_link", await sealLinkIntent(accountId, env.SESSION_SECRET), { maxAge: 600, path: "/api/auth" }));
  } else {
    headers.append("Set-Cookie", clearCookie("mlb_link", "/api/auth"));
  }
  const state = crypto.randomUUID();
  const verifier = randomToken();
  const challenge = await codeChallenge(verifier);
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", new URL("/api/auth/callback", request.url).href);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  headers.set("Location", url.href);
  headers.append("Set-Cookie", cookie("mlb_state", state, { maxAge: 600, path: "/api/auth" }));
  headers.append("Set-Cookie", cookie("mlb_gh_pkce", verifier, { maxAge: 600, path: "/api/auth" }));
  return new Response(null, { status: 302, headers });
}
