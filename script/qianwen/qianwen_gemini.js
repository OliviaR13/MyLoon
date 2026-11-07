/*
 * Qianwen → Gemini (Loon http-request script)
 * 拦截 Siri 发往千问 (prod-yabuli.qianwen.com/v1/sessions/responses) 的请求，
 * 改由 Gemini API 回答，并按千问的 SSE 事件流格式回给 Siri。
 *
 * 参数（在插件里填写）：KEY / MODEL / SEARCH / PROMPT / BASE / POLICY
 */

const DEFAULTS = {
  MODEL: "gemini-2.5-flash",
  BASE: "https://generativelanguage.googleapis.com",
  PROMPT:
    "你是 Siri 的后台助手。请用简洁、口语化的中文回答，适合直接朗读；不要使用 Markdown、列表符号或表情。",
};

/* ---------- 参数 ---------- */
function readArgs() {
  let a = typeof $argument === "undefined" ? {} : $argument;
  if (typeof a === "string") {
    try { a = JSON.parse(a); } catch (e) { a = {}; }
  }
  const clean = (v) => {
    if (v === undefined || v === null) return "";
    v = String(v).trim();
    return /^\{.*\}$/.test(v) || v === "null" ? "" : v; // 未替换的占位符视为空
  };
  return {
    KEY: clean(a.KEY),
    MODEL: clean(a.MODEL) || DEFAULTS.MODEL,
    SEARCH: clean(a.SEARCH) === "true",
    PROMPT: clean(a.PROMPT) || DEFAULTS.PROMPT,
    BASE: (clean(a.BASE) || DEFAULTS.BASE).replace(/\/+$/, ""),
    POLICY: clean(a.POLICY),
  };
}

/* ---------- 工具 ---------- */
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });

function ev(name, data) {
  return "event: " + name + "\ndata: " + JSON.stringify({ [name]: data, type: name }) + "\n\n";
}

function summarize(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  const first = t.split(/[。！？!?\n]/)[0] || t;
  return first.length > 20 ? first.slice(0, 20) + "…" : first;
}

/* ---------- 千问请求 → Gemini contents ---------- */
function toGeminiContents(body) {
  const out = [];
  const sys = [];
  for (const it of body.input || []) {
    if (!it || it.type !== "message" || !it.message) continue;
    const m = it.message;
    const text = (Array.isArray(m.content) ? m.content : [])
      .map((c) => (c && typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") { sys.push(text); continue; }
    const role = m.role === "assistant" ? "model" : "user";
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push({ text });
    else out.push({ role, parts: [{ text }] });
  }
  return { contents: out, system: sys };
}

/* ---------- 构造 SSE ---------- */
function buildSSE(text, citations, model) {
  const now = Math.floor(Date.now() / 1000);
  const sid = "sess_" + uuid();
  const rid = "resp_" + uuid().replace(/-/g, "");
  const cid = "choice_" + uuid();

  const value = JSON.stringify({
    content: text,
    summary: summarize(text),
    isRequestingUserInput: false,
  });
  const annotations = (citations || []).map((c) => ({
    type: "url_citation",
    url_citation: { index: 0, title: c.title || c.url, url: c.url },
  }));
  const content = { text: { annotations, value }, type: "text" };
  const item = { type: "message", message: { role: "assistant", content: [content] } };
  const choiceDone = { output: [item], moderation: [], id: cid, status: "completed" };

  let s = "";
  s += ev("session.created", {
    expires_at: now + 600, expires_after: { seconds: 600, anchor: "last_active_at" },
    last_active_at: now, created_at: now, id: sid, object: "session",
  });
  s += ev("session.response.created", {
    notices: [], session_id: sid, created_at: now, model: model, id: rid, choices: [], object: "session.response",
  });
  s += ev("session.response.choices[].added", { index: 0, choice: { output: [], id: cid, status: "incomplete" } });
  s += ev("session.response.choices[].items[].added", {
    choice_index: 0, item: { type: "message", message: { role: "assistant", content: [] } }, index: 0,
  });
  s += ev("session.response.choices[].items[].message.content[].added", {
    item_index: 0, choice_index: 0, index: 0, content: { text: { annotations: [], value: "" }, type: "text" },
  });
  for (let i = 0; i < value.length; i += 60) {
    s += ev("session.response.choices[].items[].message.content[].text.value.delta", {
      item_index: 0, choice_index: 0, content_index: 0, delta: value.slice(i, i + 60),
    });
  }
  s += ev("session.response.choices[].items[].message.content[].text.value.done", {
    item_index: 0, choice_index: 0, content_index: 0, value,
  });
  annotations.forEach((a, i) => {
    s += ev("session.response.choices[].items[].message.content[].text.annotations[].added", {
      annotation: a, item_index: 0, choice_index: 0, content_index: 0, index: i,
    });
  });
  s += ev("session.response.choices[].items[].message.content[].done", {
    item_index: 0, choice_index: 0, index: 0, content,
  });
  s += ev("session.response.choices[].items[].done", { choice_index: 0, item, index: 0 });
  s += ev("session.response.choices[].completed", { index: 0, choice: choiceDone });
  s += ev("session.response.choices[].done", { index: 0, choice: choiceDone });
  s += ev("session.response.done", {
    notices: [], session_id: sid, created_at: now + 1, model: model, id: rid, choices: [choiceDone], object: "session.response",
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

/* ---------- 主流程 ---------- */
(function main() {
  if (!$request || $request.method !== "POST" || !/\/v1\/sessions\/responses/.test($request.url)) {
    return $done({});
  }
  const args = readArgs();
  const tag = "Gemini·" + args.MODEL;

  if (!args.KEY) return reply("还没有填写 Gemini API Key，请先在 Loon 插件参数里填写。", [], tag);

  let body;
  try { body = JSON.parse($request.body); } catch (e) { return $done({}); }

  const { contents, system } = toGeminiContents(body);
  if (!contents.length) return $done({}); // 不认识的请求，放行给千问

  const payload = {
    systemInstruction: { parts: [{ text: [args.PROMPT].concat(system).join("\n") }] },
    contents,
  };
  if (args.SEARCH) payload.tools = [{ google_search: {} }];

  const opts = {
    url: args.BASE + "/v1beta/models/" + encodeURIComponent(args.MODEL) + ":generateContent",
    headers: { "Content-Type": "application/json", "x-goog-api-key": args.KEY },
    body: JSON.stringify(payload),
    timeout: 50,
  };
  if (args.POLICY) opts.node = args.POLICY; // 强制该请求走指定策略/节点

  $httpClient.post(
    opts,
    (err, resp, data) => {
      if (err) {
        console.log("[qianwen_gemini] request error: " + err);
        return reply("连接 Gemini 失败，请检查 Gemini 域名是否走代理（插件参数「代理策略」）。详情：" + String(err).slice(0, 200), [], tag);
      }
      let j;
      try { j = JSON.parse(data); } catch (e) { return reply("Gemini 返回了无法解析的内容（HTTP " + (resp && resp.status) + "）。", [], tag); }
      if (j.error) return reply("Gemini 出错：" + (j.error.message || "").slice(0, 120), [], tag);

      const cand = (j.candidates || [])[0] || {};
      const text = ((cand.content && cand.content.parts) || [])
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("")
        .trim();
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
      reply(text, cites, tag);
    }
  );
})();
