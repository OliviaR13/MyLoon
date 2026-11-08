/*
 * Siri AI Bridge  v2.3.0
 *
 * 将 Siri 请求转换为通用 AI API 请求（Gemini / OpenAI / Anthropic / OpenAI 兼容接口），
 * 并按 Siri 兼容的 SSE 事件流返回。能力对齐 Siri to Gemini：
 * 文本对话、连续追问、相机识图、文件问答、写作工具、联网搜索、风格预设、隐私兜底。
 * 不支持的输入会明确报错，不会放行给原始服务。
 */

const VERSION = "2.3.0";
const TAG = "[siri_ai_bridge]";

const BASE_DEFAULTS = {
  gemini: "https://generativelanguage.googleapis.com",
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
};
// 用户话语开头的「使用千问」只是 Siri 的触发词，不属于问题
const IDENTITY = "用户话语开头的「使用千问」「用千问」只是触发词，请完全忽略，直接回答问题本身，不要提到千问或通义。";
const IMAGE_ONLY_PROMPT = "请识别并简要说明图片里是什么；如果有文字，请读出重点；如果是商品、植物、动物或地点，请说出名称和关键信息。";
const TRIGGER_RE = /^[\s，,。.、]*(请)?(使用|调用|用)(一下)?(通义)?千问[\s，,、:：。.]*/;
const OLD_DEFAULT_PROMPT = "你是 Siri 的后台助手。请用简洁、口语化的中文回答，适合直接朗读；不要使用 Markdown、列表符号或表情。";

const FORMAT_RULES = "排版要求：必须使用完整的中文标点（逗号、顿号、句号、冒号等），不要省略标点；内容较多时按意思分成几个短段落，段落之间空一行；英文名称与中文之间用标点或空格隔开。";
const STYLES = {
  "简短口语": "你是 Siri 的后台助手。请用简洁、口语化的中文回答，语句自然流畅；不要使用 Markdown、列表符号或表情。" + FORMAT_RULES,
  "标准": "你是 Siri 的后台助手。请用清晰、自然的中文回答，条理分明但不要使用 Markdown、列表符号或表情。" + FORMAT_RULES,
  "详细": "你是 Siri 的后台助手。请用中文详细回答，必要时分点说明，但不要使用 Markdown 符号或表情。" + FORMAT_RULES,
};

// 时间预算（毫秒）：整个脚本不超过插件里 timeout=60 秒
const BUDGET_MS = 48000;
const WATCHDOG_MS = 52000;
const ATTEMPT_MS = 45000;
const RETRY_MIN_MS = 12000;
const MAX_WAIT_MS = 15000; // 限流时最多愿意等多久再重试；超过就直接告诉用户多久后再试

/* ───────────── 参数 ───────────── */
function readArgs() {
  let a = typeof $argument === "undefined" ? {} : $argument;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch (e) { a = {}; } }
  const get = (k) => {
    const v = a[k];
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return /^\{.*\}$/.test(s) || s === "null" || s === "" ? undefined : s;
  };
  const provider = (get("PROVIDER") || "openai_compatible").toLowerCase();
  const style = STYLES[get("STYLE")] ? get("STYLE") : "简短口语";
  let base = (get("BASE") || BASE_DEFAULTS[provider] || "").replace(/\/+$/, "");
  if (provider === "gemini" || provider === "anthropic") base = base.replace(/\/v1(beta)?$/i, "");
  const prompt = get("PROMPT");
  return {
    provider,
    key: (get("KEY") || "").replace(/\s+/g, ""),
    base,
    model: (get("MODEL") || "").replace(/^\/?models\//i, ""),
    style,
    prompt: prompt === OLD_DEFAULT_PROMPT ? "" : (prompt || ""),
    search: get("SEARCH") === "true",
    fast: get("FAST") !== "false",
    history: (() => { const v = get("HISTORY"); if (v === "不带历史") return 0; const n = parseInt(v, 10); return isFinite(n) ? Math.max(0, Math.min(20, n)) : 6; })(),
    strict: get("STRICT") !== "false",
    max: Math.max(128, Math.min(8192, Number(get("MAX")) || 2048)),
  };
}

/* ───────────── 工具 ───────────── */
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });

function stripMd(t) {
  return String(t || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, ""))
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function summarize(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  const first = t.split(/[。！？!?\n]/)[0] || t;
  return first.length > 20 ? first.slice(0, 20) + "…" : first;
}
function shapeOf(v, depth) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return "str(" + v.length + ")" + (/^https?:\/\//.test(v) ? "@" + v.split("/")[2] : /^data:/.test(v) ? ":" + v.slice(5, v.indexOf(";")) : "");
  if (typeof v !== "object") return typeof v;
  if (depth > 3) return "…";
  if (Array.isArray(v)) return "[" + v.slice(0, 3).map((x) => shapeOf(x, depth + 1)).join(",") + (v.length > 3 ? ",…" : "") + "]";
  return "{" + Object.keys(v).map((k) => k + ":" + shapeOf(v[k], depth + 1)).join(",") + "}";
}
function stripTrigger(t) { const r = String(t).replace(TRIGGER_RE, "").trim(); return r || t; }

/* ───────────── 输出结构：跟随请求里的 response_format ─────────────
 * 相机/普通对话: content + summary + isRequestingUserInput
 * 写作工具: body + refinements，按请求里 json_schema 的字段生成返回 */
