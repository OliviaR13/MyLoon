// GET /api/auth/passkey：是否已绑定 PASSKEYS，以及当前账号已添加的通行密钥。
import { getSessionOr503, json } from "../../../_lib/auth.js";
import { listCredentials, passkeyConfigError } from "../../../_lib/passkeys.js";

export async function onRequestGet({ request, env }) {
  const message = passkeyConfigError(env);
  if (message) return json({ enabled: false, error: "passkeys_not_configured", message });
  const got = await getSessionOr503(request, env);
  if (got.response) return got.response;
  const user = got.user;
  if (!user) return json({ enabled: true, credentials: [] });
  try {
    const credentials = await listCredentials(env.PASSKEYS, user.id);
    return json({ enabled: true, credentials });
  } catch {
    return json({ error: "storage_error" }, 500);
  }
}
