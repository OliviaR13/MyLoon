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
// 同样的头部（图标 + 标题）、同样的「一个容器、行与行之间细线分隔」的列表、同样的按钮和标签，
// 以及同一套动效：背景光晕淡入 → 图标弹出 → 标题 → 列表浮上来 → 各行依次浮上来，
// 按钮按下的弹簧回弹，点完「复制链接」按钮自己变成「已复制」（主站「按钮自己当确认」的同款）。
// 改主站的设计变量时，这里的 :root 也要跟着改。

import { LOGO } from "./_lib/wechat-logo.js";

const WECHAT = /MicroMessenger/i;
const PASS_PREFIXES = ["/fonts/"];

// 按系统给出对应的菜单文案；识别不出来时用通用说法
const GUIDES = {
  ios: { menu: "…", open: "在 Safari 中打开" },
  android: { menu: "⋮", open: "在浏览器打开" },
  other: { menu: "…", open: "在默认浏览器中打开" },
};

function detectPlatform(ua) {
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
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
  --r-lg:16px;--r-md:10px;--r-sm:6px;
  --ease:cubic-bezier(.2,.8,.2,1);--spring:cubic-bezier(.34,1.4,.64,1);
  --font:"Geist Sans",-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Noto Sans SC","Segoe UI",sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#12110f;--card:#191815;--text:#efece5;--muted:#a39e92;--line:#2b2924;--chip:#23211d;
    --accent:#3fcfa6;--accent-text:#3fcfa6;--accent-ink:#04140e;--shadow:0 0 0;
    --glow:color-mix(in srgb,var(--accent) 14%,transparent)}
}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--bg);-webkit-text-size-adjust:100%;height:100%;overflow:hidden}
/* 页面本身不滚动，背景固定在视口里纹丝不动；需要滚动时只有里面的 .scroll 滚。
   之前是整个文档在滚：在微信里往下拉，文档整体被拉下去，露出微信自己的灰色底，
   文档的上边缘就成了一条线，背景也跟着内容一起动。现在文档不动，下拉只会让 .scroll 回弹。 */
body{position:fixed;inset:0;margin:0;overflow:hidden;overscroll-behavior:none;
  background:var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
/* 背景光晕 + 颗粒：和主站完全一致（光晕淡入，见下面的 intro-glow） */
body::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    linear-gradient(var(--bg) 0,transparent 18%,transparent 82%,var(--bg) 100%),
    radial-gradient(75% 46% at 50% 14%,var(--glow),transparent 72%),
    radial-gradient(65% 40% at 85% 96%,color-mix(in srgb,var(--glow) 55%,transparent),transparent 70%);
  animation:intro-glow 1.3s ease-out backwards}
