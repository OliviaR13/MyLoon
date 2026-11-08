/*
 * Siri → Gemini 独立兼容层  v3.0.0
 *
 * 兼容 Siri 请求协议并由 Gemini API 独立处理，按 Siri 兼容的 SSE 事件流返回。
 * 不调用千问作为上游或备用服务；不支持的输入会明确报错，不会回落到千问。
 *
 * 注意：$httpClient 的 timeout 单位以 Loon 实际表现为准（脚本按毫秒传值），
 * 请在 Loon 日志里核对一次；时间预算见下方 BUDGET_MS / ATTEMPT_MS。
 */

const VERSION = "3.0.0";
const TAG = "[qianwen_gemini]";

const DEFAULTS = {
  MODEL: "gemini-flash-lite-latest", // 别名自动跟随最新的 flash-lite：快、省、免维护；2.5 系列对新用户已不可用（404），也用它兜底
  BASE: "https://generativelanguage.googleapis.com",
};

// 身份与触发词：大陆需要在话语前加「使用千问」才会走扩展模型，该前缀只是触发词，不属于问题
const IDENTITY = "你是 Google 的 Gemini 大语言模型，不是千问或通义。用户话语里的「使用千问」「问问千问」等只是唤起 Siri 扩展的触发词，请完全忽略，直接回答问题本身，不要提到千问，也不要自称千问。";
// 视觉智能（相机）只发图片、没有文字时使用的默认问题
const IMAGE_ONLY_PROMPT = "请识别并简要说明图片里是什么；如果有文字，请读出重点；如果是商品、植物、动物或地点，请说出名称和关键信息。";
// 触发词清洗：用户说「使用千问」「问问千问」「帮我问一下千问」「向千问提问」等只是唤起扩展，不属于问题；
// 前缀、句末后缀、英文说法都会去掉
const TRIGGER_PREFIX = /^[\s，,。.、]*(?:(?:请|帮我|麻烦你?)?(?:使用|调用|用|问问|问一下|问下|问|叫|让)(?:一下|下)?(?:通义)?千问|(?:请|帮我|麻烦你?)?向(?:通义)?千问)(?:帮我|一下|下|说|回答|提问|请教)?[\s，,、:：。.]*/;
const TRIGGER_SUFFIX = /[\s，,、:：。.]+(?:请|帮我|麻烦你?)?(?:使用|调用|用|问问|问一下|问下|问)(?:通义)?千问(?:帮我|一下|下)?[\s。.]*$/;
const TRIGGER_EN = /^\s*(?:please\s+)?(?:ask|use|query)\s+(?:tongyi\s+)?qwen[\s,:，：]*/i;
function cleanTrigger(t) { return String(t).replace(TRIGGER_PREFIX, "").replace(TRIGGER_EN, "").replace(TRIGGER_SUFFIX, "").trim(); }

// 回答风格预设（PROMPT 参数作为额外提示词追加在其后）
// 排版规则：模型被要求“适合朗读”时偶尔会省略逗号、整段不分行，这里明确要求保留标点并分段
const FORMAT_RULES = "排版要求：必须使用完整的中文标点（逗号、顿号、句号、冒号等），不要省略标点；内容较多时按意思分成几个短段落，段落之间空一行；英文名称与中文之间用标点或空格隔开。";
const STYLES = {
  "简短口语": "你是 Siri 的后台助手。请用简洁、口语化的中文回答，语句自然流畅；不要使用 Markdown、列表符号或表情。" + FORMAT_RULES,
  "标准": "你是 Siri 的后台助手。请用清晰、自然的中文回答，条理分明但不要使用 Markdown、列表符号或表情。" + FORMAT_RULES,
  "详细": "你是 Siri 的后台助手。请用中文详细回答，必要时分点说明，但不要使用 Markdown 符号或表情。" + FORMAT_RULES,
};

// 时间预算（毫秒）：整个脚本不超过插件里 timeout=60 秒；网络分流完全交给 Loon 当前配置规则
const BUDGET_MS = 48000;
const WATCHDOG_MS = 52000;  // 看门狗：必须赶在 Loon 60 秒强杀脚本（并放行原请求给千问）之前本地回复
const ATTEMPT_MS = 45000;   // 单次请求上限
const RETRY_MIN_MS = 12000; // 剩余不足这么久就不再重试
const MAX_WAIT_MS = 15000;  // 限流时最多愿意等多久再重试；超过就直接告诉用户多久后再试

