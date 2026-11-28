// DeepL 翻译接口：把 http://deepl.loon/ 变成 Loon 里的本地翻译 API（请求在本机被拦截，不会真的发往外网）
// 用法：
//   GET  http://deepl.loon/?text=Hello&to=ZH               返回译文（纯文本）
//   GET  http://deepl.loon/?text=Hello&to=ZH&format=json   返回 JSON
//   POST http://deepl.loon/  正文为 JSON {"text":"Hello","to":"ZH"} 或表单 text=...&to=...
//   Safari 打开 http://deepl.loon/ 可直接翻译并查看本月用量
// 可选参数：from（源语言，不填则自动检测）、formality（default / more / less）、format（text / json / html）

const clean = (v) => {
  const s = String(v == null ? "" : v).trim();
  return /^(null|undefined)$/i.test(s) ? "" : s;
};
const arg = (typeof $argument === "object" && $argument) || {};
const KEY = clean(arg.API_KEY);
const PLAN = clean(arg.PLAN);
const DEFAULT_TO = (clean(arg.TARGET) || "ZH").toUpperCase();
const LIMIT = parseInt(clean(arg.LIMIT), 10) > 0 ? parseInt(clean(arg.LIMIT), 10) : 5000;
const USE_CACHE = String(arg.CACHE) !== "false";
const DEBUG = String(arg.DEBUG) === "true";
const log = (m) => { if (DEBUG) console.log("[deepl] " + m); };

// Free 账号的 Key 以 :fx 结尾，使用 api-free 域名；PLAN 选了 Free / Pro 时以选择为准
const isFree = PLAN === "Free" || (PLAN !== "Pro" && /:fx$/.test(KEY));
const BASE = isFree ? "https://api-free.deepl.com" : "https://api.deepl.com";
const AUTH = { Authorization: "DeepL-Auth-Key " + KEY };

// Loon 的 $httpClient 里 timeout 单位是毫秒（写 25 会在 25 毫秒内超时），插件脚本本身另有 30 秒总超时
const TRANSLATE_TIMEOUT = 25000;
const USAGE_TIMEOUT = 10000;

const LANGS = {
  "ZH": "简体中文", "ZH-HANT": "繁體中文", "EN-US": "English (US)", "EN-GB": "English (UK)",
  "JA": "日本語", "KO": "한국어", "DE": "Deutsch", "FR": "Français", "ES": "Español",
  "RU": "Русский", "IT": "Italiano", "PT-BR": "Português (BR)"
};
const ALIAS = { "EN": "EN-US", "PT": "PT-BR", "ZH-HANS": "ZH", "ZH-CN": "ZH", "ZH-TW": "ZH-HANT", "ZH-HK": "ZH-HANT" };
const normTo = (v) => { const s = clean(v).toUpperCase() || DEFAULT_TO; return ALIAS[s] || s; };
const normFrom = (v) => {
  const s = clean(v).toUpperCase();
  if (!s || s === "AUTO") return "";
  return (ALIAS[s] || s).split("-")[0];
};

// ---------- 读取请求参数 ----------
const decode = (s) => {
  try { return decodeURIComponent(String(s).replace(/\+/g, " ")); } catch (e) { return String(s); }
};
function parseForm(s) {
  const o = {};
  String(s || "").split("&").forEach((p) => {
    if (!p) return;
    const i = p.indexOf("=");
    o[decode(i < 0 ? p : p.slice(0, i))] = i < 0 ? "" : decode(p.slice(i + 1));
  });
  return o;
}
function header(name) {
  const h = $request.headers || {};
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? String(h[k]) : "";
}
function readParams() {
  const url = $request.url || "";
  const qi = url.indexOf("?");
  const params = parseForm(qi < 0 ? "" : url.slice(qi + 1).split("#")[0]);
  if (String($request.method || "GET").toUpperCase() === "POST" && typeof $request.body === "string" && $request.body) {
    const ct = header("content-type").toLowerCase();
    if (ct.indexOf("json") >= 0) {
      try { Object.assign(params, JSON.parse($request.body)); } catch (e) { /* 忽略错误的 JSON */ }
    } else if (ct.indexOf("x-www-form-urlencoded") >= 0) {
      Object.assign(params, parseForm($request.body));
    } else if (!params.text) {
      params.text = $request.body;
    }
  }
  if (Array.isArray(params.text)) params.text = params.text.join("\n");
  return params;
}

