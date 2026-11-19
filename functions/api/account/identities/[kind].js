// DELETE /api/account/identities/:kind：解绑 GitHub 或 Google。至少留一种登录方式。
import { getSessionOr503, json, rotateSession, sameOrigin } from "../../../_lib/auth.js";
import { openAccountStore, passkeyCount, sessionAccountId } from "../../../_lib/accounts.js";

const MESSAGES = {
  last_method: "至少保留一种登录方式",
  not_linked: "还没有绑定这个账号",
  accounts_not_configured: "需要绑定 D1（MLB_DB）或 KV（MLB_KV）才能管理登录方式",
};

export async function onRequestDelete({ request, env, params }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const got = await getSessionOr503(request, env);
  if (got.response) return got.response;
  const user = got.user;
  if (!user) return json({ error: "unauthorized" }, 401);
  const kind = String(params?.kind || "");
  if (kind !== "github" && kind !== "google") return json({ error: "not_linked", message: MESSAGES.not_linked }, 404);
  const store = openAccountStore(env);
  if (!store) return json({ error: "accounts_not_configured", message: MESSAGES.accounts_not_configured }, 503);
  try {
    const accountId = sessionAccountId(user);
    await store.ensureFromSession(user);
    const extra = await passkeyCount(env, accountId);
    await store.unlink(accountId, kind, extra);
    return json({ ok: true }, 200, { "Set-Cookie": await rotateSession(env, user) });
  } catch (err) {
    const code = err?.code;
    if (code === "last_method") return json({ error: code, message: MESSAGES.last_method }, 409);
    if (code === "not_linked") return json({ error: code, message: MESSAGES.not_linked }, 404);
    return json({ error: "storage_error" }, 500);
  }
}
