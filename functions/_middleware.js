// Cloudflare Pages 全局中间件：拦截微信内置浏览器
//
// 为什么要拦：微信内置浏览器不允许网页唤起 Loon 的 URL Scheme（loon://），安装按钮在里面点了没有反应。
// 所以访问页面时直接返回一页引导，让用户改用系统浏览器打开；其余浏览器原样放行。
//
// 识别方式：微信（含企业微信、桌面版微信）的 User-Agent 都带 MicroMessenger。
// 只拦「读页面」的请求（GET / HEAD）。拦截页只依赖 /fonts/ 下的字体，该路径必须放行，
// 否则字体请求也会收到这页 403，拦截页自己的字体就加载不出来。图标是内嵌的（见 _lib/wechat-logo.js），不需要放行。
//
// 样式：和主站（box/style.css）用同一套设计语言——同样的色板 / 圆角 / 字体 / 背景光晕和颗粒、
// 同样的「一个容器、行与行之间细线分隔」的列表、同样的主按钮和页脚卡片。
// 版式参考了常见的微信引导页：右上角一支大箭头直接指向微信的「···」，配一句大字说明；
// 下面是两步操作（每步右边配对应的界面小样），最后是「复制链接」退路。
// 动效只有一处：箭头进场时沿路径画出来，之后隔几秒朝角落轻推一下；减少动效时全部关掉。
// 点完「复制链接」按钮自己变成「已复制」（主站「按钮自己当确认」的同款）。
// 改主站的设计变量时，这里的 :root 也要跟着改。

import { LOGO } from "./_lib/wechat-logo.js";
import { applySecurityHeaders } from "./_lib/security-headers.js";

const WECHAT = /MicroMessenger/i;
const PASS_PREFIXES = ["/fonts/"];

// 按系统给出对应的菜单文案；识别不出来时用通用说法
const GUIDES = {
  ios: { menu: "…", open: "在 Safari 中打开" },
  android: { menu: "⋮", open: "在浏览器中打开" },
  other: { menu: "…", open: "在默认浏览器中打开" },
};

function detectPlatform(ua) {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

// 菜单按钮的三个点画成 SVG：「…」这个字符在不同字体里很小、位置也不稳，看不出是个按钮。
// 竖排（⋮）对应安卓，其余横排；读屏读的是括号里的文字。
function dots(menu, cls = "dots") {
  const v = menu === "⋮";
  const c = [0, 1, 2].map((i) => (v ? `<circle cx="2" cy="${2 + i * 5}" r="1.8"/>` : `<circle cx="${2 + i * 5}" cy="2" r="1.8"/>`)).join("");
  return `<svg class="${cls}" viewBox="${v ? "0 0 4 14" : "0 0 14 4"}" width="${v ? 4 : 14}" height="${v ? 14 : 4}" fill="currentColor" aria-hidden="true">${c}</svg><span class="sr">${v ? "竖排三个点" : "三个点"}</span>`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page({ menu, open }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f4ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#12110f" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex">
<title>请在浏览器中打开 · Loon Box</title>
<link rel="icon" href="${LOGO}">
<style>
@font-face{font-family:"Geist Sans";src:url("/fonts/Geist-Variable.woff2") format("woff2");font-weight:100 900;font-display:swap}
:root{
  --bg:#f6f4ef;--card:#fdfcf9;--text:#1d1b17;--muted:#6a655a;--line:#e6e2d8;--chip:#efece4;
  --accent:#0f7f69;--accent-text:#0a6250;--accent-ink:#f7fbf9;--shadow:40 30 10;
  --glow:color-mix(in srgb,var(--accent) 16%,transparent);
  /* 品牌渐变（站点图标同款），仅用于右上角箭头 */
  --brand-a:#0f7f69;--brand-b:#3b6cf0;--brand:linear-gradient(135deg,var(--brand-a),var(--brand-b));
  --r-lg:16px;--r-md:10px;--r-sm:6px;
  --ease:cubic-bezier(.2,.8,.2,1);--out-expo:cubic-bezier(.16,1,.3,1);
  --font:"Geist Sans",-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Noto Sans SC","Segoe UI",sans-serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#12110f;--card:#191815;--text:#efece5;--muted:#a39e92;--line:#2b2924;--chip:#23211d;
    --accent:#3fcfa6;--accent-text:#3fcfa6;--accent-ink:#04140e;--shadow:0 0 0;
    --glow:color-mix(in srgb,var(--accent) 14%,transparent);
    --brand-a:#3fcfa6;--brand-b:#6f95ff}
}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--bg);-webkit-text-size-adjust:100%;height:100%;overflow:hidden;-webkit-tap-highlight-color:transparent}
::selection{background:color-mix(in srgb,var(--accent) 24%,transparent);color:var(--text)}
/* 页面本身不滚动，背景固定在视口里纹丝不动；需要滚动时只有里面的 .scroll 滚。
   之前是整个文档在滚：在微信里往下拉，文档整体被拉下去，露出微信自己的灰色底，
   文档的上边缘就成了一条线，背景也跟着内容一起动。现在文档不动，下拉只会让 .scroll 回弹。 */
body{position:fixed;inset:0;margin:0;overflow:hidden;overscroll-behavior:none;
  background:var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;caret-color:var(--accent)}
/* 背景光晕 + 颗粒：和主站完全一致。光晕挪到右上角，和箭头指的方向一致 */
body::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(60% 34% at 92% 0%,var(--glow),transparent 72%),
    radial-gradient(65% 40% at 10% 100%,color-mix(in srgb,var(--glow) 55%,transparent),transparent 70%)}
