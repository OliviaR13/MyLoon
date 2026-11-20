// 浏览器里的通行密钥注册和登录。服务器见 functions/api/auth/passkey。

const b64urlEncode = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (s) => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || "passkey");
    err.code = data.error || "passkey";
    err.detail = data.message || "";
    throw err;
  }
  return data;
}

function credentialBody(cred, register) {
  const r = cred.response;
  const response = { clientDataJSON: b64urlEncode(r.clientDataJSON) };
  if (register) response.attestationObject = b64urlEncode(r.attestationObject);
  else {
    response.authenticatorData = b64urlEncode(r.authenticatorData);
    response.signature = b64urlEncode(r.signature);
    if (r.userHandle) response.userHandle = b64urlEncode(r.userHandle);
  }
  return { id: cred.id, rawId: b64urlEncode(cred.rawId), type: cred.type, response };
}

export const passkeySupported = () => typeof PublicKeyCredential !== "undefined";

export async function conditionalPasskeyAvailable() {
  if (!passkeySupported() || !PublicKeyCredential.isConditionalMediationAvailable) return false;
  try { return await PublicKeyCredential.isConditionalMediationAvailable(); }
  catch { return false; }
}

export async function registerPasskey() {
  const opt = await post("/api/auth/passkey/register/options");
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: opt.rp,
      user: { id: b64urlDecode(opt.user.id), name: opt.user.name, displayName: opt.user.displayName },
      challenge: b64urlDecode(opt.challenge),
      pubKeyCredParams: opt.pubKeyCredParams,
      timeout: opt.timeout,
      attestation: opt.attestation,
      authenticatorSelection: opt.authenticatorSelection,
      excludeCredentials: (opt.excludeCredentials || []).map((c) => ({ type: "public-key", id: b64urlDecode(c.id) })),
    },
  });
  if (!cred) throw Object.assign(new Error("cancel"), { name: "NotAllowedError" });
  return post("/api/auth/passkey/register/verify", credentialBody(cred, true));
}

export async function loginPasskey({ mediation, signal } = {}) {
  const opt = await post("/api/auth/passkey/login/options");
  const cred = await navigator.credentials.get({
    mediation,
    signal,
    publicKey: {
      challenge: b64urlDecode(opt.challenge),
      rpId: opt.rpId,
      timeout: opt.timeout,
      userVerification: opt.userVerification,
      allowCredentials: [],
    },
  });
  if (!cred) throw Object.assign(new Error("cancel"), { name: "NotAllowedError" });
  const data = await post("/api/auth/passkey/login/verify", credentialBody(cred, false));
  if (data.pendingDeletion) location.assign("/deletion.html");
  return data;
}

export async function assertPasskey(opt) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlDecode(opt.challenge),
      rpId: opt.rpId,
      timeout: opt.timeout,
      userVerification: opt.userVerification || "required",
      allowCredentials: (opt.allowCredentials || []).map((c) => ({ type: "public-key", id: b64urlDecode(c.id) })),
    },
  });
  if (!cred) throw Object.assign(new Error("cancel"), { name: "NotAllowedError" });
  return credentialBody(cred, false);
}