/* ───────────── 参数 ───────────── */
function readArgs() {
  let a = typeof $argument === "undefined" ? {} : $argument;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch (e) { a = {}; } }
  const isPlaceholder = (v) => /^\{.*\}$/.test(v);
  // 高级覆写：$persistentStore 里的 SIRI_GEMINI_<参数名>（如 SIRI_GEMINI_HISTORY=2轮）优先于插件参数。
  // 插件只展示必要参数，其余都有合适的默认值，需要时再用这种方式调整
  const ov = (k) => {
    try {
      if (typeof $persistentStore !== "undefined") {
        const x = $persistentStore.read("SIRI_GEMINI_" + k);
        if (x !== null && x !== undefined && String(x).trim() !== "") return String(x).trim();
      }
    } catch (e) {}
    return undefined;
  };
  const get = (k) => {
    const o = ov(k);
    const v = o !== undefined ? o : a[k];
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return isPlaceholder(s) || s === "null" ? undefined : s;
  };
  const style = STYLES[get("STYLE")] ? get("STYLE") : "简短口语";
  return {
    KEY: (get("KEY") || "").replace(/\s+/g, ""),
    MODEL: (get("CUSTOM_MODEL") || get("MODEL") || DEFAULTS.MODEL).replace(/^\/?models\//i, ""),
    STYLE: style,
    BASE: (get("BASE") || DEFAULTS.BASE).replace(/\/+$/, "").replace(/\/v1(beta)?$/i, ""),
    // 旧版本的默认提示词（已内置为「简短口语」风格）如果还留在参数里，视为未填写，避免重复/冲突
    PROMPT: (get("PROMPT") === "你是 Siri 的后台助手。请用简洁、口语化的中文回答，适合直接朗读；不要使用 Markdown、列表符号或表情。" ? "" : get("PROMPT")) || "",
    // 联网搜索：自动（默认，问题涉及天气、新闻、价格等实时信息才联网）/ 开 / 关；兼容旧版开关的 true / false
    SEARCH: (() => { const v = get("SEARCH"); return v === "true" || v === "开" ? "on" : v === "false" || v === "关" ? "off" : "auto"; })(),
    FAST: get("FAST") !== "false",
    HISTORY: (() => { const v = get("HISTORY"); if (v === "不带历史") return 0; const n = parseInt(v, 10); return isFinite(n) ? Math.max(0, Math.min(20, n)) : 6; })(),
    MAX: (() => { const n = parseInt(get("MAX"), 10); return isFinite(n) ? Math.max(128, Math.min(8192, n)) : 0; })(), // 0 = 按回答风格自动
    STRICT: get("STRICT") !== "false",   // 隐私兜底：默认拦截该域名下除对话接口外的所有请求
  };
}

/* ───────────── 工具 ───────────── */
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });

// Siri 是朗读/纯文本展示，去掉 Markdown 标记
function stripMd(t) {
  return String(t)
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

// 诊断：只记录非文本内容块的“结构”（类型、字段名、值的类型/长度），不记录内容本身
function shapeOf(v, depth) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return "str(" + v.length + ")" + (/^https?:\/\//.test(v) ? "@" + v.split("/")[2] : /^data:/.test(v) ? ":" + v.slice(5, v.indexOf(";")) : "");
  if (typeof v !== "object") return typeof v;
  if (depth > 3) return "…";
  if (Array.isArray(v)) return "[" + v.slice(0, 3).map((x) => shapeOf(x, depth + 1)).join(",") + (v.length > 3 ? ",…" : "") + "]";
  return "{" + Object.keys(v).map((k) => k + ":" + shapeOf(v[k], depth + 1)).join(",") + "}";
}

function stripTrigger(t) {
  const r = cleanTrigger(t);
  return r || t; // 去掉后为空就保留原文
}

/* ───────────── 输出结构：跟随请求里的 response_format ─────────────
 * 相机/普通对话: content + summary + isRequestingUserInput
 * 写作工具(compose): body + refinements(三条改写建议)
 * 脚本按请求里 json_schema 的字段生成返回，未知字段给空值。 */
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

// 除正文/summary/isRequestingUserInput 之外还有别的字段（如 refinements）时，需要 Gemini 结构化输出
function extraProps() { return Object.keys(OUT.props).filter((k) => k !== OUT.prop && !KNOWN[k]); }

// JSON Schema → Gemini responseSchema（OpenAPI 子集）
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
  return "你是写作与文字处理助手。请只输出 JSON，字段含义如下（以用户请求所用的语言书写，通常是简体中文）：\n" + lines.join("\n") +
    "\n正文要可直接使用，不要使用 Markdown 标记（如 # 和 **）、不要加寒暄或解释；必须使用完整的中文标点，内容较多时分段。";
}

