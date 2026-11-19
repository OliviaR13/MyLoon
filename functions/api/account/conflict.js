// POST /api/account/conflict：确认注销另一个账号，并把刚授权的登录方式转到当前账号。
// 必须带上这次 OAuth 冲突发下来的一次性签名 token，并且 Origin 必须是本站。
import { getCookie, getSessionOr503, json } from "../../_lib/auth.js";
import { confirmConflict } from "../../_lib/accounts.js";
import { rateLimit } from "../../_lib/rate-limit.js";

function strictOrigin(request) {
  const origin = request.headers.get("Origin");
  return !!origin && origin === new URL(request.url).origin;
}

export async function onRequestPost({ request, env }) {
  if (!strictOrigin(request)) return json({ error: "forbidden" }, 403);
  const limited = await rateLimit(request, env, "conflict");
  if (limited) return limited;
  const got = await getSessionOr503(request, env);
  if (got.response) return got.response;
  const user = got.user;
  if (!user) return json({ error: "unauthorized" }, 401);
  const text = await request.text();
  if (text.length > 8192) return json({ error: "too_large" }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: "bad_json" }, 400); }
  const token = body?.token;
  if (typeof token !== "string" || token.length < 20 || token.length > 4000) return json({ error: "pending", message: "这次确认已经失效，请重新绑定" }, 400);
  try {
    await confirmConflict(env, user, token, getCookie(request, "mlb_conflict"));
    return json({ ok: true });
  } catch (err) {
    if (err?.code === "pending" || err?.code === "already_linked") {
      return json({ error: err.code, message: "这次确认已经失效，请重新绑定" }, 400);
    }
    return json({ error: "storage_error" }, 500);
  }
}
