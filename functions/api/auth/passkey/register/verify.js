// POST /api/auth/passkey/register/verify：核对注册响应，把公钥存进 PASSKEYS。
import { getSessionOr503, json } from "../../../../_lib/auth.js";
import { bytesField, httpError, readBody, rpOrError, unavailable } from "../../../../_lib/passkey-http.js";
import { profileFromSession, putCredential, takeChallenge } from "../../../../_lib/passkeys.js";
import { rateLimit } from "../../../../_lib/rate-limit.js";
import { b64urlEncode, verifyRegistration } from "../../../../_lib/webauthn.js";

export async function onRequestPost({ request, env }) {
  const missing = unavailable(env);
  if (missing) return missing;
  const limited = await rateLimit(request, env, "passkey-reg-ver");
  if (limited) return limited;
  const got = await getSessionOr503(request, env);
  if (got.response) return got.response;
  const user = got.user;
  if (!user) return json({ error: "unauthorized" }, 401);
  const { rp, error } = rpOrError(request);
  if (error) return error;
  const { body, error: bad } = await readBody(request);
  if (bad) return bad;
  const clientDataJSON = bytesField(body?.response?.clientDataJSON);
  const attestationObject = bytesField(body?.response?.attestationObject);
  const rawId = bytesField(body?.rawId || body?.id, 1024);
  if (!clientDataJSON || !attestationObject || !rawId || body?.type !== "public-key") return json({ error: "bad_credential" }, 400);

  let challenge = "";
  try {
    challenge = JSON.parse(new TextDecoder().decode(clientDataJSON)).challenge;
  } catch {
    return json({ error: "bad_client_data" }, 400);
  }
  const saved = await takeChallenge(env, challenge, "reg", request);
  if (!saved || saved.userId !== String(user.id)) return json({ error: "challenge" }, 400);

  try {
    const verified = await verifyRegistration({
      rpId: rp.rpId,
      origin: rp.origin,
      clientDataJSON,
      attestationObject,
      challenge,
      rawId,
    });
    const profile = profileFromSession(user);
    if (!profile) return json({ error: "unauthorized" }, 401);
    const credentialId = b64urlEncode(verified.credentialId);
    await putCredential(env.PASSKEYS, {
      credentialId,
      coseKey: b64urlEncode(verified.coseKey),
      alg: verified.alg,
      signCount: verified.signCount,
      createdAt: Date.now(),
      ...profile,
    }, env.MLB_DB);
    return json({ ok: true, id: credentialId });
  } catch (err) {
    return httpError(err);
  }
}
