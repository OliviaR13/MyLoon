// GET /api/auth/callback：GitHub 授权后回调，换取用户身份并下发登录 Cookie
// GitHub 的访问令牌只用来读一次用户名，不保存。
import { SESSION_TTL, cookie, getCookie, seal } from "../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const clearState = cookie("mlb_state", "", { maxAge: 0, path: "/api/auth" });
  const fail = (reason) => new Response(null, { status: 302, headers: { Location: "/?login_error=" + reason, "Set-Cookie": clearState } });

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) return fail("config");
  if (!code || !state || state !== getCookie(request, "mlb_state")) return fail("state");

  let accessToken;
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
      signal: AbortSignal.timeout(10000),
    });
    accessToken = (await res.json()).access_token;
  } catch {
    return fail("exchange");
  }
  if (!accessToken) return fail("token");

  let user;
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "olivia-loon-box" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error("user " + res.status);
    user = await res.json();
  } catch {
    return fail("user");
  }

  // 可选：ALLOWED_USERS 为空则任何 GitHub 账号都可登录
  const allowed = (env.ALLOWED_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(user.login).toLowerCase())) return fail("denied");

  const session = await seal({ id: user.id, login: user.login, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }, env.SESSION_SECRET);
  const headers = new Headers({ Location: "/", "cache-control": "no-store" });
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", cookie("mlb_session", session, { maxAge: SESSION_TTL }));
  return new Response(null, { status: 302, headers });
}
