/*
 * Siri → Gemini 独立兼容层  v2.8.3
 *
 * 兼容 Siri 请求协议并由 Gemini API 独立处理，按 Siri 兼容的 SSE 事件流返回。
 * 不调用千问作为上游或备用服务；不支持的输入会明确报错，不会回落到千问。
 *
 * 注意：$httpClient 的 timeout 单位以 Loon 实际表现为准（脚本按毫秒传值），
 * 请在 Loon 日志里核对一次；时间预算见下方 BUDGET_MS / ATTEMPT_MS。
 */

const VERSION = "2.8.3";
const TAG = "[qianwen_gemini]";

const DEFAULTS = {
  MODEL: "gemini-2.5-flash",
  BASE: "https://generativelanguage.googleapis.com",
};

// 身份与触发词：大陆需要在话语前加「使用千问」才会走扩展模型，该前缀只是触发词，不属于问题
const IDENTITY = "你是 Google 的 Gemini 大语言模型，不是千问或通义。用户话语开头的「使用千问」「用千问」只是触发词，请完全忽略，直接回答问题本身，不要提到千问，也不要自称千问。";
// 视觉智能（相机）只发图片、没有文字时使用的默认问题
const IMAGE_ONLY_PROMPT = "请识别并简要说明图片里是什么；如果有文字，请读出重点；如果是商品、植物、动物或地点，请说出名称和关键信息。";
const TRIGGER_RE = /^[\s，,。.、]*(请)?(使用|调用|用)(一下)?(通义)?千问[\s，,、:：。.]*/;

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

