// 注销接口共用的校验：必须有 D1，通行密钥断言只接受当前账号的凭证。
import { json, sameOrigin } from "./auth.js";
import { bytesField, rpOrError } from "./passkey-http.js";
import { listCredentials, takeChallenge, getCredential } from "./passkeys.js";
import { b64urlEncode, counterOk, verifyAssertion } from "./webauthn.js";

export function deletionDbError(env) {
  if (env?.MLB_DB && env?.SESSION_SECRET) return null;
  return json({ error: "deletion_unavailable", message: "需要绑定 D1（MLB_DB）才能注销账号" }, 503);
}

export async function assertDeletionPasskey(request, env, user) {
  if (!sameOrigin(request)) return { response: json({ error: "forbidden" }, 403) };
  const text = await request.text();
  if (text.length > 64 * 1024) return { response: json({ error: "too_large" }, 413) };
  let body = {};
  if (text.trim()) {
    try { body = JSON.parse(text); }
    catch { return { response: json({ error: "bad_json" }, 400) }; }
  }
  const creds = env.PASSKEYS ? await listCredentials(env.PASSKEYS, user.id) : [];
  if (!creds.length) return { passkey: false, body };
  const clientDataJSON = bytesField(body?.response?.clientDataJSON);
  const authenticatorData = bytesField(body?.response?.authenticatorData, 1024);
  const signature = bytesField(body?.response?.signature, 1024);
  const rawId = bytesField(body?.rawId || body?.id, 1024);
  if (!clientDataJSON || !authenticatorData || !signature || !rawId || body?.type !== "public-key") {
    return { response: json({ error: "reauth_required", message: "请用通行密钥确认是你本人" }, 401) };
  }
  let challenge = "";
  try {
    challenge = JSON.parse(new TextDecoder().decode(clientDataJSON)).challenge;
  } catch {
    return { response: json({ error: "bad_client_data" }, 400) };
  }
  const saved = await takeChallenge(env, challenge, "deletion", request);
  if (!saved || saved.userId !== String(user.id)) return { response: json({ error: "challenge" }, 400) };
  const { rp, error } = rpOrError(request);
  if (error) return { response: error };
  const record = await getCredential(env.PASSKEYS, b64urlEncode(rawId));
  if (!record || String(record.userId) !== String(user.id)) return { response: json({ error: "credential" }, 400) };
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
    if (!counterOk(record.signCount || 0, verified.signCount)) return { response: json({ error: "counter" }, 400) };
  } catch {
    return { response: json({ error: "verify" }, 400) };
  }
  return { passkey: true, body };
}
