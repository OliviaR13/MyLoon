/*
 * Siri Apple Capture v1.0.0
 *
 * 只读的抓包辅助脚本：记录 Siri / Apple Intelligence 扩展相关请求和响应的摘要，
 * 用来确认 ChatGPT 扩展走哪个域名、路径、什么格式。不修改任何请求或响应，
 * 任何异常都会直接放行，不影响 Siri 正常使用。
 *
 * 记录内容：方法、URL、状态码、关键头（Authorization / Cookie / 含 token 的头只显示长度）、
 * 正文大小、格式判断（JSON / 文本 / 流 / plist / gzip / 二进制）、正文预览，
 * 二进制正文额外给出十六进制头部和可读字符串。
 * 结果写入 Loon 日志，同时保存最近若干条到本地存储 siri_apple_capture_log。
 */
const TAG = "[siri_apple_capture]";
const STORE_KEY = "siri_apple_capture_log";
const MAX_RECORDS = 30;
const MAX_STORE_BYTES = 150000;
const TEXT_PREVIEW = 3000;
const HEX_BYTES = 96;

const isRes = typeof $response !== "undefined";
const msg = isRes ? $response : $request;

function lower(h) { const o = {}; Object.keys(h || {}).forEach((k) => (o[k.toLowerCase()] = h[k])); return o; }
function redactHeaders(h) {
  const out = {};
  Object.keys(h || {}).forEach((k) => {
    const v = String(h[k]);
    out[k] = /authorization|cookie|token|session|signature|^x-apple-.*(id|key|sig)|apikey|api-key/i.test(k) ? "<redacted len=" + v.length + ">" : (v.length > 200 ? v.slice(0, 200) + "…" : v);
  });
  return out;
}
function toBytes(b) {
  if (b === undefined || b === null) return null;
  if (typeof b === "string") { const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i) & 255; return a; }
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}
function utf8(bytes) {
  try { let s = ""; for (let i = 0; i < bytes.length; i++) s += "%" + (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16); return decodeURIComponent(s); } catch (e) { return null; }
}
function hex(bytes, n) { let s = []; for (let i = 0; i < Math.min(n, bytes.length); i++) s.push((bytes[i] < 16 ? "0" : "") + bytes[i].toString(16)); return s.join(" "); }
function strings(bytes, minLen, max) {
  const out = []; let cur = "";
  for (let i = 0; i < bytes.length && out.length < max; i++) {
    const c = bytes[i];
    if (c >= 32 && c < 127) cur += String.fromCharCode(c);
    else { if (cur.length >= minLen) out.push(cur.slice(0, 120)); cur = ""; }
  }
  if (cur.length >= minLen && out.length < max) out.push(cur.slice(0, 120));
  return out;
}
function describeBody(body, ct, ce) {
  const bytes = toBytes(body);
  if (!bytes || !bytes.length) return { size: 0, kind: "empty" };
  const r = { size: bytes.length };
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) { r.kind = "gzip"; r.hex = hex(bytes, 16); return r; }
  if (bytes.length > 8 && String.fromCharCode.apply(null, bytes.slice(0, 8)) === "bplist00") { r.kind = "binary-plist"; r.hex = hex(bytes, HEX_BYTES); r.strings = strings(bytes, 6, 40); return r; }
  const textLike = /json|text|xml|event-stream|x-www-form-urlencoded|javascript/i.test(ct || "");
  const t = utf8(bytes.slice(0, Math.min(bytes.length, TEXT_PREVIEW * 3)));
  if (t !== null && (textLike || /^[\s\S]{0,4}[\[{<]/.test(t))) { r.kind = textLike ? "text" : "text?"; r.preview = t.length > TEXT_PREVIEW ? t.slice(0, TEXT_PREVIEW) + "…(+" + (bytes.length) + "B total)" : t; return r; }
  r.kind = ce ? "binary(" + ce + ")" : "binary"; r.hex = hex(bytes, HEX_BYTES); r.strings = strings(bytes, 6, 40);
  return r;
}
function persist(rec) {
  try {
    let arr = [];
    try { arr = JSON.parse($persistentStore.read(STORE_KEY) || "[]"); } catch (e) { arr = []; }
    arr.push(rec);
    while (arr.length > MAX_RECORDS) arr.shift();
    let s = JSON.stringify(arr);
    while (s.length > MAX_STORE_BYTES && arr.length > 1) { arr.shift(); s = JSON.stringify(arr); }
    $persistentStore.write(s, STORE_KEY);
  } catch (e) {}
}

try {
  const req = $request || {};
  const hdr = lower(msg.headers);
  const rec = {
    t: new Date().toISOString(),
    phase: isRes ? "response" : "request",
    method: req.method,
    url: (req.url || "").replace(/([?&](?:token|key|sig|signature|session|auth)[^=]*=)[^&]*/gi, "$1<redacted>"),
    status: isRes ? $response.status : undefined,
    headers: redactHeaders(msg.headers),
    body: describeBody(msg.body, hdr["content-type"], hdr["content-encoding"]),
  };
  console.log(TAG + " " + rec.phase.toUpperCase() + " " + rec.method + " " + rec.url + (isRes ? " -> " + rec.status : ""));
  console.log(TAG + " headers=" + JSON.stringify(rec.headers));
  console.log(TAG + " body kind=" + rec.body.kind + " size=" + rec.body.size);
  if (rec.body.preview) console.log(TAG + " preview=" + rec.body.preview);
  if (rec.body.hex) console.log(TAG + " hex=" + rec.body.hex);
  if (rec.body.strings && rec.body.strings.length) console.log(TAG + " strings=" + JSON.stringify(rec.body.strings));
  persist(rec);
} catch (e) {
  console.log(TAG + " capture error: " + (e && e.message));
}
$done({});