const DEFAULT_PROPS = { content: { type: "string" }, summary: { type: "string" }, isRequestingUserInput: { type: ["boolean", "null"] } };
let OUT = { prop: "content", props: DEFAULT_PROPS };
const KNOWN = { summary: 1, isRequestingUserInput: 1 };
function pickType(t) { return Array.isArray(t) ? t.filter((x) => x !== "null")[0] : t; }
function makeValue(text, extra) {
  const o = {};
  Object.keys(OUT.props).forEach((k) => {
    const ty = pickType(OUT.props[k] && OUT.props[k].type);
    if (k === OUT.prop) o[k] = text;
    else if (k === "summary") o[k] = summarize(text);
    else if (k === "isRequestingUserInput") o[k] = false;
    else if (extra && extra[k] !== undefined) o[k] = extra[k];
    else o[k] = ty === "array" ? [] : ty === "boolean" ? false : ty === "string" ? "" : null;
  });
  return JSON.stringify(o);
}
function extraProps() { return Object.keys(OUT.props).filter((k) => k !== OUT.prop && !KNOWN[k]); }
function toGSchema(sch) {
  if (!sch || typeof sch !== "object") return { type: "STRING" };
  const t = pickType(sch.type) || "string";
  const o = { type: String(t).toUpperCase() };
  if (Array.isArray(sch.type) && sch.type.indexOf("null") >= 0) o.nullable = true;
  if (sch.description) o.description = sch.description;
  if (o.type === "OBJECT") {
    o.properties = {};
    Object.keys(sch.properties || {}).forEach((k) => { o.properties[k] = toGSchema(sch.properties[k]); });
    o.propertyOrdering = Object.keys(o.properties);
  }
  if (o.type === "ARRAY") o.items = toGSchema(sch.items);
  return o;
}
function structuredSchema() {
  const keys = [OUT.prop].concat(extraProps());
  const props = {};
  keys.forEach((k) => { props[k] = toGSchema(OUT.props[k]); });
  return { type: "OBJECT", properties: props, required: keys, propertyOrdering: keys };
}
function structuredPrompt() {
  const keys = [OUT.prop].concat(extraProps());
  const lines = keys.map((k) => "- " + k + "：" + String((OUT.props[k] && OUT.props[k].description) || "").trim());
  return "你是写作与文字处理助手。请只输出一个 JSON 对象，不要输出任何其他内容，字段含义如下（以用户请求所用的语言书写，通常是简体中文）：\n" + lines.join("\n") +
    "\n正文要可直接使用，不要使用 Markdown 标记（如 # 和 **）、不要加寒暄或解释；必须使用完整的中文标点，内容较多时分段。";
}

/* ───────────── Siri 请求 → 统一消息 ─────────────
 * 统一格式：{ role: "user"|"assistant", parts: [{t}|{img:{mime,b64}}|{file:{mime,b64,name}}] } */
function toUnified(body, contentProp) {
  const msgs = [], system = [];
  let unsupported = false, hasImage = false;
  for (const it of body.input || []) {
    if (!it || it.type !== "message" || !it.message) continue;
    const m = it.message;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const imgs = [], texts = [];
    for (const c of blocks) {
      if (c && typeof c.text === "string") { texts.push(c.text); continue; }
      let u = c && (c.type === "image_url" || c.type === "input_image") && c.image_url;
      if (u && typeof u === "object") u = u.url;
      if (typeof u === "string") {
        const mm = /^data:([^;,]+);base64,(.+)$/s.exec(u);
        if (mm) { imgs.push({ img: { mime: mm[1], b64: mm[2] } }); continue; }
      }
      if (c && Object.keys(c).length) { unsupported = true; console.log(TAG + " non-text block: " + shapeOf(c, 0)); }
    }
    let text = texts.join("\n");
    const isSys = m.role === "system" || m.role === "developer";
    if (isSys) {
      const kept = text.split("\n").filter((l) => !/千问|通义|Qwen/i.test(l)).join("\n").trim();
      if (kept) system.push(kept);
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    let parts = [];
    if (imgs.length && role === "user") {
      hasImage = true;
      parts = imgs.concat([{ t: String(text).replace(TRIGGER_RE, "").trim() || IMAGE_ONLY_PROMPT }]);
    } else {
      if (!text) continue;
      if (role === "user") text = stripTrigger(text);
      else {
        // 历史里的助手回复是 JSON 字符串，取出正文
        try { const jo = JSON.parse(text); if (jo && typeof jo[contentProp || "content"] === "string") text = jo[contentProp || "content"]; } catch (e) {}
      }
      parts = [{ t: text }];
    }
    pushMsg(msgs, role, parts);
  }
  return { msgs, system, unsupported, hasImage };
}
function pushMsg(msgs, role, parts) {
  const last = msgs[msgs.length - 1];
  if (last && last.role === role) last.parts.push(...parts);
  else msgs.push({ role, parts: parts.slice() });
}

/* ───────────── 文件上传：本地接住，不发给上游 ─────────────
 * Siri 先 POST /v1/sessions/files（multipart）上传文件，之后的对话请求靠会话 ID 关联。
 * 脚本在本地解析 multipart，存入 $persistentStore，对话时再随请求发给 AI。 */
const FILE_KEY = "siri_bridge_file:";
const FILE_INDEX = "siri_bridge_file_index";
const FILE_TTL = 3600 * 1000;
const FILE_MAX_SESS = 3;
const FILE_MAX_BYTES = 6 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|ts|py|java|c|cc|cpp|h|go|rs|rb|php|sh|yaml|yml|toml|ini|log|sql|swift|kt)$/i;

