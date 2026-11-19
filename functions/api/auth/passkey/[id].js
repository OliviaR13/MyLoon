// DELETE /api/auth/passkey/:id：移除当前账号的一把通行密钥。
import { getSessionOr503, json, rotateSession, sameOrigin } from "../../../_lib/auth.js";
import { assertPasskeyRemovable } from "../../../_lib/accounts.js";
import { deleteCredential, listCredentials } from "../../../_lib/passkeys.js";
import { unavailable } from "../../../_lib/passkey-http.js";

export async function onRequestDelete({ request, env, params }) {
  const missing = unavailable(env);
  if (missing) return missing;
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const got = await getSessionOr503(request, env);
  if (got.response) return got.response;
  const user = got.user;
  if (!user) return json({ error: "unauthorized" }, 401);
  const id = String(params?.id || "");
  if (!/^[-_A-Za-z0-9]+$/.test(id) || id.length > 1024) return json({ error: "credential" }, 400);
  try {
    const creds = await listCredentials(env.PASSKEYS, user.id);
    if (!creds.some((c) => c.id === id)) return json({ error: "credential" }, 404);
    await assertPasskeyRemovable(env, user);
    const ok = await deleteCredential(env.PASSKEYS, user.id, id);
    if (!ok) return json({ error: "credential" }, 404);
    return json({ ok: true }, 200, { "Set-Cookie": await rotateSession(env, user) });
  } catch (err) {
    if (err?.code === "last_method") return json({ error: "last_method", message: "至少保留一种登录方式" }, 409);
    return json({ error: "storage_error" }, 500);
  }
}