// ---------- 返回结果 ----------
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function reply(status, type, body) {
  $done({
    response: {
      status,
      headers: { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
      body
    }
  });
}
function page(o) {
  const opts = Object.keys(LANGS).map((c) => '<option value="' + c + '"' + (c === o.to ? " selected" : "") + ">" + LANGS[c] + "</option>").join("");
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">' +
    "<title>DeepL 翻译</title><style>body{font:16px/1.6 -apple-system,sans-serif;max-width:640px;margin:0 auto;padding:16px}" +
    "textarea,select,button{width:100%;box-sizing:border-box;font:inherit;padding:10px;margin:6px 0;border-radius:10px;border:1px solid #8884}" +
    "textarea{min-height:120px}button{background:#0f2b46;color:#fff;border:0}.box{white-space:pre-wrap;padding:12px;border-radius:10px;background:#8881;margin:10px 0}" +
    ".err{color:#d33}.dim{opacity:.65;font-size:14px}</style></head><body><h2>DeepL 翻译</h2>" +
    '<form method="get" action="/"><input type="hidden" name="format" value="html">' +
    '<textarea name="text" placeholder="输入要翻译的文字">' + esc(o.text) + "</textarea>" +
    '<select name="to">' + opts + '</select><button type="submit">翻译</button></form>' +
    (o.error ? '<div class="box err">' + esc(o.error) + "</div>" : "") +
    (o.result ? '<div class="box">' + esc(o.result) + '</div><div class="dim">识别源语言：' + esc(o.detected || "未知") + "</div>" : "") +
    (o.usage ? '<p class="dim">本期用量：' + esc(o.usage) + "</p>" : "") +
    '<p class="dim">接口：GET http://deepl.loon/?text=...&amp;to=ZH，可加 &amp;format=json</p></body></html>';
  reply(o.error ? 400 : 200, "text/html", html);
}
function fail(status, msg, fmt, p) {
  log("失败 " + status + " " + msg);
  if (fmt === "json") return reply(status, "application/json", JSON.stringify({ error: msg }));
  if (fmt === "html") return page({ text: p.text, to: normTo(p.to || p.target_lang), error: msg });
  reply(status, "text/plain", msg);
}
function ok(out, fmt, p, to, cached) {
  if (fmt === "json") {
    return reply(200, "application/json", JSON.stringify({ text: out.text, detected_source_language: out.detected, to, cached }));
  }
  if (fmt === "html") return page({ text: p.text, to, result: out.text, detected: out.detected });
  reply(200, "text/plain", out.text);
}

// ---------- 缓存（同一句话不重复扣额度） ----------
const CK = "DeepL_cache_v1";
function cacheGet(k) {
  if (!USE_CACHE) return null;
  try {
    const hit = JSON.parse($persistentStore.read(CK) || "[]").find((x) => x[0] === k);
    return hit ? { text: hit[1], detected: hit[2] } : null;
  } catch (e) { return null; }
}
function cacheSet(k, text, detected) {
  if (!USE_CACHE || k.length > 1200) return;
  try {
    let a = JSON.parse($persistentStore.read(CK) || "[]").filter((x) => x[0] !== k);
    a.push([k, text, detected]);
    if (a.length > 100) a = a.slice(-100);
    $persistentStore.write(JSON.stringify(a), CK);
  } catch (e) { /* 缓存失败不影响翻译 */ }
}

// ---------- 调用 DeepL ----------
function apiError(status, data) {
  const m = {
    400: "请求参数有误（目标语言或格式不被支持）",
    403: "API Key 无效，或账号类型选错（Free 的 Key 以 :fx 结尾）",
    413: "文本太长",
    429: "请求太频繁，请稍后再试",
    456: "本月额度已用完",
    500: "DeepL 服务暂时出错，请稍后再试",
    503: "DeepL 服务暂时不可用，请稍后再试",
    529: "请求太频繁，请稍后再试"
  };
  let detail = "";
  try { detail = JSON.parse(data).message || ""; } catch (e) { /* 无详情 */ }
  return (m[status] || "DeepL 返回 HTTP " + status) + (status === 400 && detail ? "：" + detail : "");
}
function translate(text, to, from, formality, cb) {
  const payload = { text: [text], target_lang: to };
  if (from) payload.source_lang = from;
  if (formality) payload.formality = formality;
  $httpClient.post({
    url: BASE + "/v2/translate",
    headers: Object.assign({ "Content-Type": "application/json" }, AUTH),
    body: JSON.stringify(payload),
    timeout: TRANSLATE_TIMEOUT
  }, (err, resp, data) => {
    if (err) return cb({ status: 502, msg: "连接 DeepL 失败（请检查插件的「代理指向的策略」能否访问 deepl.com）：" + err });
    if (resp.status !== 200) return cb({ status: resp.status, msg: apiError(resp.status, data) });
    try {
      const t = JSON.parse(data).translations[0];
      cb(null, { text: t.text, detected: t.detected_source_language });
    } catch (e) {
      cb({ status: 502, msg: "DeepL 返回内容无法解析" });
    }
  });
}
function fetchUsage(cb) {
  $httpClient.get({ url: BASE + "/v2/usage", headers: AUTH, timeout: USAGE_TIMEOUT }, (err, resp, data) => {
    if (err || resp.status !== 200) return cb("");
    try {
      const u = JSON.parse(data);
      cb(u.character_count + " / " + u.character_limit + " 字符");
    } catch (e) { cb(""); }
  });
}

// ---------- 主流程 ----------
(function main() {
  const p = readParams();
  const text = typeof p.text === "string" ? p.text : "";
  const fmt = clean(p.format).toLowerCase();

  if (!text.trim()) {
    if (fmt === "json" || fmt === "text") return fail(400, "缺少 text 参数", fmt, p);
    if (!KEY) return page({ to: DEFAULT_TO, error: "还没有填写 DeepL API Key，请在插件设置的「DeepL API Key」中填写。" });
    return fetchUsage((usage) => page({ to: DEFAULT_TO, usage }));
  }
  if (!KEY) return fail(400, "还没有填写 DeepL API Key，请在插件设置的「DeepL API Key」中填写。", fmt, p);
  if (text.length > LIMIT) return fail(413, "文本共 " + text.length + " 字符，超过单次上限 " + LIMIT + "，请在插件设置中调大或分段翻译。", fmt, p);

  const to = normTo(p.to || p.target_lang);
  const from = normFrom(p.from || p.source_lang);
  const formality = clean(p.formality).toLowerCase();
  const ck = [to, from, formality, text].join("\u0001");

  const hit = cacheGet(ck);
  if (hit) { log("命中缓存"); return ok(hit, fmt, p, to, true); }

  log("翻译 " + text.length + " 字符 → " + to + "（" + (isFree ? "Free" : "Pro") + "）");
  translate(text, to, from, formality, (e, out) => {
    if (e) return fail(e.status, e.msg, fmt, p);
    cacheSet(ck, out.text, out.detected);
    ok(out, fmt, p, to, false);
  });
})();