function store(k, v) { try { if (typeof $persistentStore !== "undefined") return $persistentStore.write(v, k); } catch (e) {} return false; }
function fetchStore(k) { try { if (typeof $persistentStore !== "undefined") return $persistentStore.read(k); } catch (e) {} return null; }
function u8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x && x.buffer ? x.buffer : x); }
function indexOfBytes(buf, pat, from) {
  const n = buf.length, m = pat.length, first = pat[0];
  for (let i = from || 0; i <= n - m; i++) {
    if (buf[i] !== first) continue;
    let j = 1;
    while (j < m && buf[i + j] === pat[j]) j++;
    if (j === m) return i;
  }
  return -1;
}
function latin1(buf, s, e) {
  let out = "";
  for (let i = s; i < e; i += 8192) out += String.fromCharCode.apply(null, buf.subarray(i, Math.min(e, i + 8192)));
  return out;
}
function utf8dec(bin) { try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; } }
function strBytes(str) { const b = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 255; return b; }
function parseMultipart(buf, ctype) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype || "");
  if (!m) return [];
  const bnd = strBytes("--" + (m[1] || m[2]).trim());
  const out = [];
  let pos = indexOfBytes(buf, bnd, 0);
  while (pos >= 0) {
    const next = indexOfBytes(buf, bnd, pos + bnd.length);
    if (next < 0) break;
    let ps = pos + bnd.length;
    if (buf[ps] === 13 && buf[ps + 1] === 10) ps += 2;
    let pe = next;
    if (buf[pe - 2] === 13 && buf[pe - 1] === 10) pe -= 2;
    const he = indexOfBytes(buf, [13, 10, 13, 10], ps);
    if (he >= 0 && he < pe) {
      const head = utf8dec(latin1(buf, ps, he));
      out.push({
        name: (/name="([^"]*)"/i.exec(head) || [])[1],
        filename: (/filename="([^"]*)"/i.exec(head) || [])[1],
        type: ((/content-type:\s*([^\r\n;]+)/i.exec(head) || [])[1] || "").trim(),
        start: he + 4,
        end: pe,
      });
    }
    pos = next;
  }
  return out;
}
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(buf, s, e) {
  const chunks = [];
  let cur = [];
  for (let i = s; i < e; i += 3) {
    const a = buf[i], b = i + 1 < e ? buf[i + 1] : 0, c = i + 2 < e ? buf[i + 2] : 0;
    cur.push(B64[a >> 2], B64[((a & 3) << 4) | (b >> 4)], i + 1 < e ? B64[((b & 15) << 2) | (c >> 6)] : "=", i + 2 < e ? B64[c & 63] : "=");
    if (cur.length > 30000) { chunks.push(cur.join("")); cur = []; }
  }
  chunks.push(cur.join(""));
  return chunks.join("");
}
function saveFile(sid, rec) {
  let idx = [];
  try { idx = JSON.parse(fetchStore(FILE_INDEX) || "[]"); } catch (e) {}
  const now = Date.now();
  const cur = (() => { try { return JSON.parse(fetchStore(FILE_KEY + sid) || "null"); } catch (e) { return null; } })() || { t: now, files: [] };
  cur.t = now;
  cur.files.push(rec);
  if (!store(FILE_KEY + sid, JSON.stringify(cur))) throw new Error("persistent store write failed");
  idx = idx.filter((x) => x.sid !== sid);
  idx.push({ sid, t: now });
  idx = idx.filter((x) => { if (now - x.t > FILE_TTL) { store(FILE_KEY + x.sid, ""); return false; } return true; });
  idx.sort((a, b) => b.t - a.t);
  idx.slice(FILE_MAX_SESS).forEach((x) => store(FILE_KEY + x.sid, ""));
  store(FILE_INDEX, JSON.stringify(idx.slice(0, FILE_MAX_SESS)));
}
function loadFiles(sid) {
  try {
    const r = JSON.parse(fetchStore(FILE_KEY + sid) || "null");
    if (r && Date.now() - r.t <= FILE_TTL) return r.files || [];
  } catch (e) {}
  return [];
}
/* ───────────── 相机图片：追问时继续带上最近一张 ─────────────
 * 追问请求只带文字，历史里也只记文字，所以把最近一张图存下来，追问时接回去。
 * 每个会话只留最近一张，1 小时过期。 */
const IMG_KEY = "siri_bridge_img:";
const IMG_INDEX = "siri_bridge_img_index";
const IMG_MAX_B64 = 4 * 1024 * 1024;
function lastUserImage(msgs) {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    const p = msgs[i].parts.filter((x) => x.img);
    if (p.length) return p[p.length - 1].img;
  }
  return null;
}
function saveImage(sid, img) {
  try {
    if (!img || !img.b64) return;
    if (img.b64.length > IMG_MAX_B64) { console.log(TAG + " image too large to keep for follow-ups"); return; }
    const now = Date.now();
    if (!store(IMG_KEY + sid, JSON.stringify({ t: now, mime: img.mime, b64: img.b64 }))) { console.log(TAG + " image save failed"); return; }
    let idx = [];
    try { idx = JSON.parse(fetchStore(IMG_INDEX) || "[]"); } catch (e) {}
    idx = idx.filter((x) => x.sid !== sid);
    idx.push({ sid, t: now });
    idx = idx.filter((x) => { if (now - x.t > FILE_TTL) { store(IMG_KEY + x.sid, ""); return false; } return true; });
    idx.sort((a, b) => b.t - a.t);
    idx.slice(FILE_MAX_SESS).forEach((x) => store(IMG_KEY + x.sid, ""));
    store(IMG_INDEX, JSON.stringify(idx.slice(0, FILE_MAX_SESS)));
  } catch (e) { console.log(TAG + " save image error: " + e); }
}
function loadImage(sid) {
  try {
    const r = JSON.parse(fetchStore(IMG_KEY + sid) || "null");
    if (r && r.b64 && Date.now() - r.t <= FILE_TTL) return r;
  } catch (e) {}
  return null;
}

// 模型没有时钟：把今天的日期告诉它（只放日期，不放具体时间，避免每次都破坏缓存）
function todayLine() {
  const d = new Date();
  return "当前日期：" + d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 星期" + "日一二三四五六"[d.getDay()] + "。涉及今天、明天、现在、最近等时间问题时，以这个日期为准。";
}

// 限流时服务商会告诉要等多久：Retry-After 响应头，Gemini 的 retryDelay，或错误信息里的 "try again in 1.2s"
function retryDelayMs(j, resp) {
  try {
    const h = (resp && resp.headers) || {};
    const ra = h["Retry-After"] || h["retry-after"] || h["Retry-after"];
    if (ra && /^\d+(\.\d+)?$/.test(String(ra).trim())) return Math.ceil(parseFloat(ra) * 1000);
    const d = (((j && j.error && j.error.details) || [])).find((x) => x && x.retryDelay);
    if (d) { const m = /([\d.]+)s/.exec(String(d.retryDelay)); if (m) return Math.ceil(parseFloat(m[1]) * 1000); }
    const msg = String((j && j.error && j.error.message) || "");
    const m2 = /(?:retry|try again) in ([\d.]+)\s*(ms|s)/i.exec(msg);
    if (m2) return Math.ceil(parseFloat(m2[1]) * (m2[2].toLowerCase() === "ms" ? 1 : 1000));
  } catch (e) {}
  return 0;
}

