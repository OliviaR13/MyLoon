// DeepL 翻译接口：把 http://deepl.loon/ 变成 Loon 里的本地翻译 API（请求在本机被拦截，不会真的发往外网）
// 用法：
//   POST http://deepl.loon/  正文为 JSON {"text":"Hello","to":"ZH"} 或表单 text=...&to=...（推荐：文字不会出现在网址里）
//   GET  http://deepl.loon/?text=Hello&to=ZH               返回译文（纯文本）；文字会出现在网址里，适合快捷指令临时用
//   GET  http://deepl.loon/?text=Hello&to=ZH&format=json   返回 JSON
//   Safari 打开 http://deepl.loon/ 是翻译页面（输入走 POST，不进网址），并显示本期用量
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
// 识别出的源语言显示名（DeepL 返回的是两位代码）
const DET = {
  EN: "英语", ZH: "中文", JA: "日语", KO: "韩语", DE: "德语", FR: "法语", ES: "西班牙语", RU: "俄语",
  IT: "意大利语", PT: "葡萄牙语", ID: "印尼语", TR: "土耳其语", NL: "荷兰语", PL: "波兰语", UK: "乌克兰语",
  AR: "阿拉伯语", SV: "瑞典语", DA: "丹麦语", FI: "芬兰语", NB: "挪威语", CS: "捷克语", EL: "希腊语",
  HU: "匈牙利语", RO: "罗马尼亚语", BG: "保加利亚语", SK: "斯洛伐克语", SL: "斯洛文尼亚语"
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

// ---------- 页面（风格取自主站 box/styles/base.css：暖色纸张底 + 单一绿色强调色 + 细线卡片） ----------
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const PAGE_CSS = `
@font-face{font-family:"Geist Sans";src:url("https://raw.githubusercontent.com/OliviaR13/MyLoon/main/fonts/Geist-Variable.woff2") format("woff2");font-weight:100 900;font-display:swap}
:root{--bg:#f6f4ef;--card:#fdfcf9;--text:#1d1b17;--muted:#6a655a;--line:#e6e2d8;--chip:#efece4;--accent:#0f7f69;--accent-text:#0a6250;--accent-ink:#f7fbf9;--danger:#b4372a;
--glow:color-mix(in srgb,var(--accent) 16%,transparent);--r-lg:16px;--r-md:10px;--spring:cubic-bezier(.34,1.4,.64,1);
--font:"Geist Sans",-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Noto Sans SC",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#12110f;--card:#191815;--text:#efece5;--muted:#a39e92;--line:#2b2924;--chip:#23211d;--accent:#3fcfa6;--accent-text:#3fcfa6;--accent-ink:#04140e;--danger:#ff8a7a;--glow:color-mix(in srgb,var(--accent) 14%,transparent)}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
body::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:linear-gradient(var(--bg) 0,transparent 18%,transparent 82%,var(--bg) 100%),radial-gradient(75% 46% at 50% 14%,var(--glow),transparent 72%),radial-gradient(65% 40% at 85% 96%,color-mix(in srgb,var(--glow) 55%,transparent),transparent 70%)}
body::before{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.05;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.shell{position:relative;z-index:2;max-width:720px;margin:0 auto;padding:calc(24px + env(safe-area-inset-top)) 16px calc(36px + env(safe-area-inset-bottom))}
h1,h2,p{margin:0}
a{color:var(--accent-text)}
.head{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.logo{width:44px;height:44px;border-radius:var(--r-md);flex:none;box-shadow:0 0 0 1px var(--line)}
.head-text{flex:1;min-width:0}
.head h1{font-size:24px;line-height:1.05;font-weight:700;letter-spacing:-.03em}
.eyebrow{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:3px}
.head p{color:var(--muted);font-size:13px;font-weight:500;margin-top:5px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r-lg);padding:14px 16px;margin-bottom:12px}
.cap{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:6px}
textarea{display:block;width:100%;min-height:132px;resize:vertical;border:0;outline:0;background:transparent;color:var(--text);font:inherit;font-size:16px;line-height:1.55;padding:0}
textarea::placeholder{color:var(--muted);opacity:.7}
.tools{display:flex;align-items:center;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
select{flex:1;min-width:0;font:inherit;font-size:16px;font-weight:600;color:var(--text);background:var(--chip);border:1px solid var(--line);border-radius:var(--r-md);padding:8px 10px}
.cnt{flex:none;font-size:12.5px;font-weight:600;color:var(--muted)}
.cnt.over{color:var(--danger)}
.btn{font:inherit;font-size:15px;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:var(--r-md);padding:10px 14px;cursor:pointer;line-height:1.2;transition:background-color .15s,filter .15s,transform .35s var(--spring)}
.btn:active:not(:disabled){transform:scale(.97)}
.btn:disabled{opacity:.55;cursor:default}
.btn-primary{width:100%;margin-top:12px;background:var(--accent);border-color:transparent;color:var(--accent-ink);box-shadow:0 6px 14px color-mix(in srgb,var(--accent) 26%,transparent)}
.btn-ghost{background:transparent}
.btn.sm{font-size:13px;padding:6px 12px}
.res-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.chip{display:inline-block;padding:3px 10px;border-radius:999px;background:var(--chip);color:var(--muted);font-size:12.5px;font-weight:600}
.res-text{white-space:pre-wrap;word-break:break-word;font-size:17px;line-height:1.6;-webkit-user-select:text;user-select:text}
.err{border-color:color-mix(in srgb,var(--danger) 35%,var(--line))}
.err p{color:var(--danger);font-size:14px;font-weight:500}
.u-top{display:flex;justify-content:space-between;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:8px}
.bar{height:6px;border-radius:99px;background:var(--chip);overflow:hidden}
.bar i{display:block;height:100%;background:var(--accent);border-radius:99px}
details.card summary{cursor:pointer;font-size:14px;font-weight:600;list-style:none}
details.card summary::-webkit-details-marker{display:none}
details.card pre{margin:10px 0 0;padding:10px 12px;border-radius:var(--r-md);background:var(--chip);font:12.5px/1.6 ui-monospace,"SF Mono",Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.foot{margin-top:24px;padding:16px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--card)}
.foot-brand{font-size:13.5px;font-weight:650;letter-spacing:-.02em}
.foot p{color:var(--muted);font-size:12.5px;margin-top:4px}
@media (prefers-reduced-motion:reduce){.btn{transition:none}}
`;

// 页面里的脚本：用 fetch 以 POST 提交，文字不进网址，也不整页刷新。必须自成一体（会被 toString 后内嵌进页面）
function clientMain(cfg) {
  var $ = function (id) { return document.getElementById(id); };
  var f = $("f"), t = $("t"), to = $("to"), go = $("go"), cnt = $("cnt"), out = $("out");
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function count() {
    cnt.textContent = t.value.length + " / " + cfg.limit;
    cnt.className = "cnt" + (t.value.length > cfg.limit ? " over" : "");
  }
  function showErr(msg) {
    out.textContent = "";
    var c = el("div", "card err");
    c.appendChild(el("p", null, msg));
    out.appendChild(c);
  }
  function showRes(text, det, code) {
    out.textContent = "";
    var c = el("div", "card res"), h = el("div", "res-head");
    h.appendChild(el("span", "chip", (cfg.det[det] || det || "自动检测") + " → " + (cfg.langs[code] || code)));
    var b = el("button", "btn btn-ghost sm", "复制");
    b.type = "button";
    b.setAttribute("data-copy", "1");
    h.appendChild(b);
    c.appendChild(h);
    c.appendChild(el("div", "res-text", text));
    out.appendChild(c);
  }
  // 页面是 http，没有 navigator.clipboard，用选中再 copy 的老办法
  function copy(text, btn) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    var old = btn.textContent;
    btn.textContent = ok ? "已复制" : "请长按选中复制";
    setTimeout(function () { btn.textContent = old; }, 1400);
  }
  t.addEventListener("input", count);
  count();
  out.addEventListener("click", function (e) {
    var b = e.target;
    while (b && b !== out && !(b.getAttribute && b.getAttribute("data-copy"))) b = b.parentNode;
    if (!b || b === out) return;
    var r = out.querySelector(".res-text");
    if (r) copy(r.textContent, b);
  });
  try {
    var saved = localStorage.getItem("deepl_to");
    if (saved && cfg.restoreTo) to.value = saved;
  } catch (e) { /* 存储不可用就算了 */ }
  to.addEventListener("change", function () {
    try { localStorage.setItem("deepl_to", to.value); } catch (e) { /* 忽略 */ }
  });
  t.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); go.click(); }
  });
  f.addEventListener("submit", function (e) {
    if (!window.fetch || !window.URLSearchParams) return; // 退回普通 POST 提交
    e.preventDefault();
    if (!t.value.trim()) { t.focus(); return; }
    go.disabled = true;
    go.textContent = "翻译中…";
    var body = new URLSearchParams();
    body.set("text", t.value);
    body.set("to", to.value);
    body.set("format", "json");
    fetch("/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: body.toString() })
      .then(function (r) { return r.json().catch(function () { return { error: "返回内容无法解析" }; }); })
      .then(function (d) {
        if (d.error) showErr(d.error);
        else showRes(d.text, d.detected_source_language, d.to || to.value);
      })
      .catch(function () { showErr("请求失败，请确认 Loon 已开启"); })
      .then(function () { go.disabled = false; go.textContent = "翻译"; });
  });
}

