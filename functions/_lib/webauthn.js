// WebAuthn 注册与登录校验。只用 WebCrypto，不引入需要打包的库。
// 接受的公钥算法：ES256（COSE -7，P-256）和 RS256（COSE -257）。
import { decodeCbor } from "./cbor.js";

const enc = new TextEncoder();

export function b64urlEncode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s) {
  if (typeof s !== "string" || !/^[-_A-Za-z0-9]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let n = 0;
  for (let i = 0; i < a.length; i++) n |= a[i] ^ b[i];
  return n === 0;
}

// RP ID 取请求的主机名。pages.dev 的预览子域和 localhost 各自成为自己的 RP ID。
// IP 地址不能当 RP ID（localhost 除外），调用方据此返回明确错误。
export function rpIdFromHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host || host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (host === "localhost" || /^[a-z0-9.-]+$/.test(host)) return host;
  return null;
}

export function requestRp(request) {
  const url = new URL(request.url);
  const rpId = rpIdFromHost(url.hostname);
  if (!rpId) return null;
  return { rpId, origin: url.origin };
}

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function clientData(bytes, type, origin, challenge) {
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw fail("bad_client_data");
  }
  if (!data || data.type !== type || typeof data.challenge !== "string") throw fail("bad_client_data");
  if (data.crossOrigin === true) throw fail("origin");
  if (data.origin !== origin) throw fail("origin");
  const got = b64urlDecode(data.challenge);
  const want = b64urlDecode(challenge);
  if (!got || !want || !equalBytes(got, want)) throw fail("challenge");
  return data;
}

// authenticator data：rpIdHash(32) || flags(1) || signCount(4) || [attested credential]
export function parseAuthData(authData, { attestation }) {
  if (!(authData instanceof Uint8Array) || authData.length < 37) throw fail("auth_data");
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
  if ((flags & 0x01) === 0) throw fail("user_present");
  if (!attestation) return { rpIdHash, flags, signCount };
  if ((flags & 0x40) === 0) throw fail("auth_data");
  if (authData.length < 55) throw fail("auth_data");
  const idLen = new DataView(authData.buffer, authData.byteOffset + 53, 2).getUint16(0);
  const idStart = 55;
  if (idLen < 1 || idLen > 1024 || authData.length < idStart + idLen) throw fail("auth_data");
  const credentialId = authData.slice(idStart, idStart + idLen);
  const keyBytes = authData.slice(idStart + idLen);
  const decoded = decodeCbor(keyBytes);
  if (!(decoded.value instanceof Map)) throw fail("public_key");
  if ((flags & 0x80) === 0 && decoded.offset !== keyBytes.length) throw fail("public_key");
  return { rpIdHash, flags, signCount, credentialId, coseKey: keyBytes.slice(0, decoded.offset), cose: decoded.value };
}

async function rpIdHashOk(rpIdHash, rpId) {
  const want = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(rpId)));
  if (!equalBytes(rpIdHash, want)) throw fail("rp_id");
}

function coseAlg(cose) {
  const alg = cose.get(3);
  if (alg !== -7 && alg !== -257) throw fail("alg");
  return alg;
}

// WebAuthn 的 ES256 签名是 DER，WebCrypto 要的是 r||s。
export function derToRaw(der, size = 32) {
  if (!(der instanceof Uint8Array) || der.length < 8 || der[0] !== 0x30) throw fail("signature");
  let o = 2;
  if (der[1] & 0x80) {
    const n = der[1] & 0x7f;
    if (n < 1 || n > 2 || der.length < 2 + n) throw fail("signature");
    o = 2 + n;
  }
  const readInt = () => {
    if (der[o++] !== 0x02) throw fail("signature");
    const len = der[o++];
    if (!len || o + len > der.length) throw fail("signature");
    let v = der.slice(o, o + len);
    o += len;
    if (v[0] === 0x00) v = v.slice(1);
    if (v.length > size) throw fail("signature");
    const out = new Uint8Array(size);
    out.set(v, size - v.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0);
  raw.set(s, size);
  return raw;
}

async function verifySignature(alg, cose, signature, data) {
  if (alg === -7) {
    if (cose.get(1) !== 2 || cose.get(-1) !== 1) throw fail("public_key");
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw fail("public_key");
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: b64urlEncode(x), y: b64urlEncode(y), ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(signature), data);
    if (!ok) throw fail("signature");
    return;
  }
  if (cose.get(1) !== 3) throw fail("public_key");
  const n = cose.get(-1);
  const e = cose.get(-2);
  if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array) || n.length < 256 || e.length < 1 || e.length > 8) throw fail("public_key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: b64urlEncode(n), e: b64urlEncode(e), alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
  if (!ok) throw fail("signature");
}