// 被拦截或没有回答时，用中文说明原因
const BLOCK_TEXT = {
  SAFETY: "内容被服务商的安全策略拦截了，请换个说法再试。",
  PROHIBITED_CONTENT: "内容被服务商的安全策略拦截了，请换个说法再试。",
  BLOCKLIST: "内容被服务商的安全策略拦截了，请换个说法再试。",
  content_filter: "内容被服务商的安全策略拦截了，请换个说法再试。",
  refusal: "服务商拒绝回答这个问题，请换个说法再试。",
  SPII: "内容里可能含有敏感个人信息，服务商拒绝处理，请去掉后再试。",
  IMAGE_SAFETY: "图片被服务商的安全策略拦截了，请换一张再试。",
  IMAGE_PROHIBITED_CONTENT: "图片被服务商的安全策略拦截了，请换一张再试。",
  RECITATION: "回答可能涉及受版权保护的内容，已被拦截，请换个问法。",
  LANGUAGE: "服务商暂不支持这种语言。",
  OTHER: "服务商没能处理这个请求，请换个说法再试。",
  "空回复": "AI 这次没有给出回答，请再试一次。",
};

function localJson(status, obj) {
  return { response: { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) } };
}
function handleUpload(sidInUrl) {
  finished = true;
  try {
    const hdr = $request.headers || {};
    const ctype = hdr["Content-Type"] || hdr["content-type"] || "";
    const body = $request.body;
    if (!body || typeof body === "string") {
      console.log(TAG + " upload: body is not binary (need binary-body-mode=true on the files rule)");
      return $done(localJson(400, { error: { code: "bad_request", message: "插件的文件规则缺少 binary-body-mode，请更新插件" } }));
    }
    const buf = u8(body);
    const parts = parseMultipart(buf, ctype);
    const fp = parts.filter((p) => p.name === "file")[0];
    if (!fp) {
      console.log(TAG + " upload: no file part, parts=" + parts.map((p) => p.name).join("/"));
      return $done(localJson(400, { error: { code: "bad_request", message: "没有找到文件内容" } }));
    }
    let meta = {};
    const jp = parts.filter((p) => p.name === "json")[0];
    if (jp) { try { meta = JSON.parse(utf8dec(latin1(buf, jp.start, jp.end))); } catch (e) {} }
    const mf = (meta.source && meta.source.file) || {};
    const name = mf.name || fp.filename || "文件";
    const mime = (mf.mime_type || fp.type || "application/octet-stream").toLowerCase();
    const size = fp.end - fp.start;
    console.log(TAG + " upload: name=" + name + ", mime=" + mime + ", bytes=" + size);
    if (size > FILE_MAX_BYTES) {
      return $done(localJson(413, { error: { code: "file_too_large", message: "文件太大，上限 " + (FILE_MAX_BYTES >> 20) + "MB" } }));
    }
    const rec = { id: "file-" + uuid().replace(/-/g, "").slice(0, 24), name, mime, size };
    const binary = /^(application\/pdf|image\/(png|jpe?g|webp|heic|heif|gif)|audio\/|video\/)/.test(mime);
    const textLike = /^text\//.test(mime) || /^application\/(json|xml|x-yaml|yaml|javascript)/.test(mime) || TEXT_EXT.test(name);
    if (binary) rec.b64 = toBase64(buf, fp.start, fp.end);
    else if (textLike) rec.text = utf8dec(latin1(buf, fp.start, Math.min(fp.end, fp.start + 400000))).slice(0, 200000);
    else rec.unsupported = true;
    const sid = sidInUrl || "sess_" + uuid();
    saveFile(sid, rec);
    const now = Math.floor(Date.now() / 1000);
    return $done(localJson(200, {
      source: null, size, name, id: rec.id, object: "session.file", status: "completed",
      session: { expires_at: now + 600, expires_after: { seconds: 600, anchor: "last_active_at" }, last_active_at: now, created_at: now, id: sid, object: "session" },
      created_at: now, session_id: sid, completed_at: now, uploaded_at: now, mime_type: mime, upload_url: null, failed_at: null,
    }));
  } catch (e) {
    console.log(TAG + " upload error: " + (e && e.stack || e));
    return $done(localJson(500, { error: { code: "upload_failed", message: "文件保存失败" } }));
  }
}

/* ───────────── 联网搜索额度保护 ───────────── */
const SEARCH_OFF_KEY = "siri_bridge_search_off";
const SEARCH_COOLDOWN = 15 * 60 * 1000;
const SEARCH_NOTE = "\n\n（联网搜索不可用，这次没有联网。）";
function searchCooling() { try { return Number(fetchStore(SEARCH_OFF_KEY) || 0) > Date.now(); } catch (e) { return false; } }

/* ───────────── 连续对话：会话历史（$persistentStore） ─────────────
 * 追问请求发往 /v1/sessions/{sid}/responses，只带新一句话 + previous_choice_id，不带历史。 */
const STORE_KEY = "siri_bridge_sessions";
const SESS_TTL = 3600 * 1000;
const MAX_SESS = 12;
const MAX_TURNS = 20;
const SEND_CHARS = 20000; // 每次请求最多带给模型的历史字数（超出先丢最早的）
const MAX_CHARS = 60000;
let SESSION = { sid: null, cid: null, follow: false, prev: null };