function page(o) {
  const opts = Object.keys(LANGS).map((c) => '<option value="' + c + '"' + (c === o.to ? " selected" : "") + ">" + LANGS[c] + "</option>").join("");
  let outHtml = "";
  if (o.error) outHtml = '<div class="card err"><p>' + esc(o.error) + "</p></div>";
  else if (o.result) {
    outHtml = '<div class="card res"><div class="res-head"><span class="chip">' + esc(DET[o.detected] || o.detected || "自动检测") + " → " + esc(LANGS[o.to] || o.to) +
      '</span><button type="button" class="btn btn-ghost sm" data-copy="1">复制</button></div><div class="res-text">' + esc(o.result) + "</div></div>";
  }
  let usageHtml = "";
  if (o.usage && o.usage.limit > 0) {
    const pct = Math.min(100, Math.round(o.usage.count / o.usage.limit * 100));
    usageHtml = '<div class="card"><div class="u-top"><span>本期用量</span><span>' + num(o.usage.count) + " / " + num(o.usage.limit) +
      ' 字符</span></div><div class="bar"><i style="width:' + pct + '%"></i></div></div>';
  }
  const apiDoc = "POST http://deepl.loon/\nContent-Type: application/json\n\n" + '{"text":"Hello","to":"ZH"}' +
    "\n\n# 也可以用 GET（文字会出现在网址和历史记录里）\nhttp://deepl.loon/?text=Hello&to=ZH\n# 加 &format=json 返回 JSON";
  const cfg = JSON.stringify({ limit: LIMIT, langs: LANGS, det: DET, restoreTo: !o.result && !o.text }).replace(/</g, "\\u003c");
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark">' +
    "<title>DeepL 翻译</title><style>" + PAGE_CSS + "</style></head><body><div class=\"shell\">" +
    '<header class="head"><img class="logo" src="https://raw.githubusercontent.com/OliviaR13/MyLoon/main/box/icon.png" alt="" onerror="this.remove()">' +
    '<div class="head-text"><span class="eyebrow">OliviaR13\'s Loon</span><h1>DeepL 翻译</h1><p>本机翻译接口 · 输入的文字不会出现在网址里</p></div></header>' +
    '<form id="f" class="card" method="post" action="/"><input type="hidden" name="format" value="html">' +
    '<label class="cap" for="t">原文</label>' +
    '<textarea id="t" name="text" placeholder="输入或粘贴要翻译的文字" autocomplete="off" autocapitalize="off">' + esc(o.text) + "</textarea>" +
    '<div class="tools"><select id="to" name="to" aria-label="目标语言">' + opts + '</select><span id="cnt" class="cnt"></span></div>' +
    '<button id="go" class="btn btn-primary" type="submit">翻译</button></form>' +
    '<section id="out" aria-live="polite">' + outHtml + "</section>" + usageHtml +
    '<details class="card"><summary>接口用法</summary><pre>' + esc(apiDoc) + "</pre></details>" +
    '<footer class="foot"><p class="foot-brand">OliviaR13\'s Loon · DeepL 翻译</p><p>译文由 DeepL 提供，请求在本机经 Loon 转发，Key 保存在 Loon 设置中。</p></footer>' +
    "</div><script>(" + clientMain.toString() + ")(" + cfg + ");</script></body></html>";
  reply(o.status || 200, "text/html", html);
}

// ---------- 返回结果 ----------
function reply(status, type, body) {
  $done({
    response: {
      status,
      headers: { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
      body
    }
  });
}
function fail(status, msg, fmt, p) {
  log("失败 " + status + " " + msg);
  if (fmt === "json") return reply(status, "application/json", JSON.stringify({ error: msg }));
  if (fmt === "html") return page({ text: p.text, to: normTo(p.to || p.target_lang), error: msg, status });
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
    if (err || resp.status !== 200) return cb(null);
    try {
      const u = JSON.parse(data);
      cb({ count: Number(u.character_count) || 0, limit: Number(u.character_limit) || 0 });
    } catch (e) { cb(null); }
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