async function signedData(authData, clientDataJSON) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
  const out = new Uint8Array(authData.length + hash.length);
  out.set(authData, 0);
  out.set(hash, authData.length);
  return out;
}

// 计数器：两边都是 0（苹果等平台密钥常见）时不判克隆；任一边非 0 则新值必须更大。
export function counterOk(stored, next) {
  if (!Number.isInteger(stored) || !Number.isInteger(next) || next < 0 || stored < 0) return false;
  if (stored === 0 && next === 0) return true;
  return next > stored;
}

export async function verifyRegistration({ rpId, origin, clientDataJSON, attestationObject, challenge, rawId }) {
  clientData(clientDataJSON, "webauthn.create", origin, challenge);
  let attestation;
  try {
    attestation = decodeCbor(attestationObject).value;
  } catch {
    throw fail("attestation");
  }
  if (!(attestation instanceof Map) || attestation.get("fmt") !== "none") throw fail("attestation");
  const authData = attestation.get("authData");
  const parsed = parseAuthData(authData, { attestation: true });
  await rpIdHashOk(parsed.rpIdHash, rpId);
  if (rawId && !equalBytes(parsed.credentialId, rawId)) throw fail("credential");
  const alg = coseAlg(parsed.cose);
  // attestation 要求 none，注册响应里没有可核对的证明签名。这里只确认公钥能导入。
  await importPublicKey(alg, parsed.cose);
  return {
    credentialId: parsed.credentialId,
    coseKey: parsed.coseKey,
    alg,
    signCount: parsed.signCount,
  };
}

async function importPublicKey(alg, cose) {
  if (alg === -7) {
    if (cose.get(1) !== 2 || cose.get(-1) !== 1) throw fail("public_key");
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw fail("public_key");
    await crypto.subtle.importKey(
      "jwk",
      { kty: "EC", crv: "P-256", x: b64urlEncode(x), y: b64urlEncode(y), ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return;
  }
  if (cose.get(1) !== 3) throw fail("public_key");
  const n = cose.get(-1);
  const e = cose.get(-2);
  if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array) || n.length < 256 || e.length < 1) throw fail("public_key");
  await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: b64urlEncode(n), e: b64urlEncode(e), alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export async function verifyAssertion({ rpId, origin, clientDataJSON, authenticatorData, signature, challenge, coseKey }) {
  clientData(clientDataJSON, "webauthn.get", origin, challenge);
  const parsed = parseAuthData(authenticatorData, { attestation: false });
  await rpIdHashOk(parsed.rpIdHash, rpId);
  let cose;
  try {
    const decoded = decodeCbor(coseKey);
    if (!(decoded.value instanceof Map) || decoded.offset !== coseKey.length) throw fail("public_key");
    cose = decoded.value;
  } catch (e) {
    if (e.code) throw e;
    throw fail("public_key");
  }
  const alg = coseAlg(cose);
  if (!(signature instanceof Uint8Array) || signature.length < 8 || signature.length > 1024) throw fail("signature");
  await verifySignature(alg, cose, signature, await signedData(authenticatorData, clientDataJSON));
  return { signCount: parsed.signCount, flags: parsed.flags };
}
