// GET /api/auth/callback：GitHub 授权后回调，换取用户身份并下发登录 Cookie。
// GitHub 的访问令牌只用来读一次用户名，不保存。
// 带了有效的 mlb_link 时，把这个 GitHub 账号绑到当前会话，不更换账号 ID。
import { SESSION_TTL, clearCookie, cookie, getCookie, getSession, seal } from "../../_lib/auth.js";
import { githubProfile, issueConflictToken, linkAccount, loginAccount, readLinkIntent, sessionAccountId, sessionPayload } from "../../_lib/accounts.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const fail = (reason) => {
    const headers = new Headers({ Location: "/?login_error=" + reason, "cache-control": "no-store" });
    headers.append("Set-Cookie", clearCookie("mlb_state", "/api/auth"));
    headers.append("Set-Cookie", clearCookie("mlb_link", "/api/auth"));
    return new Response(null, { status: 302, headers });
  };

  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) return fail("config");
  if (!code || !state || state !== getCookie(request, "mlb_state")) return fail("state");

  const link = await readLinkIntent(request, env);
  if (link.present && !link.valid) return fail("link_state");

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

  const allowed = (env.ALLOWED_USERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(user.login).toLowerCase())) return fail("denied");

  const profile = githubProfile(user);
  if (!profile) return fail("user");

  if (link.present) {
    const session = await getSession(request, env);
    if (!session || sessionAccountId(session) !== link.accountId) return fail("link_state");
    try {
      await linkAccount(env, session, profile);
    } catch (err) {
      if (err?.code === "conflict") {
        let token = "";
        try { token = await issueConflictToken(env, session, profile); } catch { token = ""; }
        const pending = token ? "&pending=" + encodeURIComponent(token) : "";
        return fail("link_conflict&provider=github" + pending);
      }
      if (err?.code === "already_linked") return fail("already_linked&provider=github");
      if (err?.code === "accounts_not_configured") return fail("accounts_config");
      return fail("storage");
    }
    const headers = new Headers({ Location: "/?login=linked_github", "cache-control": "no-store" });
    headers.append("Set-Cookie", clearCookie("mlb_state", "/api/auth"));
    headers.append("Set-Cookie", clearCookie("mlb_link", "/api/auth"));
    return new Response(null, { status: 302, headers });
  }

  let accountId;
  try {
    accountId = await loginAccount(env, profile);
  } catch {
    return fail("storage");
  }
  const session = await seal(sessionPayload(accountId, profile), env.SESSION_SECRET);
  const headers = new Headers({ Location: "/?login=github", "cache-control": "no-store" });
  headers.append("Set-Cookie", clearCookie("mlb_state", "/api/auth"));
  headers.append("Set-Cookie", clearCookie("mlb_link", "/api/auth"));
  headers.append("Set-Cookie", cookie("mlb_session", session, { maxAge: SESSION_TTL }));
  return new Response(null, { status: 302, headers });
}
