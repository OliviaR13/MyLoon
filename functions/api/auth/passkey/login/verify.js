// POST /api/auth/passkey/login/verify：核对断言，通过后写入和 GitHub / Google 相同的 mlb_session。
import { allowListed, cookie, issueSession, json, SESSION_TTL } from "../../../../_lib/auth.js";
import { rateLimit } from "../../../../_lib/rate-limit.js";
import { bytesField, httpError, readBody, rpOrError, unavailable } from "../../../../_lib/passkey-http.js";
import { getCredential, sessionFromProfile, takeChallenge, updateSignCount } from "../../../../_lib/passkeys.js";
import { b64urlEncode, counterOk, verifyAssertion } from "../../../../_lib/webauthn.js";

export async function onRequestPost({ request, env }) {
  const missing = unavailable(env);
  if (missing) return missing;
  const limited = await rateLimit(request, env, "passkey-login-ver");
  if (limited) return limited;
  const { rp, error } = rpOrError(request);
  if (error) return error;
  const { body, error: bad } = await readBody(request);
  if (bad) return bad;
  const clientDataJSON = bytesField(body?.response?.clientDataJSON);
  const authenticatorData = bytesField(body?.response?.authenticatorData, 1024);
  const signature = bytesField(body?.response?.signature, 1024);
  const rawId = bytesField(body?.rawId || body?.id, 1024);
  if (!clientDataJSON || !authenticatorData || !signature || !rawId || body?.type !== "public-key") {
    return json({ error: "bad_credential" }, 400);
  }
  let challenge = "";
  try {
    challenge = JSON.parse(new TextDecoder().decode(clientDataJSON)).challenge;
  } catch {
    return json({ error: "bad_client_data" }, 400);
  }
  const saved = await takeChallenge(env, challenge, "auth", request);
  if (!saved) return json({ error: "challenge" }, 400);

  const credentialId = b64urlEncode(rawId);
  const record = await getCredential(env.PASSKEYS, credentialId);
  if (!record) return json({ error: "credential" }, 400);
  if (body?.response?.userHandle) {
    const handle = bytesField(body.response.userHandle, 128);
    const want = new TextEncoder().encode(record.userId);
    if (!handle || handle.length !== want.length || !handle.every((b, i) => b === want[i])) return json({ error: "credential" }, 400);
  }

  try {
    const verified = await verifyAssertion({
      rpId: rp.rpId,
      origin: rp.origin,
      clientDataJSON,
      authenticatorData,
      signature,
      challenge,
      coseKey: record.coseKeyBytes,
    });
    if (!counterOk(record.signCount || 0, verified.signCount)) return json({ error: "counter" }, 400);
    if (!allowListed(env, record.login, record.email)) return json({ error: "denied" }, 403);
    if (verified.signCount > (record.signCount || 0)) await updateSignCount(env.PASSKEYS, credentialId, verified.signCount);
    const session = await issueSession(env, sessionFromProfile(record));
    return json({ ok: true }, 200, { "Set-Cookie": cookie("mlb_session", session, { maxAge: SESSION_TTL }) });
  } catch (err) {
    return httpError(err);
  }
}
