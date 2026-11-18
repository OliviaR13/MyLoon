// POST /api/auth/passkey/login/options：未登录用户开始一次无用户名的通行密钥登录。
import { json, sameOrigin } from "../../../../_lib/auth.js";
import { newChallenge, saveChallenge } from "../../../../_lib/passkeys.js";
import { rpOrError, unavailable } from "../../../../_lib/passkey-http.js";

export async function onRequestPost({ request, env }) {
  const missing = unavailable(env);
  if (missing) return missing;
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const { rp, error } = rpOrError(request);
  if (error) return error;
  const challenge = newChallenge();
  try {
    await saveChallenge(env.PASSKEYS, challenge, "auth");
  } catch {
    return json({ error: "storage_error" }, 500);
  }
  return json({
    challenge,
    timeout: 60000,
    rpId: rp.rpId,
    userVerification: "preferred",
    allowCredentials: [],
  });
}
