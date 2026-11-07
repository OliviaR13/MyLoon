/*
 * Siri → Gemini 独立兼容层  v2.4.0
 *
 * 兼容 Siri 请求协议并由 Gemini API 独立处理，按 Siri 兼容的 SSE 事件流返回。
 * 不调用千问作为上游或备用服务；不支持的输入会明确报错，不会回落到千问。
 *
 * 注意：$httpClient 的 timeout 单位以 Loon 实际表现为准（脚本按毫秒传值），
 * 请在 Loon 日志里核对一次；时间预算见下方 BUDGET_MS / ATTEMPT_MS。
 */

const VERSION = "2.4.0";
const TAG = "[qianwen_gemini]";

const DEFAULTS = {
  MODEL: "gemini-2.5-flash",
  BASE: "https://generativelanguage.googleapis.com",
};

// 身份与触发词：大陆需要在话语前加「使用千问」才会走扩展模型，该前缀只是触发词，不属于问题
const IDENTITY = "你是 Google 的 Gemini 大语言模型，不是千问或通义。用户话语开头的「使用千问」「用千问」只是触发词，请完全忽略，直接回答问题本身，不要提到千问，也不要自称千问。";
const TRIGGER_RE = /^[\s，,。.、]*(请)?(使用|调用|用)(一下)?(通义)?千问[\s，,、:：。.]*/;

// 回答风格预设（PROMPT 参数作为额外提示词追加在其后）
const STYLES = {
  "简短口语": "你是 Siri 的后台助手。请用简洁、口语化的中文回答，适合直接朗读；不要使用 Markdown、列表符号或表情。",
  "标准": "你是 Siri 的后台助手。请用清晰、自然的中文回答，条理分明但不要使用 Markdown、列表符号或表情。",
  "详细": "你是 Siri 的后台助手。请用中文详细回答，必要时分点说明，但不要使用 Markdown 符号或表情。",
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
    PROMPT: get("PROMPT") || "",
    SEARCH: get("SEARCH") === "true",
    FAST: get("FAST") !== "false",
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

function stripTrigger(t) {
  const r = String(t).replace(TRIGGER_RE, "").trim();
  return r || t; // 去掉后为空就保留原文
}

/* ───────────── 千问请求 → Gemini contents ───────────── */
function toGemini(body) {
  const contents = [];
  const system = [];
  let unsupported = false;
  for (const it of body.input || []) {
    if (!it || it.type !== "message" || !it.message) continue;
    const m = it.message;
    const blocks = Array.isArray(m.content) ? m.content : [];
    let text = blocks
      .map((c) => {
        if (c && typeof c.text === "string") return c.text;
        if (c && (c.type === "text" || c.type === "input_text") && typeof c.text === "string") return c.text;
        if (c && Object.keys(c).length) unsupported = true;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") {
      // 请求里自带的系统提示若设定成千问人设，会盖过我们的提示，去掉含千问/通义的行
      const kept = text.split("\n").filter((l) => !/千问|通义|Qwen/i.test(l)).join("\n").trim();
      if (kept) system.push(kept);
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    if (role === "user") text = stripTrigger(text);
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  return { contents, system, unsupported };
}

/* ───────────── 构造千问 SSE 响应 ───────────── */
const ev = (name, data) =>
  "event: " + name + "\ndata: " + JSON.stringify({ [name]: data, type: name }) + "\n\n";

function buildSSE(text, citations, model) {
  const now = Math.floor(Date.now() / 1000);
  const sid = "sess_" + uuid();
  const rid = "resp_" + uuid().replace(/-/g, "");
  const cid = "choice_" + uuid();

  const value = JSON.stringify({ content: text, summary: summarize(text), isRequestingUserInput: false });
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
function reply(text, citations, model) {
  if (finished) return;
  finished = true;
  const r = buildSSE(text, citations, model);
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
  if (!$request || !/\/v1\/sessions\/responses/.test($request.url)) { finished = true; return $done({}); }
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

  if (!args.KEY) return reply("还没有填写 Gemini API Key，请先在 Loon 插件参数里填写。", [], tag);

  let body;
  try { body = JSON.parse($request.body); } catch (e) { return reply("请求格式无法解析。", [], tag); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.input)) {
    return reply("请求结构不受支持。", [], tag);
  }
  const { contents, system, unsupported } = toGemini(body);
  if (unsupported) return reply("目前只支持文字输入，暂不支持图片。", [], tag);
  if (!contents.length) return reply("没有识别到文字内容。", [], tag);

  const payload = {
    systemInstruction: { parts: [{ text: [IDENTITY, STYLES[args.STYLE], args.PROMPT].concat(system).filter(Boolean).join("\n") }] },
    contents,
    generationConfig: { maxOutputTokens: args.STYLE === "详细" ? 4096 : 2048 },
  };
  // 快速模式：关闭/压低思考（仅 flash 系列支持；pro 无法关闭）
  if (args.FAST && /flash/i.test(args.MODEL) && !/pro/i.test(args.MODEL)) {
    payload.generationConfig.thinkingConfig = /gemini-3/i.test(args.MODEL)
      ? { thinkingLevel: "minimal" }   // 3.x 用 thinkingLevel
      : { thinkingBudget: 0 };         // 2.5 用 thinkingBudget
  } else {
    // 思考会占用输出额度，放宽以免正文被截空
    payload.generationConfig.maxOutputTokens = args.STYLE === "详细" ? 8192 : 4096;
  }
  if (args.SEARCH) payload.tools = [{ google_search: {} }];

  const url = args.BASE + "/v1beta/models/" + encodeURIComponent(args.MODEL) + ":generateContent";
  const startAt = Date.now();
  const remaining = () => BUDGET_MS - (Date.now() - startAt);
  let retried5xx = false;
  let retriedNoThink = false;
  let retriedNet = false;
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
      // 临时性错误：重试一次
      if ((status === 429 || status >= 500) && !retried5xx && remaining() > RETRY_MIN_MS) { retried5xx = true; return attempt(); }
      return reply("Gemini 出错了（" + status + "），请稍后再试。", [], tag);
    }

    const cand = (j.candidates || [])[0] || {};
    const text = stripMd(
      ((cand.content && cand.content.parts) || [])
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("")
    );
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
    reply(text, cites, tag);
  }

  attempt();
}

// 任何未捕获异常都在本地回复，不放行原请求
try { main(); } catch (e) {
  console.log(TAG + " fatal: " + (e && e.stack || e));
  reply("脚本出错了，已拦下这次请求，没有发给千问。", [], "Gemini");
}
