/*
 * 千问 → Gemini（Siri）  v2.0.0
 *
 * 拦截 Siri 发往千问的请求 (prod-yabuli.qianwen.com/v1/sessions/responses)，
 * 改由 Gemini API 回答，并按千问的 SSE 事件流格式回给 Siri。
 *
 * 重要：Loon 的 $httpClient timeout 单位是【毫秒】。
 * 之前的版本写成了 30/40/50（被当成 30~50 毫秒），所以请求永远“超时”。
 */

const VERSION = "2.0.0";
const TAG = "[qianwen_gemini]";

const DEFAULTS = {
  MODEL: "gemini-2.5-flash",
  BASE: "https://generativelanguage.googleapis.com",
  BACKUP: "日本时延优选,日本手动策略",
  PROMPT: "你是 Siri 的后台助手。请用简洁、口语化的中文回答，适合直接朗读；不要使用 Markdown、列表符号或表情。",
};

// 时间预算（毫秒）
const BUDGET_MS = 55000;      // 整个脚本最多用这么久（插件里脚本 timeout=60 秒）
const FIRST_TRY_MS = 15000;   // 第一次（按 Loon 配置规则）
const BACKUP_TRY_MS = 20000;  // 每个备用策略

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
  const backupRaw = get("BACKUP");
  return {
    KEY: get("KEY") || "",
    MODEL: get("MODEL") || DEFAULTS.MODEL,
    BASE: (get("BASE") || DEFAULTS.BASE).replace(/\/+$/, ""),
    PROMPT: get("PROMPT") || DEFAULTS.PROMPT,
    SEARCH: get("SEARCH") === "true",
    FAST: get("FAST") !== "false",
    BACKUP: (backupRaw === undefined ? DEFAULTS.BACKUP : backupRaw)
      .split(/[,，]/).map((x) => x.trim()).filter(Boolean),
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
  for (const it of body.input || []) {
    if (!it || it.type !== "message" || !it.message) continue;
    const m = it.message;
    const text = (Array.isArray(m.content) ? m.content : [])
      .map((c) => (c && typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    if (!text) continue;
    if (m.role === "system" || m.role === "developer") { system.push(text); continue; }
    const role = m.role === "assistant" ? "model" : "user";
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push({ text });
    else contents.push({ role, parts: [{ text }] });
  }
  return { contents, system };
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
  try { body = JSON.parse($request.body); } catch (e) { return $done({}); }
  const { contents, system } = toGemini(body);
  if (!contents.length) return $done({}); // 不认识的请求，放行给千问

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
  const cands = [""].concat(args.BACKUP); // "" = 按 Loon 配置规则；其后依次尝试备用策略
  const t0 = Date.now();
  let idx = 0;
  let retried5xx = false;
  let retriedNoThink = false;

  function attempt() {
    const node = cands[idx];
    const remain = BUDGET_MS - (Date.now() - t0);
    const opts = {
      url,
      headers: { "Content-Type": "application/json", "x-goog-api-key": args.KEY },
      body: JSON.stringify(payload),
      timeout: Math.max(5000, Math.min(idx === 0 ? FIRST_TRY_MS : BACKUP_TRY_MS, remain - 2000)), // 毫秒
    };
    if (node) opts.node = node;
    console.log(TAG + " POST via " + (node || "config rules") + ", timeout=" + opts.timeout + "ms");

    $httpClient.post(opts, (err, resp, data) => {
      const took = Date.now() - t0;
      if (err) {
        console.log(TAG + " " + (node || "config rules") + " failed @" + took + "ms: " + err);
        if (idx < cands.length - 1 && BUDGET_MS - took > 8000) { idx++; return attempt(); }
        const tried = cands.map((x) => x || "配置规则").join("、");
        return reply("连接 Gemini 失败：已尝试 " + tried + "，都连不上。请确认其中有能访问 Google 的节点。（脚本 v" + VERSION + "）", [], tag);
      }
      handle(resp, data, node, took);
    });
  }

  function handle(resp, data, node, took) {
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
    console.log(TAG + " ok via " + (node || "config rules") + " in " + took + "ms");
    reply(text, cites, tag);
  }

  attempt();
})();
