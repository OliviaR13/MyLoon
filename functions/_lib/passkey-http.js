import { json, sameOrigin } from "./auth.js";
import { passkeyConfigError } from "./passkeys.js";
import { b64urlDecode, requestRp } from "./webauthn.js";

export function unavailable(env) {
  const message = passkeyConfigError(env);
  if (!message) return null;
  return json({ error: "passkeys_not_configured", message }, 503);
}

export async function readBody(request) {
  if (!sameOrigin(request)) return { error: json({ error: "forbidden" }, 403) };
  const text = await request.text();
  if (text.length > 64 * 1024) return { error: json({ error: "too_large" }, 413) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: json({ error: "bad_json" }, 400) };
  }
}

export function bytesField(value, max = 16 * 1024) {
  const bytes = b64urlDecode(value);
  if (!bytes || bytes.length < 1 || bytes.length > max) return null;
  return bytes;
}

export function httpError(err) {
  return json({ error: err?.code || "verify" }, 400);
}

export function rpOrError(request) {
  const rp = requestRp(request);
  if (!rp) return { error: json({ error: "rp_id", message: "当前主机不能作为通行密钥的 RP ID" }, 400) };
  return { rp };
}