/* ───────────── 参数 ───────────── */
function readArgs() {
  let a = typeof $argument === "undefined" ? {} : $argument;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch (e) { a = {}; } }
  const isPlaceholder = (v) => /^\{.*\}$/.test(v);
  const get = (k) => {
    const v = a[k];
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
    SEARCH: get("SEARCH") === "true",
    FAST: get("FAST") !== "false",
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
  const r = String(t).replace(TRIGGER_RE, "").trim();
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
      const t2 = String(text).replace(TRIGGER_RE, "").trim() || IMAGE_ONLY_PROMPT; // 只剩触发词时也按“看图”处理
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

/* ───────────── 连续对话：会话历史（$persistentStore） ─────────────
 * 追问请求发往 /v1/sessions/{sid}/responses，且只带新一句话 + previous_choice_id，
 * 没有历史。所以首轮回复里用的 sess_/choice_ 由脚本生成并记下对话，追问时取回。 */
const STORE_KEY = "siri_gemini_sessions";
const SESS_TTL = 3600 * 1000;   // 会话保留 1 小时
const MAX_SESS = 12;            // 最多保留的会话数
const MAX_TURNS = 20;           // 每个会话最多保留的轮数
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
function historyContents(sid, prevChoice) {
  const sess = loadSessions()[sid];
  if (!sess || !Array.isArray(sess.turns)) return [];
  let turns = sess.turns;
  if (prevChoice) {
    const i = turns.findIndex((t) => t.c === prevChoice);
    if (i >= 0) turns = turns.slice(0, i + 1);
  }
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
  turns.push({ c: cid, u: String(userText).slice(0, 8000), m: String(modelText).slice(0, 8000) });
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
  const tag = "Gemini·" + args.MODEL;
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
  const hist = SESSION.follow ? historyContents(SESSION.sid, SESSION.prev) : [];
  if (SESSION.follow) console.log(TAG + " follow-up, history messages=" + hist.length);
  const contents = hist.concat(newContents);
  // 本轮用户输入（用于存档，不存图片本身）
  const lastUser = newContents.filter((c) => c.role === "user").slice(-1)[0];
  const userText = lastUser
    ? (lastUser.parts.some((p) => p.inlineData) ? "[用户发送了一张图片] " : "") + lastUser.parts.filter((p) => p.text).map((p) => p.text).join("\n")
    : "";
  if (unsupported) return reply("这种内容格式暂时识别不了，目前支持文字和相机图片。", [], tag);
  if (hasImage) console.log(TAG + " image request, parts=" + contents.map((c) => c.parts.length).join(","));
  if (!newContents.length) return reply("没有识别到文字内容。", [], tag);

  const payload = {
    systemInstruction: { parts: [{ text: [IDENTITY, structured ? structuredPrompt() : STYLES[args.STYLE], args.PROMPT].concat(system).filter(Boolean).join("\n") }] },
    contents,
    generationConfig: { maxOutputTokens: args.STYLE === "详细" ? 4096 : 2048 },
  };
  // 快速模式：关闭/压低思考（仅 flash 系列支持；pro 无法关闭）
  if (args.FAST && /flash/i.test(args.MODEL) && !/pro/i.test(args.MODEL)) {
    payload.generationConfig.thinkingConfig = (+((/gemini-(\d+)/i.exec(args.MODEL) || [])[1]) >= 3 || /-latest$/i.test(args.MODEL))
      ? { thinkingLevel: "minimal" }   // 3 及以上用 thinkingLevel
      : { thinkingBudget: 0 };         // 2.5 用 thinkingBudget
  } else {
    // 思考会占用输出额度，放宽以免正文被截空
    payload.generationConfig.maxOutputTokens = args.STYLE === "详细" ? 8192 : 4096;
  }
  if (structured) {
    payload.generationConfig.responseMimeType = "application/json";
    payload.generationConfig.responseSchema = structuredSchema();
    payload.generationConfig.maxOutputTokens = Math.max(payload.generationConfig.maxOutputTokens, 4096);
    console.log(TAG + " structured output: " + [OUT.prop].concat(extraProps()).join("/") + (args.SEARCH ? " + google_search" : ""));
  }
  // 联网搜索：Gemini 3 系列支持「结构化输出 + Google Search」同时使用；不支持的模型会返回 400，下面会自动去掉搜索重试
  if (args.SEARCH) payload.tools = [{ google_search: {} }];

  const url = args.BASE + "/v1beta/models/" + encodeURIComponent(args.MODEL) + ":generateContent";
  const startAt = Date.now();
  const remaining = () => BUDGET_MS - (Date.now() - startAt);
  let retried5xx = false;
  let retriedNoThink = false;
  let retriedNet = false;
  let retriedNoTools = false;
  function attempt() {
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
      return reply("Gemini 返回了无法解析的内容。", [], tag);
    }
    if (j.error) {
      const msg = j.error.message || "";
      console.log(TAG + " api error " + status + ": " + msg);
      // 个别模型不支持关闭思考：去掉后重试一次
      if (status === 400 && /think/i.test(msg) && !retriedNoThink && payload.generationConfig.thinkingConfig) {
        retriedNoThink = true;
        delete payload.generationConfig.thinkingConfig;
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
      if ((status === 429 || status >= 500) && !retried5xx && remaining() > RETRY_MIN_MS) { retried5xx = true; return attempt(); }
      return reply("Gemini 出错了（" + status + "），请稍后再试。", [], tag);
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
      return reply("Gemini 没有给出回答（" + why + "）。", [], tag);
    }
    const seen = {};
    const cites = (((cand.groundingMetadata || {}).groundingChunks) || [])
      .map((c) => c.web)
      .filter((w) => w && w.uri && !seen[w.uri] && (seen[w.uri] = 1))
      .slice(0, 5)
      .map((w) => ({ url: w.uri, title: w.title }));
    console.log(TAG + " Gemini response received (HTTP " + status + ")");
    try { recordTurn(SESSION.sid, SESSION.cid, SESSION.prev, userText, text); } catch (e) { console.log(TAG + " record turn failed: " + e); }
    reply(text, cites, tag, extra);
  }

  attempt();
}

// 任何未捕获异常都在本地回复，不放行原请求
try { main(); } catch (e) {
  console.log(TAG + " fatal: " + (e && e.stack || e));
  reply("脚本出错了，已拦下这次请求，没有发给千问。", [], "Gemini");
}
