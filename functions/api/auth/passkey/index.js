// GET /api/auth/passkey：是否已绑定 PASSKEYS，以及当前账号已添加的通行密钥。
import { getSession, json } from "../../../_lib/auth.js";
import { listCredentials, passkeyConfigError } from "../../../_lib/passkeys.js";

export async function onRequestGet({ request, env }) {
  const message = passkeyConfigError(env);
  if (message) return json({ enabled: false, error: "passkeys_not_configured", message });
  const user = await getSession(request, env);
  if (!user) return json({ enabled: true, credentials: [] });
  try {
    const credentials = await listCredentials(env.PASSKEYS, user.id);
    return json({ enabled: true, credentials });
  } catch {
    return json({ error: "storage_error" }, 500);
  }
}
