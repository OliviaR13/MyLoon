// DELETE /api/auth/passkey/:id：移除当前账号的一把通行密钥。
import { getSession, json, sameOrigin } from "../../../_lib/auth.js";
import { deleteCredential } from "../../../_lib/passkeys.js";
import { unavailable } from "../../../_lib/passkey-http.js";

export async function onRequestDelete({ request, env, params }) {
  const missing = unavailable(env);
  if (missing) return missing;
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const user = await getSession(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const id = String(params?.id || "");
  if (!/^[-_A-Za-z0-9]+$/.test(id) || id.length > 1024) return json({ error: "credential" }, 400);
  try {
    const ok = await deleteCredential(env.PASSKEYS, user.id, id);
    if (!ok) return json({ error: "credential" }, 404);
    return json({ ok: true });
  } catch {
    return json({ error: "storage_error" }, 500);
  }
}
