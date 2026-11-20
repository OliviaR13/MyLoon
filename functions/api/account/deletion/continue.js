// POST /api/account/deletion/continue：消耗票据并退出。不改申请时间，也不重新计算 14 天。
import { json, sameOrigin } from "../../../_lib/auth.js";
import { clearDeletionCookie, consumeDeletionTicket } from "../../../_lib/account-deletion.js";
import { rateLimit } from "../../../_lib/rate-limit.js";
import { deletionDbError } from "../../../_lib/deletion-http.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const unavailable = deletionDbError(env);
  if (unavailable) return unavailable;
  const limited = await rateLimit(request, env, "account-delete-act");
  if (limited) return limited;
  const accountId = await consumeDeletionTicket(request, env);
  if (!accountId) return json({ error: "unauthorized" }, 401);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  headers.append("Set-Cookie", clearDeletionCookie());
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