function loadSessions() {
  try { const r = fetchStore(STORE_KEY); return r ? JSON.parse(r) || {} : {}; } catch (e) { return {}; }
}
function saveSessions(all) {
  try {
    const now = Date.now();
    Object.keys(all).forEach((k) => { if (!all[k] || now - all[k].t > SESS_TTL) delete all[k]; });
    Object.keys(all).sort((a, b) => all[b].t - all[a].t).slice(MAX_SESS).forEach((k) => delete all[k]);
    store(STORE_KEY, JSON.stringify(all));
  } catch (e) { console.log(TAG + " save session failed: " + e); }
}
function historyMsgs(sid, prevChoice, maxTurns) {
  const sess = loadSessions()[sid];
  if (!sess || !Array.isArray(sess.turns)) return [];
  let turns = sess.turns;
  if (prevChoice) { const i = turns.findIndex((t) => t.c === prevChoice); if (i >= 0) turns = turns.slice(0, i + 1); }
  turns = maxTurns > 0 ? turns.slice(-maxTurns) : [];
  while (turns.length > 1 && turns.reduce((n, t) => n + t.u.length + t.m.length, 0) > SEND_CHARS) turns = turns.slice(1);
  const out = [];
  turns.forEach((t) => { out.push({ role: "user", parts: [{ t: t.u }] }); out.push({ role: "assistant", parts: [{ t: t.m }] }); });
  return out;
}
function recordTurn(sid, cid, prevChoice, userText, modelText) {
  const all = loadSessions();
  const sess = all[sid] || { t: 0, turns: [] };
  let turns = sess.turns;
  if (prevChoice) { const i = turns.findIndex((t) => t.c === prevChoice); if (i >= 0) turns = turns.slice(0, i + 1); }
  turns.push({ c: cid, u: String(userText).slice(0, 3000), m: String(modelText).slice(0, 3000) });
  turns = turns.slice(-MAX_TURNS);
  while (turns.length > 1 && turns.reduce((n, t) => n + t.u.length + t.m.length, 0) > MAX_CHARS) turns.shift();
  all[sid] = { t: Date.now(), turns };
  saveSessions(all);
}

/* ───────────── 构造 Siri SSE 响应 ───────────── */
const ev = (name, data) => "event: " + name + "\ndata: " + JSON.stringify({ [name]: data, type: name }) + "\n\n";
function buildSSE(text, citations, model, extra) {
  const now = Math.floor(Date.now() / 1000);
  const sid = SESSION.sid || "sess_" + uuid();
  const rid = "resp_" + uuid().replace(/-/g, "");
  const cid = SESSION.cid || "choice_" + uuid();
  const value = makeValue(text, extra);
  const annotations = (citations || []).map((c) => ({ type: "url_citation", url_citation: { index: 0, title: c.title || c.url, url: c.url } }));
  const content = { text: { annotations, value }, type: "text" };
  const item = { type: "message", message: { role: "assistant", content: [content] } };
  const choiceDone = { output: [item], moderation: [], id: cid, status: "completed" };
  const P = "session.response.choices[].";
  let s = "";
  s += ev("session.created", { expires_at: now + 600, expires_after: { seconds: 600, anchor: "last_active_at" }, last_active_at: now, created_at: now, id: sid, object: "session" });
  s += ev("session.response.created", { notices: [], session_id: sid, created_at: now, model, id: rid, choices: [], object: "session.response" });
  s += ev(P + "added", { index: 0, choice: { output: [], id: cid, status: "incomplete" } });
  s += ev(P + "items[].added", { choice_index: 0, item: { type: "message", message: { role: "assistant", content: [] } }, index: 0 });
  s += ev(P + "items[].message.content[].added", { item_index: 0, choice_index: 0, index: 0, content: { text: { annotations: [], value: "" }, type: "text" } });
  for (let i = 0; i < value.length; i += 60) {
    s += ev(P + "items[].message.content[].text.value.delta", { item_index: 0, choice_index: 0, content_index: 0, delta: value.slice(i, i + 60) });
  }
  s += ev(P + "items[].message.content[].text.value.done", { item_index: 0, choice_index: 0, content_index: 0, value });
  annotations.forEach((a, i) => { s += ev(P + "items[].message.content[].text.annotations[].added", { annotation: a, item_index: 0, choice_index: 0, content_index: 0, index: i }); });
  s += ev(P + "items[].message.content[].done", { item_index: 0, choice_index: 0, index: 0, content });
  s += ev(P + "items[].done", { choice_index: 0, item, index: 0 });
  s += ev(P + "completed", { index: 0, choice: choiceDone });
  s += ev(P + "done", { index: 0, choice: choiceDone });
  s += ev("session.response.done", { notices: [], session_id: sid, created_at: now + 1, model, id: rid, choices: [choiceDone], object: "session.response" });
  return { sid, body: s };
}
let finished = false;
function reply(text, citations, model, extra) {
  if (finished) return;
  finished = true;
  const r = buildSSE(text, citations, model, extra);
  $done({ response: { status: 200, headers: { "Content-Type": "text/event-stream;charset=UTF-8", "x-session-id": r.sid }, body: r.body } });
}

/* ───────────── 统一消息 → 各服务商请求 ───────────── */
const ANTHROPIC_IMG = /^image\/(png|jpe?g|gif|webp)$/i;
const OPENAI_IMG = /^image\/(png|jpe?g|gif|webp)$/i;

function normalize(msgs) {
  // 合并同角色相邻消息，并保证以用户消息开头（Gemini / Anthropic 的要求）
  const out = [];
  msgs.forEach((m) => pushMsg(out, m.role, m.parts));
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}
function partsToText(parts) { return parts.filter((p) => p.t).map((p) => p.t).join("\n"); }