body::before{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.05;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.scroll{position:absolute;z-index:2;inset:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.shell{max-width:480px;margin:0 auto;padding:calc(132px + env(safe-area-inset-top)) 20px calc(32px + env(safe-area-inset-bottom))}
h1,h2,p{margin:0}
a{color:var(--accent-text);text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.nw{white-space:nowrap}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* 右上角的箭头：这一页唯一的「动作」。直接指向微信顶栏的菜单按钮（同类引导页最通行的做法），
   进场时沿路径画出来，之后每隔几秒朝角落轻推一下 */
.pointer{z-index:3;position:fixed;top:calc(6px + env(safe-area-inset-top));right:10px;display:flex;align-items:flex-end;gap:4px;pointer-events:none}
.pointer-label{margin-bottom:8px;padding:6px 11px;border-radius:999px;background:var(--text);color:var(--bg);font-size:13px;font-weight:650;line-height:1.2;white-space:nowrap;
  box-shadow:0 4px 12px -2px rgb(var(--shadow) / .25);animation:fade .4s var(--out-expo) .75s backwards}
.pointer-label .dots{vertical-align:middle;margin:0 1px 0 3px}
.arrow{width:76px;height:96px;overflow:visible;animation:nudge 2.6s var(--ease) 1.6s infinite}
.arrow path{fill:none;stroke:url(#ag);stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round}
.arrow .shaft{stroke-dasharray:140;stroke-dashoffset:0;animation:draw .8s var(--out-expo) .15s backwards}
.arrow .head{animation:fade .25s ease-out .7s backwards}

/* 品牌行：缩成一行，让位给标题（拦截页的主角是「怎么打开」，不是品牌） */
.brand{display:flex;align-items:center;gap:9px;margin-bottom:18px;font-size:13.5px;font-weight:650;letter-spacing:-.01em}
.brand img{border-radius:8px;box-shadow:0 0 0 1px var(--line)}
.brand span{color:var(--muted);font-weight:500}
h1{font-size:28px;line-height:1.18;font-weight:700;letter-spacing:-.03em;text-wrap:balance}
.lead{margin-top:8px;color:var(--muted);font-size:15px;line-height:1.6;text-wrap:pretty}

/* 步骤：主站的「一个容器、行与行之间细线分隔」的列表；每行右边配一个对应的界面小样 */
.list{margin-top:24px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--card);overflow:hidden}
.list>*+*{border-top:1px solid var(--line)}
.steps{margin:0;padding:0;list-style:none}
.steps>li+li{border-top:1px solid var(--line)}
.step{display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:14px;padding:16px}
.n{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;background:var(--chip);color:var(--text);font-size:12.5px;font-weight:700;box-shadow:inset 0 0 0 1px var(--line)}
.step-text{font-size:15px;line-height:1.45;font-weight:600}
.step-text .dots{vertical-align:middle;margin:0 1px}
/* 界面小样：微信顶栏的菜单胶囊；「在浏览器中打开」一项改用主站强调色（--accent / --accent-ink），与主按钮一致 */
.ui-menu{display:grid;place-items:center;width:44px;height:30px;border-radius:999px;background:var(--chip);color:var(--text);box-shadow:inset 0 0 0 1px var(--line)}
.ui-open{display:grid;place-items:center;width:44px}
.ui-open i{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:var(--accent);color:var(--accent-ink)}
.ui-open svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}

/* 复制链接：退路，放在步骤之后；地址框 + 主按钮（主站的 .btn-primary）。
   按钮自己当确认（主站同款）：两段文字叠在同一格，旧文字上滑走、新文字从下面滑进来 */
.copy{display:grid;gap:10px;padding:16px}
.copy-title{font-size:13.5px;font-weight:500;color:var(--muted)}
.url{display:block;padding:11px 12px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--bg);font:12.5px/1.4 var(--mono);color:var(--text);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;-webkit-user-select:all;user-select:all}
.btn{font:inherit;font-size:15px;font-weight:650;width:100%;min-height:46px;padding:12px 14px;border:0;border-radius:var(--r-md);
  background:var(--accent);color:var(--accent-ink);cursor:pointer;line-height:1.2;
  box-shadow:0 1px 0 rgb(var(--shadow) / .08),0 4px 10px -4px rgb(var(--shadow) / .35);
  display:inline-grid;grid-template-areas:"s";align-items:center;justify-items:center;overflow:hidden;
  transition:filter .15s,transform .3s var(--out-expo)}
.btn:active{transform:scale(.97)}
@media (hover:hover){.btn:hover{filter:brightness(1.08)}}
.btn>.lbl{grid-area:s;display:inline-flex;align-items:center;gap:7px;transition:transform .34s var(--ease),opacity .2s}
.btn>.lbl-alt{transform:translateY(70%);opacity:0}
.btn[data-done]>.lbl:not(.lbl-alt){transform:translateY(-70%);opacity:0}
.btn[data-done]>.lbl-alt{transform:none;opacity:1;transition-delay:.04s}
.btn[data-done]{filter:brightness(1.12)}
.btn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.btn.fail .lbl-alt svg{display:none}

/* 页脚：和主站其他页面同一套卡片样式（box/styles/base.css 的 .foot） */
.foot{margin-top:14px;padding:16px 16px 14px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--card)}
.foot-brand{margin:0 0 6px;color:var(--text);font-size:13.5px;font-weight:650;letter-spacing:-.02em}
.foot p{color:var(--muted);font-size:12.5px;line-height:1.55}

main{animation:rise .5s var(--out-expo) backwards}
/* 宽屏（桌面版微信）：箭头还是贴着右上角，内容再往下放一点 */
@media (min-width:720px){.shell{padding-top:calc(120px + env(safe-area-inset-top))}}
/* 窄屏（320 宽）：标题小一号，界面小样收窄 */
@media (max-width:350px){h1{font-size:25px}.step{gap:12px;padding:14px}}

@keyframes rise{from{opacity:0;transform:translateY(10px)}}
@keyframes fade{from{opacity:0}}
@keyframes draw{from{stroke-dashoffset:140}}
@keyframes nudge{0%,55%,100%{transform:none}25%{transform:translate(3px,-4px)}}
/* 减少动效：箭头直接画好、不再推动，内容直接出现；复制按钮仍然切换文字，只是不滑动 */
@media (prefers-reduced-motion:reduce){
  .arrow,.arrow path,.pointer-label,main{animation:none}
  .btn,.btn>.lbl{transition:opacity .15s}
  .btn>.lbl-alt,.btn[data-done]>.lbl:not(.lbl-alt){transform:none}
}
</style>
</head>
<body>
<div class="pointer" aria-hidden="true">
  <span class="pointer-label">点击右上角 ${dots(menu)}</span>
  <svg class="arrow" viewBox="0 0 76 96">
    <defs><linearGradient id="ag" x1="0" y1="1" x2="1" y2="0"><stop offset="0" style="stop-color:var(--brand-a)"/><stop offset="1" style="stop-color:var(--brand-b)"/></linearGradient></defs>
    <path class="shaft" d="M10 90C14 52 34 26 62 10"/>
    <path class="head" d="M46 8l17 1.5-5 16"/>
  </svg>
</div>
<div class="scroll">
<main class="shell">
  <p class="brand"><img src="${LOGO}" alt="" width="26" height="26">Loon Box <span>OliviaR13's Loon Library</span></p>
  <h1>请在浏览器中打开</h1>
  <p class="lead">微信内置浏览器无法唤起 Loon。请使用系统浏览器打开本页，以安装插件。</p>
  <section class="list" aria-label="打开方法">
    <ol class="steps">
      <li class="step"><span class="n" aria-hidden="true">1</span><span class="step-text"><span class="sr">第 1 步：</span>点击右上角「${dots(menu)}」</span><span class="ui-menu" aria-hidden="true">${dots(menu)}</span></li>
      <li class="step"><span class="n" aria-hidden="true">2</span><span class="step-text"><span class="sr">第 2 步：</span>选择<span class="nw">「${esc(open)}」</span></span><span class="ui-open" aria-hidden="true"><i><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg></i></span></li>
    </ol>
    <div class="copy">
      <p class="copy-title" id="urlLabel">或复制链接后在浏览器中访问</p>
      <code class="url" id="url" aria-labelledby="urlLabel"></code>
      <button class="btn" id="copy" type="button">
        <span class="lbl"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>复制链接</span>
        <span class="lbl lbl-alt" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span id="doneText"></span></span>
      </button>
      <span class="sr" role="status" aria-live="polite" id="live"></span>
    </div>
  </section>
  <footer class="foot">
    <p class="foot-brand">OliviaR13's Loon Box</p>
    <p>本服务不支持在微信内打开。隐私政策与使用条款请在系统浏览器中查看。</p>
  </footer>
</main>
</div>
<script>
(function () {
  var btn = document.getElementById("copy"), txt = document.getElementById("doneText"), live = document.getElementById("live"), timer;
  document.getElementById("url").textContent = location.href;
  function done(ok) {
    txt.textContent = ok ? "已复制" : "复制失败，请长按上方地址复制";
    btn.className = ok ? "btn" : "btn fail";
    btn.setAttribute("data-done", "");
    live.textContent = txt.textContent; // 读屏软件也能知道结果
    clearTimeout(timer);
    timer = setTimeout(function () { btn.removeAttribute("data-done"); live.textContent = ""; }, 2500);
  }
  // 微信里 navigator.clipboard 经常不可用（非安全上下文或被禁用），退回到 execCommand
  function fallback(text) {
    var t = document.createElement("textarea");
    t.value = text; t.setAttribute("readonly", "");
    t.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, text.length);
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(t);
    return ok;
  }
  btn.addEventListener("click", function () {
    var url = location.href;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(fallback(url)); });
    } else {
      done(fallback(url));
    }
  });
})();
</script>
</body>
</html>`;
}

async function dispatch({ request, next }) {
  const { pathname } = new URL(request.url);
  if (PASS_PREFIXES.some((p) => pathname.startsWith(p))) return next();
  if (request.method !== "GET" && request.method !== "HEAD") return next();

  const ua = request.headers.get("user-agent") || "";
  if (!WECHAT.test(ua)) return next();

  return new Response(request.method === "HEAD" ? null : page(GUIDES[detectPlatform(ua)]), {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "vary": "User-Agent", // 同一个地址，微信和其他浏览器看到的内容不同，别让缓存串了
      "x-robots-tag": "noindex",
    },
  });
}

export async function onRequest(ctx) {
  return applySecurityHeaders(await dispatch(ctx), ctx.request);
}
