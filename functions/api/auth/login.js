// GET /api/auth/login：跳转到 GitHub 授权页（不申请任何额外权限，只读公开资料）
import { cookie } from "../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  if (!env.GITHUB_CLIENT_ID || !env.SESSION_SECRET) return new Response("login_not_configured", { status: 500 });
  const state = crypto.randomUUID();
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", new URL("/api/auth/callback", request.url).href);
  url.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { Location: url.href, "Set-Cookie": cookie("mlb_state", state, { maxAge: 600, path: "/api/auth" }), "cache-control": "no-store" },
  });
}