function buildGemini(a, system, msgs, structured, searchOn) {
  const gc = { maxOutputTokens: a.max };
  const m = a.model;
  if (a.fast && /flash/i.test(m) && !/pro/i.test(m)) {
    gc.thinkingConfig = (+((/gemini-(\d+)/i.exec(m) || [])[1]) >= 3 || /-latest$/i.test(m)) ? { thinkingLevel: "minimal" } : { thinkingBudget: 0 };
  } else {
    gc.maxOutputTokens = Math.max(a.max, a.style === "详细" ? 8192 : 4096); // 思考会占用输出额度
  }
  if (structured) {
    gc.responseMimeType = "application/json";
    gc.responseSchema = structuredSchema();
    gc.maxOutputTokens = Math.max(gc.maxOutputTokens, 4096);
  }
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: msgs.map((x) => ({
      role: x.role === "assistant" ? "model" : "user",
      parts: x.parts.map((p) => p.t !== undefined ? { text: p.t } : p.img ? { inlineData: { mimeType: p.img.mime, data: p.img.b64 } } : { inlineData: { mimeType: p.file.mime, data: p.file.b64 } }),
    })),
    generationConfig: gc,
  };
  if (searchOn) body.tools = [{ google_search: {} }];
  return { url: a.base + "/v1beta/models/" + encodeURIComponent(m) + ":generateContent", headers: { "Content-Type": "application/json", "x-goog-api-key": a.key }, body };
}
function buildAnthropic(a, system, msgs, structured, searchOn) {
  const conv = (p) => {
    if (p.t !== undefined) return { type: "text", text: p.t };
    if (p.img) {
      if (!ANTHROPIC_IMG.test(p.img.mime)) throw new Error("Anthropic 不支持 " + p.img.mime + " 格式的图片，仅支持 PNG、JPEG、GIF、WebP。");
      return { type: "image", source: { type: "base64", media_type: p.img.mime.replace("jpg", "jpeg"), data: p.img.b64 } };
    }
    if (p.file.mime === "application/pdf") return { type: "document", source: { type: "base64", media_type: "application/pdf", data: p.file.b64 } };
    if (ANTHROPIC_IMG.test(p.file.mime)) return { type: "image", source: { type: "base64", media_type: p.file.mime, data: p.file.b64 } };
    throw new Error("Anthropic 不支持处理 " + p.file.name + " 这种格式的文件，仅支持 PDF、图片和文本类文件。");
  };
  const body = { model: a.model, max_tokens: a.max, system, messages: msgs.map((x) => ({ role: x.role, content: x.parts.map(conv) })) };
  if (searchOn) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
  return { url: a.base + "/v1/messages", headers: { "Content-Type": "application/json", "x-api-key": a.key, "anthropic-version": "2023-06-01" }, body };
}
function buildOpenAI(a, system, msgs, structured) {
  const conv = (p) => {
    if (p.t !== undefined) return { type: "text", text: p.t };
    if (p.img) {
      if (!OPENAI_IMG.test(p.img.mime)) throw new Error("该接口不支持 " + p.img.mime + " 格式的图片，仅支持 PNG、JPEG、GIF、WebP。");
      return { type: "image_url", image_url: { url: "data:" + p.img.mime + ";base64," + p.img.b64 } };
    }
    if (p.file.mime === "application/pdf" && a.provider === "openai") return { type: "file", file: { filename: p.file.name, file_data: "data:application/pdf;base64," + p.file.b64 } };
    if (OPENAI_IMG.test(p.file.mime)) return { type: "image_url", image_url: { url: "data:" + p.file.mime + ";base64," + p.file.b64 } };
    throw new Error("当前服务商不支持处理 " + p.file.name + " 这种格式的文件，请换用 Gemini，或只上传图片和文本类文件。");
  };
  const messages = [{ role: "system", content: system }].concat(msgs.map((x) => {
    const parts = x.parts.map(conv);
    // 纯文本用字符串，兼容性最好；含图片/文件时用数组
    return { role: x.role, content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text).join("\n") : parts };
  }));
  const base = /\/v1$/i.test(a.base) ? a.base : a.base + "/v1";
  const body = { model: a.model, messages, max_tokens: a.max, stream: false };
  if (structured && a.provider === "openai") body.response_format = { type: "json_object" };
  return { url: base + "/chat/completions", headers: { "Content-Type": "application/json", Authorization: "Bearer " + a.key }, body };
}
function buildRequest(a, system, msgs, structured, searchOn) {
  if (a.provider === "gemini") return buildGemini(a, system, msgs, structured, searchOn);
  if (a.provider === "anthropic") return buildAnthropic(a, system, msgs, structured, searchOn);
  if (a.provider === "openai" || a.provider === "openai_compatible") return buildOpenAI(a, system, msgs, structured);
  throw new Error("不支持的服务商：" + a.provider + "，可选 gemini / openai / anthropic / openai_compatible。");
}

function extract(j, provider) {
  const seen = {};
  const cite = (arr) => arr.filter((w) => w && w.url && !seen[w.url] && (seen[w.url] = 1)).slice(0, 5);
  if (provider === "gemini") {
    const c = (j.candidates || [])[0] || {};
    return {
      text: ((c.content && c.content.parts) || []).filter((p) => p.text && !p.thought).map((p) => p.text).join(""),
      cites: cite((((c.groundingMetadata || {}).groundingChunks) || []).map((x) => x.web && { url: x.web.uri, title: x.web.title })),
      finish: c.finishReason, block: j.promptFeedback && j.promptFeedback.blockReason,
    };
  }
  if (provider === "anthropic") {
    const blocks = (j.content || []).filter((x) => x.type === "text");
    const cs = [];
    blocks.forEach((b) => (b.citations || []).forEach((c) => cs.push({ url: c.url, title: c.title })));
    return { text: blocks.map((x) => x.text || "").join(""), cites: cite(cs), finish: j.stop_reason === "max_tokens" ? "MAX_TOKENS" : j.stop_reason };
  }
  const ch = (j.choices || [])[0] || {};
  let t = ch.message && ch.message.content;
  if (Array.isArray(t)) t = t.map((x) => x.text || "").join("");
  return { text: t || "", cites: [], finish: ch.finish_reason === "length" ? "MAX_TOKENS" : ch.finish_reason };
}

