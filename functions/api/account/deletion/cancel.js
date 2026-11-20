// POST /api/account/deletion/cancel：消耗一次性票据，且只有 status=pending 才能取消。
import { cookie, issueSession, json, sameOrigin, SESSION_TTL } from "../../../_lib/auth.js";
import { cancelWithTicket, clearDeletionCookie, deletionStatus, readDeletionTicket } from "../../../_lib/account-deletion.js";
import { openAccountStore, sessionPayload } from "../../../_lib/accounts.js";
import { rateLimit } from "../../../_lib/rate-limit.js";
import { deletionDbError } from "../../../_lib/deletion-http.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const unavailable = deletionDbError(env);
  if (unavailable) return unavailable;
  const limited = await rateLimit(request, env, "account-delete-act");
  if (limited) return limited;
  const ticket = await readDeletionTicket(request, env);
  if (!ticket) return json({ error: "unauthorized", message: "请重新登录后再取消注销" }, 401);
  const accountId = ticket.accountId;
  try {
    await cancelWithTicket(env, ticket);
  } catch (err) {
    if (err?.code === "deletion_in_progress") return json({ error: "deletion_in_progress", message: "账号正在删除，不能取消" }, 409);
    if (err?.code === "not_pending") return json({ error: "not_pending" }, 409);
    return json({ error: "storage_error" }, 500);
  }
  const status = await deletionStatus(env, accountId);
  if (status) return json({ error: "storage_error" }, 500);
  const identities = await openAccountStore(env)?.list(accountId) || [];
  const identity = identities[0];
  const profile = identity
    ? { kind: identity.kind, subject: identity.subject, label: identity.label, name: identity.name, email: identity.email, picture: identity.picture }
    : { kind: "github", label: "用户", subject: String(accountId) };
  const session = await issueSession(env, sessionPayload(accountId, profile));
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  headers.append("Set-Cookie", clearDeletionCookie());
  headers.append("Set-Cookie", cookie("mlb_session", session, { maxAge: SESSION_TTL }));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
