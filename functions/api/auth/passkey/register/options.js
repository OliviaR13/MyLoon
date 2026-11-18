// POST /api/auth/passkey/register/options：已登录用户开始注册一把通行密钥。
import { getSession, json, sameOrigin } from "../../../../_lib/auth.js";
import { listCredentials, newChallenge, passkeyConfigError, saveChallenge, userHandle } from "../../../../_lib/passkeys.js";
import { rpOrError } from "../../../../_lib/passkey-http.js";

export async function onRequestPost({ request, env }) {
  const message = passkeyConfigError(env);
  if (message) return json({ error: "passkeys_not_configured", message }, 503);
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const user = await getSession(request, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const { rp, error } = rpOrError(request);
  if (error) return error;
  const challenge = newChallenge();
  try {
    await saveChallenge(env.PASSKEYS, challenge, "reg", { userId: String(user.id) });
    const existing = await listCredentials(env.PASSKEYS, user.id);
    const name = user.provider === "google" ? (user.name || user.login || "Google 用户") : (user.login || "GitHub 用户");
    return json({
      challenge,
      rp: { name: "Loon Box", id: rp.rpId },
      user: { id: userHandle(user.id), name, displayName: name },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      timeout: 60000,
      attestation: "none",
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
      excludeCredentials: existing.map((c) => ({ type: "public-key", id: c.id })),
    });
  } catch {
    return json({ error: "storage_error" }, 500);
  }
}
