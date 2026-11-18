// GET /api/auth/google/callback：Google 授权后带 code 回来。
// 核对 state，用授权码换 ID Token，校验签名后再写下登录 Cookie。访问令牌不保存。
import { SESSION_TTL, clearCookie, cookie, getCookie, getSession, seal } from "../../../_lib/auth.js";
import { googleProfile, issueConflictToken, linkAccount, loginAccount, readLinkIntent, sessionAccountId, sessionPayload } from "../../../_lib/accounts.js";
import { exchangeGoogleCode, googleRedirectUri, verifyGoogleIdToken } from "../../../_lib/google-auth.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const fail = (reason) => {
    const headers = new Headers({
      Location: new URL("/?login_error=" + reason, request.url).href,
      "cache-control": "no-store",
    });
    headers.append("Set-Cookie", clearCookie("mlb_state", "/api/auth"));
    headers.append("Set-Cookie", clearCookie("mlb_pkce", "/api/auth"));
    headers.append("Set-Cookie", clearCookie("mlb_link", "/api/auth"));
    return new Response(null, { status: 302, headers });
  };

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.SESSION_SECRET) return fail("google_config");

  const oauthError = url.searchParams.get("error");
  if (oauthError) return fail(oauthError === "access_denied" ? "google_denied" : "google_exchange");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const verifier = getCookie(request, "mlb_pkce");
  if (!code || code.length > 2048 || !state || state !== getCookie(request, "mlb_state") || !verifier) return fail("google_state");

  const link = await readLinkIntent(request, env);
  if (link.present && !link.valid) return fail("link_state");

  const redirectUri = googleRedirectUri(request);
  let idToken;
  try {
    idToken = await exchangeGoogleCode({
      code,
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      redirectUri,
      codeVerifier: verifier,
    });
  } catch {
    return fail("google_exchange");
  }
  if (!idToken) return fail("google_exchange");

  let profile;
  try {
    profile = await verifyGoogleIdToken(idToken, env.GOOGLE_CLIENT_ID);
  } catch {
    return fail("google_verify");
  }
  if (!profile) return fail("google_verify");
  const identity = googleProfile(profile);
  if (!identity) return fail("google_verify");

  if (link.present) {
    const sessionUser = await getSession(request, env);
    if (!sessionUser || sessionAccountId(sessionUser) !== link.accountId) return fail("link_state");
    try {
      await linkAccount(env, sessionUser, identity);
    } catch (err) {
      if (err?.code === "conflict") {
        let token = "";
        try { token = await issueConflictToken(env, sessionUser, identity); } catch { token = ""; }
        const pending = token ? "&pending=" + encodeURIComponent(token) : "";
        return fail("link_conflict&provider=google" + pending);
      }
      if (err?.code === "already_linked") return fail("already_linked&provider=google");
      if (err?.code === "accounts_not_configured") return fail("accounts_config");
      return fail("storage");
    }
    const headers = new Headers({
      Location: new URL("/?login=linked_google", request.url).href,
      "cache-control": "no-store",
    });
    headers.append("Set-Cookie", clearCookie("mlb_state", "/api/auth"));
    headers.append("Set-Cookie", clearCookie("mlb_pkce", "/api/auth"));
    headers.append("Set-Cookie", clearCookie("mlb_link", "/api/auth"));
    return new Response(null, { status: 302, headers });
  }

  let accountId;
  try {
    accountId = await loginAccount(env, identity);
  } catch {
    return fail("storage");
  }
  const session = await seal(sessionPayload(accountId, identity), env.SESSION_SECRET);
  const headers = new Headers({
    Location: new URL("/?login=google", request.url).href,
    "cache-control": "no-store",
  });
  headers.append("Set-Cookie", clearCookie("mlb_state", "/api/auth"));
  headers.append("Set-Cookie", clearCookie("mlb_pkce", "/api/auth"));
  headers.append("Set-Cookie", clearCookie("mlb_link", "/api/auth"));
  headers.append("Set-Cookie", cookie("mlb_session", session, { maxAge: SESSION_TTL }));
  return new Response(null, { status: 302, headers });
}
