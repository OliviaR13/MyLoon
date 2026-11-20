// POST /api/account/deletion：当前登录用户申请 14 天冷静期注销。
// 有通行密钥时，这次请求必须带上刚完成的通行密钥断言。
// 没有通行密钥时，会话必须在 10 分钟内通过 GitHub 或 Google 重新登录（ra）。
import { clearCookie, getSessionOr503, json, sameOrigin } from "../../../_lib/auth.js";
import { sessionAccountId } from "../../../_lib/accounts.js";
import { reauthFresh, requestDeletion } from "../../../_lib/account-deletion.js";
import { rateLimit } from "../../../_lib/rate-limit.js";
import { assertDeletionPasskey, deletionDbError } from "../../../_lib/deletion-http.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const unavailable = deletionDbError(env);
  if (unavailable) return unavailable;
  const limited = await rateLimit(request, env, "account-delete");
  if (limited) return limited;
  const got = await getSessionOr503(request, env);
  if (got.response) return got.response;
  const user = got.user;
  const accountId = sessionAccountId(user);
  if (!accountId) return json({ error: "unauthorized" }, 401);
  const proved = await assertDeletionPasskey(request, env, user);
  if (proved.response) return proved.response;
  if (!proved.passkey && !reauthFresh(user)) {
    return json({ error: "reauth_required", message: "请先重新登录，确认是你本人" }, 401);
  }
  try {
    const row = await requestDeletion(env, accountId);
    const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    headers.append("Set-Cookie", clearCookie("mlb_session"));
    return new Response(JSON.stringify({ ok: true, ...row }), { status: 200, headers });
  } catch (err) {
    if (err?.code === "already_pending") return json({ error: "already_pending", message: "注销申请已在进行中" }, 409);
    if (err?.code === "deletion_in_progress") return json({ error: "deletion_in_progress" }, 409);
    if (err?.code === "account_deleted") return json({ error: "account_deleted" }, 403);
    return json({ error: "storage_error" }, 500);
  }
}