/* ───────────── 主流程 ───────────── */
function main() {
  const fm = $request && /\/v1\/sessions(?:\/([^\/?]+))?\/files(?:\?|$)/.exec($request.url);
  if (fm && String($request.method).toUpperCase() === "POST") return handleUpload(fm[1]);
  const um = $request && /\/v1\/sessions(?:\/([^\/?]+))?\/responses(?:\?|$)/.exec($request.url);
  if (!um) {
    finished = true;
    // 隐私兜底：该域名下非对话接口的请求默认本地拒绝，绝不原样发给原服务
    if ($request && readArgs().strict) {
      const hdr = $request.headers || {};
      const ct = hdr["Content-Type"] || hdr["content-type"] || "?";
      const bl = typeof $request.body === "string" ? $request.body.length : ($request.body && $request.body.byteLength) || 0;
      console.log(TAG + " blocked non-response request: " + $request.method + " " + String($request.url).replace(/^https?:\/\/[^\/]+/, "").split("?")[0] + " | content-type=" + String(ct).split(";")[0] + ", body=" + bl);
      return $done({ response: { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: { code: "blocked", message: "blocked by Siri AI Bridge" } }) } });
    }
    return $done({});
  }
  SESSION.sid = um[1] || "sess_" + uuid();
  SESSION.cid = "choice_" + uuid();
  SESSION.follow = !!um[1];
  if (typeof setTimeout === "function") {
    setTimeout(() => { console.log(TAG + " watchdog fired"); reply("AI 响应太慢了，这次先放弃，请稍后再试。", [], "AI"); }, WATCHDOG_MS);
  }
  const a = readArgs();
  const label = a.model || "AI";
  if ($request.method !== "POST") return reply("仅支持 POST 请求。", [], label);
  console.log(TAG + " script v" + VERSION + " running, provider=" + a.provider + ", model=" + a.model + ", style=" + a.style);

  let body;
  try { body = JSON.parse($request.body); } catch (e) { return reply("无法解析 Siri 请求，未向 AI 服务发送数据。", [], label); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.input)) return reply("Siri 请求结构不受支持，未向 AI 服务发送数据。", [], label);
  try {
    const cfg = body.configuration || {};
    const rf = (body.response_format && body.response_format.json_schema && body.response_format.json_schema.schema) || {};
    console.log(TAG + " feature=" + (cfg.response_configuration_group_id || "?") + ", schema=" + Object.keys(rf.properties || {}).join("/") + ", tools=" + (body.client_tools || []).length + "/" + (body.server_tools || []).length);
  } catch (e) {}
  try {
    const jsch = body.response_format && body.response_format.json_schema;
    const sch = jsch && jsch.schema;
    if (sch && sch.properties && jsch.content_property && sch.properties[jsch.content_property]) OUT = { prop: jsch.content_property, props: sch.properties };
  } catch (e) {}

  if (!a.key || !a.model) return reply("请先在 Loon 插件参数里填写 API Key 和模型名称。", [], label);
  if (!a.base) return reply("请先在 Loon 插件参数里填写 API 地址。", [], label);
  const structured = extraProps().length > 0;
  SESSION.prev = body.previous_choice_id || null;

  const u = toUnified(body, OUT.prop);
  if (u.unsupported) return reply("这种内容格式暂时识别不了，目前支持文字、相机图片和上传的文件。", [], label);
  if (!u.msgs.length) return reply("没有识别到文字内容。", [], label);

  const hist = SESSION.follow ? historyMsgs(SESSION.sid, SESSION.prev, a.history) : [];
  if (SESSION.follow) console.log(TAG + " follow-up, history messages=" + hist.length + " (limit " + a.history + " turns), chars=" + hist.reduce((n, m) => n + m.parts[0].t.length, 0));
  const fileList = loadFiles(SESSION.sid);
  const fileParts = [];
  let fileUnsupported = null;
  fileList.forEach((f) => {
    if (f.b64) fileParts.push({ file: { mime: f.mime, b64: f.b64, name: f.name } }, { t: "（上面是用户上传的文件：" + f.name + "）" });
    else if (f.text) fileParts.push({ t: "【用户上传的文件：" + f.name + "】\n" + f.text });
    else if (f.unsupported) fileUnsupported = f;
  });
  if (fileList.length) console.log(TAG + " files attached: " + fileList.map((f) => f.name + "(" + f.mime + ")").join(", "));
  if (fileUnsupported && !fileParts.length) return reply("暂不支持 " + fileUnsupported.name + " 这种格式的文件，目前支持 PDF、图片、音视频和文本类文件。", [], label);

  // 相机图片：本轮带图就记下来；追问时（本轮没带图）把最近一张图接回去
  const imgParts = [];
  if (u.hasImage) saveImage(SESSION.sid, lastUserImage(u.msgs));
  else if (SESSION.follow && a.history > 0) {
    const si = loadImage(SESSION.sid);
    if (si) {
      imgParts.push({ img: { mime: si.mime, b64: si.b64 } }, { t: "（上面是用户之前发来的图片）" });
      console.log(TAG + " previous image re-attached for follow-up");
    }
  }
  const prefixParts = fileParts.concat(imgParts);
  const msgs = normalize((prefixParts.length ? [{ role: "user", parts: prefixParts }] : []).concat(hist, u.msgs));
  const lastUser = u.msgs.filter((m) => m.role === "user").slice(-1)[0];
  const userText = lastUser ? (lastUser.parts.some((p) => p.img) ? "[用户发送了一张图片] " : "") + partsToText(lastUser.parts) : "";
  if (u.hasImage) console.log(TAG + " image request, messages=" + msgs.length);

  const system = [IDENTITY, structured ? structuredPrompt() : STYLES[a.style], structured ? "" : todayLine(), a.prompt].concat(u.system).filter(Boolean).join("\n");

  // 联网搜索：Gemini（Google Search）与 Anthropic（web_search）支持；其他服务商忽略
  const searchCapable = a.provider === "gemini" || a.provider === "anthropic";
  let searchOn = a.search && searchCapable, searchSkipped = false;
  if (a.search && !searchCapable) { searchSkipped = true; console.log(TAG + " provider " + a.provider + " has no search adapter, ignoring SEARCH"); }
  else if (searchOn && searchCooling()) { searchOn = false; searchSkipped = true; console.log(TAG + " search recently failed, skipping"); }

  let req, thinkOn = a.provider === "gemini" && a.fast;
  const rebuild = () => { req = buildRequest(a, system, msgs, structured, searchOn); if (a.provider === "gemini" && !thinkOn) delete req.body.generationConfig.thinkingConfig; };
  try { rebuild(); } catch (e) { return reply(e.message, [], label); }

  const startAt = Date.now();
  const remaining = () => BUDGET_MS - (Date.now() - startAt);
  let retriedTemp = false, retriedNet = false, retriedNoThink = false, retriedNoSearch = false;

  function attempt() {
    if (finished) return; // 看门狗已经回复过了，不再发请求
    const timeout = Math.max(5000, Math.min(ATTEMPT_MS, remaining() - 2000));
    console.log(TAG + " POST via Loon config rules, timeout=" + timeout + "ms");
    $httpClient.post({ url: req.url, headers: req.headers, body: JSON.stringify(req.body), timeout }, (err, resp, data) => {
      if (err) {
        console.log(TAG + " request failed: " + err);
        if (!retriedNet && remaining() > RETRY_MIN_MS) { retriedNet = true; return attempt(); }
        return reply("连接 AI 服务失败，请检查 API 地址及 Loon 当前网络规则。", [], label);
      }
      try { handle(resp, data); } catch (e) {
        console.log(TAG + " handle error: " + (e && e.stack || e));
        reply("处理 AI 回复时出错了，请稍后再试。", [], label);
      }
    });
  }

  function handle(resp, data) {
    const status = resp && resp.status;
    let j;
    try { j = JSON.parse(data); } catch (e) {
      console.log(TAG + " bad body (HTTP " + status + "): " + String(data).slice(0, 200));
      if (status === 413) return reply("文件或对话内容太大，处理不了。请开始一个新对话，或换小一点的文件。", [], label);
      return reply("AI 服务返回了无法解析的内容（HTTP " + status + "）。", [], label);
    }
    if (status < 200 || status >= 300 || j.error) {
      const msg = String((j.error && (j.error.message || j.error.type || j.error)) || j.message || ("HTTP " + status));
      console.log(TAG + " api error " + status + ": " + msg.slice(0, 200));
      // 个别 Gemini 模型不支持关闭思考：去掉后重试一次
      if (status === 400 && a.provider === "gemini" && thinkOn && /think/i.test(msg) && !retriedNoThink) {
        retriedNoThink = true; thinkOn = false; rebuild(); return attempt();
      }
      // 搜索额度用完/不支持：去掉搜索重试，并暂停带搜索一段时间
      if (searchOn && (status === 429 || status === 400) && !retriedNoSearch) {
        retriedNoSearch = true; searchOn = false; searchSkipped = true;
        if (status === 429) store(SEARCH_OFF_KEY, String(Date.now() + SEARCH_COOLDOWN));
        console.log(TAG + " retrying without search (HTTP " + status + ")");
        rebuild(); return attempt();
      }
      if ((status === 429 || status >= 500) && !retriedTemp) {
        const wait = status === 429 ? (retryDelayMs(j, resp) || 1000) : 0;
        if (wait > MAX_WAIT_MS) return reply("AI 服务限流了，请约 " + Math.ceil(wait / 1000) + " 秒后再试。", [], label);
        if (remaining() > wait + RETRY_MIN_MS) {
          retriedTemp = true;
          if (wait > 0 && typeof setTimeout === "function") {
            console.log(TAG + " retrying in " + wait + "ms");
            return setTimeout(attempt, wait);
          }
          return attempt();
        }
      }
      let hint = "AI 服务出错了（" + status + "）：" + msg.slice(0, 100);
      if (status === 429) hint = retryDelayMs(j, resp) ? "AI 服务限流了，请约 " + Math.ceil(retryDelayMs(j, resp) / 1000) + " 秒后再试。" : "AI 服务额度用完了或请求太频繁，请稍后再试。";
      else if (status === 404) hint = "找不到这个模型或接口，请检查插件里的模型名称和 API 地址。";
      else if (status === 401 || status === 403 || /API key/i.test(msg)) hint = "API Key 无效或没有权限，请检查插件里的 Key。";
      else if (/location is not supported/i.test(msg)) hint = "当前网络地区不支持该服务，请检查代理节点。";
      else if (status === 413 || (status === 400 && /too large|exceed|payload|request size|maximum (number of tokens|context)|context length|token count/i.test(msg))) hint = "文件或对话内容太大，处理不了。请开始一个新对话，或换小一点的文件。";
      else if (status === 400 && /mime|unsupported|not supported|invalid.*(file|media|data|image)|could not process/i.test(msg)) hint = "服务商不支持这种文件或内容格式，请换个格式再试。";
      else if (status === 503 || status === 529 || /overloaded|unavailable/i.test(msg)) hint = "AI 服务现在比较繁忙，请稍后再试。";
      return reply(hint, [], label);
    }

    const r = extract(j, a.provider);
    let rawText = r.text, extra = null;
    if (structured && rawText) {
      try {
        const jo = JSON.parse(rawText.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "").trim());
        extra = {};
        extraProps().forEach((k) => {
          const v = jo[k], ty = pickType(OUT.props[k] && OUT.props[k].type);
          if (ty === "array") extra[k] = Array.isArray(v) ? v.map((x) => stripMd(String(x))).filter(Boolean).slice(0, 6) : [];
          else if (typeof v === "string") extra[k] = stripMd(v);
        });
        rawText = typeof jo[OUT.prop] === "string" ? jo[OUT.prop] : rawText;
      } catch (e) { console.log(TAG + " structured parse failed, using raw text"); }
    }
    const text = stripMd(rawText);
    if (!text) {
      if (r.finish === "MAX_TOKENS") return reply("这个问题思考过久没来得及回答，请换个问法，或在插件里开启快速模式、调大最大输出。", [], label);
      const why = r.block || r.finish || "空回复";
      return reply(BLOCK_TEXT[why] || ("AI 没有给出回答（" + why + "），请再试一次。"), [], label);
    }
    const us = j.usageMetadata || j.usage || {};
    console.log(TAG + " response received (HTTP " + status + "), tokens: input=" + (us.promptTokenCount || us.input_tokens || us.prompt_tokens || "?") + ", cached=" + (us.cachedContentTokenCount || us.cache_read_input_tokens || 0) + ", output=" + (us.candidatesTokenCount || us.output_tokens || us.completion_tokens || "?"));
    try { recordTurn(SESSION.sid, SESSION.cid, SESSION.prev, userText, text); } catch (e) { console.log(TAG + " record turn failed: " + e); }
    reply(searchSkipped && a.search && !structured ? text + SEARCH_NOTE : text, r.cites, label, extra);
  }
  attempt();
}

try { main(); } catch (e) {
  console.log(TAG + " fatal: " + (e && e.stack || e));
  reply("脚本出错了，已拦下这次请求。", [], "AI");
}
