// GET /api/account/deletion/status：只读这张一次性票据对应的注销申请，不消耗票据。
import { json } from "../../../_lib/auth.js";
import { clearDeletionCookie, deletionStatus, readDeletionTicket, settleDeletion } from "../../../_lib/account-deletion.js";
import { deletionDbError } from "../../../_lib/deletion-http.js";

export async function onRequestGet({ request, env }) {
  const unavailable = deletionDbError(env);
  if (unavailable) return unavailable;
  const ticket = await readDeletionTicket(request, env);
  if (!ticket) return json({ error: "unauthorized" }, 401);
  const gate = await settleDeletion(env, ticket.accountId);
  if (gate.action === "deleted") {
    const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    headers.append("Set-Cookie", clearDeletionCookie());
    return new Response(JSON.stringify({ error: "account_deleted" }), { status: 410, headers });
  }
  if (gate.action === "unavailable") return json({ error: "storage_error" }, 500);
  const status = await deletionStatus(env, ticket.accountId);
  if (!status || status.due) return json({ error: "account_deleted" }, 410);
  return json(status);
}