body::before{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.05;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.scroll{position:absolute;z-index:2;inset:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
/* 顶部多留一截：右上角的提示药丸（指向微信的「···」）固定在那里，不能压到标题 */
.shell{max-width:560px;margin:0 auto;padding:calc(56px + env(safe-area-inset-top)) 16px calc(36px + env(safe-area-inset-bottom))}
h1,h2,p{margin:0}

/* 右上角提示：指向微信的菜单按钮，箭头轻轻点动 */
.hint{z-index:3;position:fixed;top:calc(12px + env(safe-area-inset-top));right:14px;display:flex;align-items:center;gap:6px;
  padding:7px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);
  font-size:12.5px;font-weight:600;box-shadow:0 6px 20px rgb(var(--shadow) / .12);animation:hint-in .5s var(--spring) .15s both}
.hint i{display:inline-block;font-style:normal;color:var(--accent-text);font-size:15px;line-height:1;animation:nudge 1.8s ease-in-out 1.1s infinite}

/* 头部：和主站一样，图标 + 两行标题 + 副标题 */
.head{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.logo{border-radius:var(--r-md);flex:none;box-shadow:0 0 0 1px var(--line);animation:intro-pop .7s cubic-bezier(.34,1.3,.64,1) backwards}
.head-text{flex:1;min-width:0;animation:intro-up .6s var(--ease) .08s backwards}
.head h1{font-size:24px;line-height:1.05;font-weight:700;letter-spacing:-.03em}
.h1-eyebrow{display:block;font-size:13px;font-weight:600;letter-spacing:0;color:var(--muted);margin-bottom:3px}
.head p{color:var(--muted);font-size:13px;font-weight:500;margin-top:5px}

/* 引导列表：一个容器，行与行之间用细线分隔（主站的 .list / .card） */
.list{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--card);overflow:hidden;animation:intro-up .6s var(--ease) .2s backwards}
.list>*+*,.steps>li+li{border-top:1px solid var(--line)}
.row{display:flex;align-items:center;gap:12px 14px;padding:16px;animation:rise .34s var(--ease) both;animation-delay:calc(.3s + var(--i,0) * 60ms)}
.row-hero{align-items:flex-start}
.gicon{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:var(--r-md);background:var(--chip);color:var(--accent);box-shadow:0 0 0 1px var(--line)}
.gicon svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.name{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
h2{font-size:16px;line-height:1.35;font-weight:650;letter-spacing:-.01em}
.chip{display:inline-block;font-size:11px;line-height:1;padding:4px 7px;border-radius:var(--r-sm);background:color-mix(in srgb,var(--accent) 13%,transparent);color:var(--accent-text);font-weight:600}
.desc{margin-top:5px;color:var(--muted);font-size:13.5px;line-height:1.55}
.steps{margin:0;padding:0;list-style:none}
.step{min-height:56px;padding-block:0;font-size:14px}
.n{flex:none;display:grid;place-items:center;width:21px;height:21px;border-radius:50%;background:var(--accent);color:var(--accent-ink);font-size:11px;font-weight:700}
.step b{font-weight:650}

/* 按钮：主站的 .btn .btn-primary；点完按钮自己变成「已复制」（主站「按钮自己当确认」同款：
   两段文字叠在同一格里，按钮大小不变，旧文字向上滑走、新文字从下面滑进来，按钮亮一点） */
.btn{font:inherit;font-size:14.5px;font-weight:600;width:100%;padding:11px 14px;border:1px solid var(--accent);border-radius:var(--r-md);
  background:var(--accent);color:var(--accent-ink);cursor:pointer;line-height:1.2;
  display:inline-grid;grid-template-areas:"s";align-items:center;justify-items:center;overflow:hidden;
  transition:filter .15s,transform .35s var(--spring)}
.btn:active{transform:scale(.97)}
.btn>.lbl{grid-area:s;display:inline-flex;align-items:center;gap:6px;transition:transform .34s var(--ease),opacity .2s}
.btn>.lbl-alt{transform:translateY(70%);opacity:0}
.btn[data-done]>.lbl:not(.lbl-alt){transform:translateY(-70%);opacity:0}
.btn[data-done]>.lbl-alt{transform:none;opacity:1;transition-delay:.04s}
.btn[data-done]{filter:brightness(1.12)}
.btn svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.btn.fail svg{display:none}
.foot{margin:20px 8px 0;text-align:center;color:var(--muted);font-size:12.5px;line-height:1.55;animation:intro-glow .5s ease-out .55s backwards}

@keyframes intro-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes intro-pop{from{opacity:0;transform:scale(.86)}to{opacity:1;transform:none}}
@keyframes intro-glow{from{opacity:0}to{opacity:1}}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
@keyframes hint-in{from{opacity:0;transform:translateY(-5px) scale(.96)}}
@keyframes nudge{0%,60%,100%{transform:none}30%{transform:translate(2.5px,-2.5px)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="hint" aria-hidden="true"><span>点击右上角「${esc(menu)}」</span><i>↗</i></div>
<div class="scroll">
<main class="shell">
  <header class="head">
    <img class="logo" src="${LOGO}" alt="" width="44" height="44">
    <div class="head-text">
      <h1><span class="h1-eyebrow">OliviaR13's</span>Loon Box</h1>
      <p>OliviaR13's Loon Library</p>
    </div>
  </header>
  <section class="list" aria-labelledby="t">
    <div class="row row-hero" style="--i:0">
      <span class="gicon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg></span>
      <div>
        <div class="name"><h2 id="t">请在浏览器中打开</h2><span class="chip">微信内无法唤起 Loon</span></div>
        <p class="desc">微信内置浏览器无法唤起 Loon。请改用系统浏览器打开本页，再继续安装插件。</p>
      </div>
    </div>
    <ol class="steps">
      <li class="row step" style="--i:1"><span class="n">1</span><span>点击右上角菜单 <b>「${esc(menu)}」</b></span></li>
      <li class="row step" style="--i:2"><span class="n">2</span><span>选择 <b>「${esc(open)}」</b></span></li>
    </ol>
    <div class="row" style="--i:3">
      <button class="btn" id="copy" type="button">
        <span class="lbl">复制链接</span>
        <span class="lbl lbl-alt" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span id="doneText"></span></span>
      </button>
    </div>
  </section>
  <p class="foot">找不到菜单？复制链接后，到浏览器地址栏粘贴打开即可。</p>
</main>
</div>
<script>
(function () {
  var btn = document.getElementById("copy"), txt = document.getElementById("doneText"), timer;
  function done(ok) {
    txt.textContent = ok ? "已复制，去浏览器粘贴打开" : "复制失败，请长按地址手动复制";
    btn.className = ok ? "btn" : "btn fail";
    btn.setAttribute("data-done", "");
    btn.setAttribute("aria-label", txt.textContent); // 读屏软件也能知道结果
    clearTimeout(timer);
    timer = setTimeout(function () { btn.removeAttribute("data-done"); btn.removeAttribute("aria-label"); }, 2500);
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

export async function onRequest({ request, next }) {
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
