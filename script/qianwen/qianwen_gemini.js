/*
 * Siri → Gemini 独立兼容层  v2.1.0
 *
 * 兼容 Siri 请求协议并由 Gemini API 独立处理，按 Siri 兼容的 SSE 事件流返回。
 * 不调用千问作为上游或备用服务；不支持的输入会明确报错，不会回落到千问。
 *
 * 重要：Loon 的 $httpClient timeout 单位是【毫秒】。
 * 之前的版本写成了 30/40/50（被当成 30~50 毫秒），所以请求永远“超时”。
 */

const VERSION = "2.1.0";
const TAG = "[qianwen_gemini]";

const DEFAULTS = {
  MODEL: "gemini-2.5-flash",
  BASE: "https://generativelanguage.googleapis.com",
  PROMPT: "你是 Siri 的后台助手。请用简洁、口语化的中文回答，适合直接朗读；不要使用 Markdown、列表符号或表情。",
};

// 请求超时（毫秒）；网络分流完全交给 Loon 当前配置规则

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
  return {
    KEY: get("KEY") || "",
    MODEL: get("MODEL") || DEFAULTS.MODEL,
    BASE: (get("BASE") || DEFAULTS.BASE).replace(/\/+$/, ""),
    PROMPT: get("PROMPT") || DEFAULTS.PROMPT,
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

/* ───────────── 千问请求 → Gemini contents ───────────── */
function toGemini(body) {
  const contents = [];
  const system = [];
  let unsupported = false;
  for (const it of body.input || []) {
    if (!it || it.type !== "message" || !it.message) continue;
    const m = it.message;
    const blocks = Array.isArray(m.content) ? m.content : [];
    const text = blocks
      .map((c) => {
        if (c && typeof c.text === "string") return c.text;
        if (c && (c.type === "text" || c.type === "input_text") && typeof c.text === "string") return c.text;
        if (c && Object.keys(c).length) unsupported = true;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") { system.push(text); continue; }
    const role = m.role === "assistant" ? "model" : "user";
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

function reply(text, citations, model) {
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
(function main() {
  if (!$request || $request.method !== "POST" || !/\/v1\/sessions\/responses/.test($request.url)) {
    return $done({});
  }
  const args = readArgs();
  const tag = "Gemini·" + args.MODEL;
  console.log(TAG + " script v" + VERSION + " running, model=" + args.MODEL);

  if (!args.KEY) return reply("还没有填写 Gemini API Key，请先在 Loon 插件参数里填写。", [], tag);

  let body;
  try { body = JSON.parse($request.body); } catch (e) { return reply("Siri 请求格式无法解析，已停止处理，未转发给千问。", [], tag); }
  const { contents, system } = toGemini(body);
  if (unsupported) return reply("当前版本只支持文本输入；图片或其他多模态内容尚未接入 Gemini，请勿将此版本视为多模态兼容。", [], tag);
  if (!contents.length) return reply("无法识别 Siri 请求中的文本内容，已停止处理，未转发给千问。", [], tag);

  const payload = {
    systemInstruction: { parts: [{ text: [args.PROMPT].concat(system).join("\n") }] },
    contents,
    generationConfig: { maxOutputTokens: 2048 },
  };
  // 快速模式：关闭思考（仅 flash 系列支持；pro 无法关闭）
  if (args.FAST && /flash/i.test(args.MODEL) && !/pro/i.test(args.MODEL)) {
    payload.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  if (args.SEARCH) payload.tools = [{ google_search: {} }];

  const url = args.BASE + "/v1beta/models/" + encodeURIComponent(args.MODEL) + ":generateContent";
  let retried5xx = false;
  let retriedNoThink = false;
  function attempt() {
    const opts = {
      url,
      headers: { "Content-Type": "application/json", "x-goog-api-key": args.KEY },
      body: JSON.stringify(payload),
      timeout: 45000,
    };
    console.log(TAG + " POST via Loon config rules, timeout=" + opts.timeout + "ms");

    $httpClient.post(opts, (err, resp, data) => {
      if (err) {
        console.log(TAG + " Gemini request failed: " + err);
        return reply("连接 Gemini 失败，请检查 Loon 当前配置规则及网络连通性。（脚本 v" + VERSION + "）", [], tag);
      }
      handle(resp, data);
    });
  }

  function handle(resp, data) {
    const status = resp && resp.status;
    let j;
    try { j = JSON.parse(data); } catch (e) {
      console.log(TAG + " bad body (HTTP " + status + "): " + String(data).slice(0, 200));
      return reply("Gemini 返回了无法解析的内容（HTTP " + status + "）。", [], tag);
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
      if ((status === 429 || status >= 500) && !retried5xx) { retried5xx = true; return attempt(); }
      return reply("Gemini 出错（" + status + "）：" + msg.slice(0, 120), [], tag);
    }

    const cand = (j.candidates || [])[0] || {};
    const text = stripMd(
      ((cand.content && cand.content.parts) || [])
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("")
    );
    if (!text) {
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
})();