/* ───────────── 千问请求 → Gemini contents ───────────── */
function toGemini(body, contentProp) {
  const contents = [];
  const system = [];
  let unsupported = false;
  let hasImage = false;
  for (const it of body.input || []) {
    if (!it || it.type !== "message" || !it.message) continue;
    const m = it.message;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const imgParts = [];
    let text = blocks
      .map((c) => {
        if (c && typeof c.text === "string") return c.text;
        // 图片：千问格式为 {type:"image_url", image_url:{url:"data:image/jpeg;base64,..."}}
        const u = c && c.type === "image_url" && c.image_url && c.image_url.url;
        if (typeof u === "string") {
          const mm = /^data:([^;,]+);base64,(.+)$/s.exec(u);
          if (mm) { imgParts.push({ inlineData: { mimeType: mm[1], data: mm[2] } }); return ""; }
        }
        if (c && Object.keys(c).length) {
          unsupported = true;
          console.log(TAG + " non-text block: " + shapeOf(c, 0));
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (imgParts.length && m.role !== "assistant" && m.role !== "system" && m.role !== "developer") {
      hasImage = true;
      const t2 = cleanTrigger(text) || IMAGE_ONLY_PROMPT; // 只剩触发词时也按“看图”处理
      const parts = imgParts.concat([{ text: t2 }]);
      const lastC = contents[contents.length - 1];
      if (lastC && lastC.role === "user") lastC.parts.push(...parts);
      else contents.push({ role: "user", parts });
      continue;
    }
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") {
      // 请求里自带的系统提示若设定成千问人设，会盖过我们的提示，去掉含千问/通义的行
      const kept = text.split("\n").filter((l) => !/千问|通义|Qwen/i.test(l)).join("\n").trim();
      if (kept) system.push(kept);
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    if (role === "user") text = stripTrigger(text);
    // 历史里的助手回复是 JSON 字符串，取出正文再给 Gemini
    if (role === "model") {
      try {
        const jo = JSON.parse(text);
        if (jo && typeof jo[contentProp || "content"] === "string") text = jo[contentProp || "content"];
      } catch (e) {}
    }
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  return { contents, system, unsupported, hasImage };
}

/* ───────────── 文件上传：本地接住，不发给千问 ─────────────
 * 流程：Siri 先 POST /v1/sessions/files（multipart：file + json）上传文件，
 * 随后的对话请求只带文字，文件靠会话 ID 关联。脚本在本地解析 multipart，
 * 把文件存进 $persistentStore，回一个与千问同结构的“上传成功”响应；
 * 对话请求到来时，再把该会话的文件一并发给 Gemini。 */
const FILE_KEY = "siri_gemini_file:";
const FILE_INDEX = "siri_gemini_file_index";
const FILE_TTL = 3600 * 1000;       // 文件保留 1 小时
const FILE_MAX_SESS = 3;            // 最多同时保留几个会话的文件
const FILE_MAX_BYTES = 6 * 1024 * 1024; // 单个文件上限 6MB
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
 * 追问请求只带文字，历史里也只记文字，所以要把最近一张图存下来，追问时接回去，
 * 否则「这是什么品种」这类追问 Gemini 看不到图。每个会话只留最近一张，1 小时过期。 */
const IMG_KEY = "siri_gemini_img:";
const IMG_INDEX = "siri_gemini_img_index";
const IMG_MAX_B64 = 4 * 1024 * 1024; // 单张图片 base64 上限，超过就不保留
function lastUserImage(contents) {
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i].role !== "user") continue;
    const p = contents[i].parts.filter((x) => x.inlineData);
    if (p.length) return { mime: p[p.length - 1].inlineData.mimeType, b64: p[p.length - 1].inlineData.data };
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

// Gemini 没有时钟：把今天的日期告诉它（只放日期，不放具体时间，避免每次都破坏缓存）
function todayLine() {
  const d = new Date();
  return "当前日期：" + d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 星期" + "日一二三四五六"[d.getDay()] + "。涉及今天、明天、现在、最近等时间问题时，以这个日期为准。";
}

// 联网搜索「自动」模式：问题明显需要实时信息时才联网，其余不联网，保持快速
const SEARCH_CUE = /(最新|最近|实时|刚刚|刚才|新闻|热搜|头条|天气|气温|下雨|下雪|空气质量|股价|股市|股票|汇率|币价|比特币|油价|金价|行情|比分|赛程|战绩|票房|上映|发布会|多少钱|售价|报价|价格|航班|车次|路况|限行|营业时间|谁赢了|获奖名单|更新了什么|latest|news|weather|price|score|stock)/i;
function needsSearch(text) { return SEARCH_CUE.test(String(text || "")); }

// 限流时 Gemini 会告诉要等多久：error.details 里的 retryDelay，或错误信息里的 "retry in 12.3s"
function retryDelayMs(j) {
  try {
    const d = (((j.error || {}).details) || []).find((x) => x && x.retryDelay);
    if (d) { const m = /([\d.]+)s/.exec(String(d.retryDelay)); if (m) return Math.ceil(parseFloat(m[1]) * 1000); }
    const m2 = /retry in ([\d.]+)s/i.exec((j.error && j.error.message) || "");
    if (m2) return Math.ceil(parseFloat(m2[1]) * 1000);
  } catch (e) {}
  return 0;
}

// 被拦截或没有回答时，用中文说明原因
const BLOCK_TEXT = {
  SAFETY: "内容被 Gemini 的安全策略拦截了，请换个说法再试。",
  PROHIBITED_CONTENT: "内容被 Gemini 的安全策略拦截了，请换个说法再试。",
  BLOCKLIST: "内容被 Gemini 的安全策略拦截了，请换个说法再试。",
  SPII: "内容里可能含有敏感个人信息，Gemini 拒绝处理，请去掉后再试。",
  IMAGE_SAFETY: "图片被 Gemini 的安全策略拦截了，请换一张再试。",
  IMAGE_PROHIBITED_CONTENT: "图片被 Gemini 的安全策略拦截了，请换一张再试。",
  RECITATION: "回答可能涉及受版权保护的内容，已被拦截，请换个问法。",
  LANGUAGE: "Gemini 暂不支持这种语言。",
  OTHER: "Gemini 没能处理这个请求，请换个说法再试。",
  "空回复": "Gemini 这次没有给出回答，请再试一次。",
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
    const geminiInline = /^(application\/pdf|image\/(png|jpe?g|webp|heic|heif|gif)|audio\/|video\/)/.test(mime);
    const textLike = /^text\//.test(mime) || /^application\/(json|xml|x-yaml|yaml|javascript)/.test(mime) || TEXT_EXT.test(name);
    if (geminiInline) rec.b64 = toBase64(buf, fp.start, fp.end);
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

/* ───────────── 联网搜索额度保护 ─────────────
 * Gemini 3 的 Google 搜索（接地）有单独额度，免费 Key 常为 0，会返回 429。
 * 遇到 429 时自动去掉搜索重试，并在一段时间内不再带搜索，避免每次白白多等一次失败请求。 */
const SEARCH_OFF_KEY = "siri_gemini_search_off";
const SEARCH_COOLDOWN = 15 * 60 * 1000;
const SEARCH_NOTE = "\n\n（联网搜索额度不足，这次没有联网。）";
function searchCooling() {
  try { return Number(fetchStore(SEARCH_OFF_KEY) || 0) > Date.now(); } catch (e) { return false; }
}

/* ───────────── 连续对话：会话历史（$persistentStore） ─────────────
 * 追问请求发往 /v1/sessions/{sid}/responses，且只带新一句话 + previous_choice_id，
 * 没有历史。所以首轮回复里用的 sess_/choice_ 由脚本生成并记下对话，追问时取回。 */
const STORE_KEY = "siri_gemini_sessions";
const SESS_TTL = 3600 * 1000;   // 会话保留 1 小时
const MAX_SESS = 12;            // 最多保留的会话数
const MAX_TURNS = 20;           // 每个会话最多保留的轮数
const SEND_CHARS = 20000;       // 每次请求最多带给模型的历史字数（超出先丢最早的）
const MAX_CHARS = 60000;        // 每个会话历史最大字数
let SESSION = { sid: null, cid: null, follow: false, prev: null };

function loadSessions() {
  try {
    if (typeof $persistentStore === "undefined") return {};
    const r = $persistentStore.read(STORE_KEY);
    return r ? JSON.parse(r) || {} : {};
  } catch (e) { return {}; }
}
function saveSessions(all) {
  try {
    if (typeof $persistentStore === "undefined") return;
    const now = Date.now();
    Object.keys(all).forEach((k) => { if (!all[k] || now - all[k].t > SESS_TTL) delete all[k]; });
    const ids = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
    ids.slice(MAX_SESS).forEach((k) => delete all[k]);
    $persistentStore.write(JSON.stringify(all), STORE_KEY);
  } catch (e) { console.log(TAG + " save session failed: " + e); }
}
// 取出该会话的历史（按 previous_choice_id 截到对应那一轮；找不到就用全部）
function historyContents(sid, prevChoice, maxTurns) {
  const sess = loadSessions()[sid];
  if (!sess || !Array.isArray(sess.turns)) return [];
  let turns = sess.turns;
  if (prevChoice) {
    const i = turns.findIndex((t) => t.c === prevChoice);
    if (i >= 0) turns = turns.slice(0, i + 1);
  }
  turns = maxTurns > 0 ? turns.slice(-maxTurns) : [];
  while (turns.length > 1 && turns.reduce((n, t) => n + t.u.length + t.m.length, 0) > SEND_CHARS) turns = turns.slice(1);
  const out = [];
  turns.forEach((t) => {
    out.push({ role: "user", parts: [{ text: t.u }] });
    out.push({ role: "model", parts: [{ text: t.m }] });
  });
  return out;
}
function recordTurn(sid, cid, prevChoice, userText, modelText) {
  const all = loadSessions();
  const sess = all[sid] || { t: 0, turns: [] };
  let turns = sess.turns;
  if (prevChoice) {
    const i = turns.findIndex((t) => t.c === prevChoice);
    if (i >= 0) turns = turns.slice(0, i + 1);
  }
  turns.push({ c: cid, u: String(userText).slice(0, 3000), m: String(modelText).slice(0, 3000) });
  turns = turns.slice(-MAX_TURNS);
  while (turns.length > 1 && turns.reduce((n, t) => n + t.u.length + t.m.length, 0) > MAX_CHARS) turns.shift();
  all[sid] = { t: Date.now(), turns };
  saveSessions(all);
}

/* ───────────── 构造千问 SSE 响应 ───────────── */
const ev = (name, data) =>
  "event: " + name + "\ndata: " + JSON.stringify({ [name]: data, type: name }) + "\n\n";

function buildSSE(text, citations, model, extra) {
  const now = Math.floor(Date.now() / 1000);
  const sid = SESSION.sid || "sess_" + uuid();
  const rid = "resp_" + uuid().replace(/-/g, "");
  const cid = SESSION.cid || "choice_" + uuid();

  const value = makeValue(text, extra);
  const annotations = (citations || []).map((c) => ({
    type: "url_citation",
    url_citation: { index: 0, title: c.title || c.url, url: c.url },
  }));
  const content = { text: { annotations, value }, type: "text" };
  const item = { type: "message", message: { role: "assistant", content: [content] } };
  const choiceDone = { output: [item], moderation: [], id: cid, status: "completed" };
  const P = "session.response.choices[].";

  let s = "";
  s += ev("session.created", {
    expires_at: now + 600, expires_after: { seconds: 600, anchor: "last_active_at" },
    last_active_at: now, created_at: now, id: sid, object: "session",
  });
  s += ev("session.response.created", {
    notices: [], session_id: sid, created_at: now, model, id: rid, choices: [], object: "session.response",
  });
  s += ev(P + "added", { index: 0, choice: { output: [], id: cid, status: "incomplete" } });
  s += ev(P + "items[].added", {
    choice_index: 0, item: { type: "message", message: { role: "assistant", content: [] } }, index: 0,
  });
  s += ev(P + "items[].message.content[].added", {
    item_index: 0, choice_index: 0, index: 0, content: { text: { annotations: [], value: "" }, type: "text" },
  });
  for (let i = 0; i < value.length; i += 60) {
    s += ev(P + "items[].message.content[].text.value.delta", {
      item_index: 0, choice_index: 0, content_index: 0, delta: value.slice(i, i + 60),
    });
  }
  s += ev(P + "items[].message.content[].text.value.done", {
    item_index: 0, choice_index: 0, content_index: 0, value,
  });
  annotations.forEach((a, i) => {
    s += ev(P + "items[].message.content[].text.annotations[].added", {
      annotation: a, item_index: 0, choice_index: 0, content_index: 0, index: i,
    });
  });
  s += ev(P + "items[].message.content[].done", { item_index: 0, choice_index: 0, index: 0, content });
  s += ev(P + "items[].done", { choice_index: 0, item, index: 0 });
  s += ev(P + "completed", { index: 0, choice: choiceDone });
  s += ev(P + "done", { index: 0, choice: choiceDone });
  s += ev("session.response.done", {
    notices: [], session_id: sid, created_at: now + 1, model, id: rid, choices: [choiceDone], object: "session.response",
  });
  return { sid, body: s };
}

// 只允许结束一次：无论正常返回、异常还是看门狗，都在本地回复，绝不放行给千问
let finished = false;
function reply(text, citations, model, extra) {
  if (finished) return;
  finished = true;
  const r = buildSSE(text, citations, model, extra);
  $done({
    response: {
      status: 200,
      headers: { "Content-Type": "text/event-stream;charset=UTF-8", "x-session-id": r.sid },
      body: r.body,
    },
  });
}

/* ───────────── 主流程 ───────────── */
function main() {
  // 首轮: /v1/sessions/responses ；追问: /v1/sessions/{sid}/responses
  const fm = $request && /\/v1\/sessions(?:\/([^\/?]+))?\/files(?:\?|$)/.exec($request.url);
  if (fm && String($request.method).toUpperCase() === "POST") return handleUpload(fm[1]);
  const um = $request && /\/v1\/sessions(?:\/([^\/?]+))?\/responses(?:\?|$)/.exec($request.url);
  if (!um) {
    finished = true;
    // 隐私兜底：插件规则会把该域名下所有请求交给本脚本；不是对话接口的，默认本地拒绝，绝不原样发给千问
    if ($request && readArgs().STRICT) {
      const hdr = $request.headers || {};
      const hv = (n) => hdr[n] || hdr[n.toLowerCase()] || hdr[n.replace(/(^|-)(\w)/g, (m, a, c) => a + c.toUpperCase())] || "?";
      const bl = typeof $request.body === "string" ? $request.body.length : ($request.body && $request.body.byteLength) || 0;
      console.log(TAG + " blocked non-response request: " + $request.method + " " + String($request.url).replace(/^https?:\/\/[^\/]+/, "").split("?")[0] +
        " | content-type=" + String(hv("Content-Type")).split(";")[0] + ", body=" + bl);
      return $done({ response: { status: 403, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: { code: "blocked", message: "blocked by Siri to Gemini" } }) } });
    }
    return $done({});
  }
  SESSION.sid = um[1] || "sess_" + uuid();
  SESSION.cid = "choice_" + uuid();
  SESSION.follow = !!um[1];
  // 看门狗：到点还没结果，就在本地回一句提示，不让请求漏给千问
  if (typeof setTimeout === "function") {
    setTimeout(() => {
      console.log(TAG + " watchdog fired");
      reply("Gemini 响应太慢了，这次先放弃，请稍后再试。", [], "Gemini");
    }, WATCHDOG_MS);
  }
  if ($request.method !== "POST") return reply("仅支持 POST 请求。", [], "Gemini");
  const args = readArgs();
  let tag = "Gemini·" + args.MODEL;
  console.log(TAG + " script v" + VERSION + " running, model=" + args.MODEL + ", style=" + args.STYLE);

  let body;
  try { body = JSON.parse($request.body); } catch (e) { return reply("请求格式无法解析。", [], tag); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.input)) {
    return reply("请求结构不受支持。", [], tag);
  }
  // 诊断：记录是哪个功能发起的请求（如 siri.visualIntelligenceCamera），便于确认写作工具等是否也会触发
  try {
    const cfg = body.configuration || {};
    const rf = (body.response_format && body.response_format.json_schema && body.response_format.json_schema.schema) || {};
    console.log(TAG + " feature=" + (cfg.response_configuration_group_id || "?") + ", schema=" + Object.keys(rf.properties || {}).join("/") + ", tools=" + (body.client_tools || []).length + "/" + (body.server_tools || []).length);
  } catch (e) {}
  // 输出结构跟随请求里的 json_schema（写作工具是 body/refinements，不是 content/summary）
  try {
    const jsch = body.response_format && body.response_format.json_schema;
    const sch = jsch && jsch.schema;
    if (sch && sch.properties && jsch.content_property && sch.properties[jsch.content_property]) {
      OUT = { prop: jsch.content_property, props: sch.properties };
    }
  } catch (e) {}
  // Key 检查放在输出结构确定之后，这样写作工具的报错也能按 body 字段显示
  if (!args.KEY) return reply("还没有填写 Gemini API Key，请先在 Loon 插件参数里填写。", [], tag);
  const structured = extraProps().length > 0;
  SESSION.prev = body.previous_choice_id || null;
  const { contents: newContents, system, unsupported, hasImage } = toGemini(body, OUT.prop);
  // 追问：把之前的对话接在前面（追问请求本身不带历史）
  const hist = SESSION.follow ? historyContents(SESSION.sid, SESSION.prev, args.HISTORY) : [];
  if (SESSION.follow) console.log(TAG + " follow-up, history messages=" + hist.length + " (limit " + args.HISTORY + " turns), chars=" + hist.reduce((n, m) => n + m.parts[0].text.length, 0));
  // 该会话上传过的文件：放在最前面一并发给 Gemini（Gemini 无状态，每轮都要带上）
  const fileList = loadFiles(SESSION.sid);
  let fileUnsupported = null;
  const fileParts = [];
  fileList.forEach((f) => {
    if (f.b64) fileParts.push({ inlineData: { mimeType: f.mime, data: f.b64 } }, { text: "（上面是用户上传的文件：" + f.name + "）" });
    else if (f.text) fileParts.push({ text: "【用户上传的文件：" + f.name + "】\n" + f.text });
    else if (f.unsupported) fileUnsupported = f;
  });
  if (fileList.length) console.log(TAG + " files attached: " + fileList.map((f) => f.name + "(" + f.mime + ")").join(", "));
  // 相机图片：本轮带图就记下来；追问时（本轮没带图）把最近一张图接回去
  const imgParts = [];
  if (hasImage) saveImage(SESSION.sid, lastUserImage(newContents));
  else if (SESSION.follow && args.HISTORY > 0) {
    const si = loadImage(SESSION.sid);
    if (si) {
      imgParts.push({ inlineData: { mimeType: si.mime, data: si.b64 } }, { text: "（上面是用户之前发来的图片）" });
      console.log(TAG + " previous image re-attached for follow-up");
    }
  }
  const prefixParts = fileParts.concat(imgParts);
  const contents = (prefixParts.length ? [{ role: "user", parts: prefixParts }] : []).concat(hist, newContents);
  // 本轮用户输入（用于存档，不存图片本身）
  const lastUser = newContents.filter((c) => c.role === "user").slice(-1)[0];
  const userText = lastUser
    ? (lastUser.parts.some((p) => p.inlineData) ? "[用户发送了一张图片] " : "") + lastUser.parts.filter((p) => p.text).map((p) => p.text).join("\n")
    : "";
  if (unsupported) return reply("这种内容格式暂时识别不了，目前支持文字和相机图片。", [], tag);
  if (hasImage) console.log(TAG + " image request, parts=" + contents.map((c) => c.parts.length).join(","));
  if (!newContents.length) return reply("没有识别到文字内容。", [], tag);
  if (fileUnsupported && !fileParts.length) return reply("暂不支持 " + fileUnsupported.name + " 这种格式的文件，目前支持 PDF、图片、音视频和文本类文件。", [], tag);

  // 联网搜索：开 = 每次联网；自动 = 只有问题涉及实时信息时才联网（写作工具不自动联网）；关 = 不联网
  const wantSearch = args.SEARCH === "on" || (args.SEARCH === "auto" && !structured && needsSearch(userText));
  if (wantSearch && args.SEARCH === "auto") console.log(TAG + " auto search enabled for this question");
  const payload = {
    systemInstruction: { parts: [{ text: [IDENTITY, structured ? structuredPrompt() : STYLES[args.STYLE], structured ? "" : todayLine(), args.PROMPT].concat(system).filter(Boolean).join("\n") }] },
    contents,
    generationConfig: { maxOutputTokens: args.MAX || (args.STYLE === "详细" ? 4096 : 2048) },
  };
  // 按当前模型设置思考与输出长度（换模型回退时会再调用一次）
  function applyModelConfig() {
    delete payload.generationConfig.thinkingConfig;
    payload.generationConfig.maxOutputTokens = args.MAX || (args.STYLE === "详细" ? 4096 : 2048);
    // 快速模式：关闭/压低思考（仅 flash 系列支持；pro 无法关闭）
    if (args.FAST && /flash/i.test(args.MODEL) && !/pro/i.test(args.MODEL)) {
      payload.generationConfig.thinkingConfig = (+((/gemini-(\d+)/i.exec(args.MODEL) || [])[1]) >= 3 || /-latest$/i.test(args.MODEL))
        ? { thinkingLevel: "minimal" }   // 3 及以上用 thinkingLevel
        : { thinkingBudget: 0 };         // 2.5 用 thinkingBudget
    } else {
      // 思考会占用输出额度，放宽以免正文被截空
      payload.generationConfig.maxOutputTokens = Math.max(args.MAX, args.STYLE === "详细" ? 8192 : 4096);
    }
    if (structured) payload.generationConfig.maxOutputTokens = Math.max(payload.generationConfig.maxOutputTokens, 4096);
  }
  applyModelConfig();
  if (structured) {
    payload.generationConfig.responseMimeType = "application/json";
    payload.generationConfig.responseSchema = structuredSchema();
    console.log(TAG + " structured output: " + [OUT.prop].concat(extraProps()).join("/") + (wantSearch ? " + google_search" : ""));
  }
  // 联网搜索：Gemini 3 系列支持「结构化输出 + Google Search」同时使用；不支持的模型会返回 400，下面会自动去掉搜索重试
  let searchSkipped = false;
  if (wantSearch) {
    if (searchCooling()) { searchSkipped = true; console.log(TAG + " search quota recently exhausted, skipping google_search"); }
    else payload.tools = [{ google_search: {} }];
  }

  let url = args.BASE + "/v1beta/models/" + encodeURIComponent(args.MODEL) + ":generateContent";
  const startAt = Date.now();
  const remaining = () => BUDGET_MS - (Date.now() - startAt);
  let retried5xx = false;
  let retriedNoThink = false;
  let retriedNet = false;
  let retriedNoTools = false;
  let retriedModel = false;
  function attempt() {
    if (finished) return; // 看门狗已经回复过了，不再发请求
    const opts = {
      url,
      headers: { "Content-Type": "application/json", "x-goog-api-key": args.KEY },
      body: JSON.stringify(payload),
      timeout: Math.max(5000, Math.min(ATTEMPT_MS, remaining() - 2000)),
    };
    console.log(TAG + " POST via Loon config rules, timeout=" + opts.timeout + "ms");

    $httpClient.post(opts, (err, resp, data) => {
      if (err) {
        console.log(TAG + " Gemini request failed: " + err);
        // 网络错误/超时：时间够就重试一次
        if (!retriedNet && remaining() > RETRY_MIN_MS) { retriedNet = true; return attempt(); }
        return reply("连接 Gemini 失败，请检查网络或代理设置。", [], tag);
      }
      try { handle(resp, data); } catch (e) {
        console.log(TAG + " handle error: " + (e && e.stack || e));
        reply("处理 Gemini 回复时出错了，请稍后再试。", [], tag);
      }
    });
  }

  function handle(resp, data) {
    const status = resp && resp.status;
    let j;
    try { j = JSON.parse(data); } catch (e) {
      console.log(TAG + " bad body (HTTP " + status + "): " + String(data).slice(0, 200));
      if (status === 413) return reply("文件或对话内容太大，处理不了。请开始一个新对话，或换小一点的文件。", [], tag);
      return reply("Gemini 返回了无法解析的内容。", [], tag);
    }
    if (j.error) {
      const msg = j.error.message || "";
      console.log(TAG + " api error " + status + ": " + msg);
      // 模型不存在或对当前 Key 不可用（如 2.5 系列不再对新用户开放）：自动改用默认模型重试一次
      if ((status === 404 || /no longer available/i.test(msg)) && args.MODEL !== DEFAULTS.MODEL && !retriedModel) {
        retriedModel = true;
        console.log(TAG + " model " + args.MODEL + " unavailable (" + status + "), falling back to " + DEFAULTS.MODEL);
        args.MODEL = DEFAULTS.MODEL;
        tag = "Gemini·" + args.MODEL;
        url = args.BASE + "/v1beta/models/" + encodeURIComponent(args.MODEL) + ":generateContent";
        applyModelConfig();
        return attempt();
      }
      // 个别模型不支持关闭思考：去掉后重试一次
      if (status === 400 && /think/i.test(msg) && !retriedNoThink && payload.generationConfig.thinkingConfig) {
        retriedNoThink = true;
        delete payload.generationConfig.thinkingConfig;
        return attempt();
      }
      // 搜索额度用完（429）：去掉搜索立即重试，并暂停带搜索一段时间
      if (status === 429 && payload.tools && !retriedNoTools) {
        retriedNoTools = true;
        searchSkipped = true;
        store(SEARCH_OFF_KEY, String(Date.now() + SEARCH_COOLDOWN));
        console.log(TAG + " 429 with google_search (grounding quota exhausted?), retrying without search; search paused 15min");
        delete payload.tools;
        return attempt();
      }
      // 结构化输出与搜索不能同时用（非 Gemini 3 系列）：去掉搜索重试一次
      if (status === 400 && structured && payload.tools && !retriedNoTools) {
        retriedNoTools = true;
        console.log(TAG + " model does not support search + structured output, retrying without search");
        delete payload.tools;
        return attempt();
      }
      // 临时性错误：重试一次
      if ((status === 429 || status >= 500) && !retried5xx) {
        const wait = status === 429 ? (retryDelayMs(j) || 1000) : 0;
        if (wait > MAX_WAIT_MS) return reply("Gemini 限流了，请约 " + Math.ceil(wait / 1000) + " 秒后再试。", [], tag);
        if (remaining() > wait + RETRY_MIN_MS) {
          retried5xx = true;
          if (wait > 0 && typeof setTimeout === "function") {
            console.log(TAG + " retrying in " + wait + "ms");
            return setTimeout(attempt, wait);
          }
          return attempt();
        }
      }
      let hint = "Gemini 出错了（" + status + "），请稍后再试。";
      if (status === 429) hint = retryDelayMs(j) ? "Gemini 限流了，请约 " + Math.ceil(retryDelayMs(j) / 1000) + " 秒后再试。" : "Gemini 的额度用完了或请求太频繁，请稍后再试。";
      else if (status === 404) hint = "找不到这个模型，可能已下线，请在插件里换一个模型。";
      else if (/location is not supported/i.test(msg)) hint = "当前网络地区不支持 Gemini，请检查代理节点。";
      else if (status === 401 || status === 403 || /API key/i.test(msg)) hint = "API Key 无效或没有权限，请检查插件里的 Key。";
      else if (status === 413 || (status === 400 && /too large|exceed|payload|request size|maximum number of tokens|token count/i.test(msg))) hint = "文件或对话内容太大，处理不了。请开始一个新对话，或换小一点的文件。";
      else if (status === 400 && /mime|unsupported|not supported|invalid.*(file|media|data)|could not process/i.test(msg)) hint = "Gemini 不支持这种文件或内容格式，请换个格式再试。";
      else if (status === 503 || /overloaded|unavailable/i.test(msg)) hint = "Gemini 现在比较繁忙，请稍后再试。";
      else if (status === 400) hint = "Gemini 拒绝了这次请求（400），可能是文件、模型或参数不被支持。";
      else if (status >= 500) hint = "Gemini 服务暂时出问题了，请稍后再试。";
      return reply(hint, [], tag);
    }

    const cand = (j.candidates || [])[0] || {};
    let rawText = ((cand.content && cand.content.parts) || [])
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    let extra = null;
    if (structured && rawText) {
      try {
        const jo = JSON.parse(rawText.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
        extra = {};
        extraProps().forEach((k) => {
          const v = jo[k];
          const ty = pickType(OUT.props[k] && OUT.props[k].type);
          if (ty === "array") extra[k] = Array.isArray(v) ? v.map((x) => stripMd(String(x))).filter(Boolean).slice(0, 6) : [];
          else if (typeof v === "string") extra[k] = stripMd(v);
        });
        rawText = typeof jo[OUT.prop] === "string" ? jo[OUT.prop] : rawText;
      } catch (e) {
        console.log(TAG + " structured parse failed, using raw text");
      }
    }
    const text = stripMd(rawText);
    if (!text) {
      if (cand.finishReason === "MAX_TOKENS") return reply("这个问题思考过久没来得及回答，请换个问法，或在插件里开启快速模式。", [], tag);
      const why = (j.promptFeedback && j.promptFeedback.blockReason) || cand.finishReason || "空回复";
      return reply(BLOCK_TEXT[why] || ("Gemini 没有给出回答（" + why + "），请再试一次。"), [], tag);
    }
    const seen = {};
    const cites = (((cand.groundingMetadata || {}).groundingChunks) || [])
      .map((c) => c.web)
      .filter((w) => w && w.uri && !seen[w.uri] && (seen[w.uri] = 1))
      .slice(0, 5)
      .map((w) => ({ url: w.uri, title: w.title }));
    const um = j.usageMetadata || {};
    console.log(TAG + " Gemini response received (HTTP " + status + ", " + (Date.now() - startAt) + "ms), tokens: input=" + (um.promptTokenCount || "?") + ", cached=" + (um.cachedContentTokenCount || 0) + ", thinking=" + (um.thoughtsTokenCount || 0) + ", output=" + (um.candidatesTokenCount || "?"));
    try { recordTurn(SESSION.sid, SESSION.cid, SESSION.prev, userText, text); } catch (e) { console.log(TAG + " record turn failed: " + e); }
    // 搜索被跳过（额度不足）时，在普通回答末尾提示一句；写作工具的正文保持干净，只写日志
    reply(searchSkipped && !structured ? text + SEARCH_NOTE : text, cites, tag, extra);
  }

  attempt();
}

// 任何未捕获异常都在本地回复，不放行原请求
try { main(); } catch (e) {
  console.log(TAG + " fatal: " + (e && e.stack || e));
  reply("脚本出错了，已拦下这次请求，没有发给千问。", [], "Gemini");
}
