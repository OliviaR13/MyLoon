// Cloudflare Pages 全局中间件：拦截微信内置浏览器
//
// 为什么要拦：微信内置浏览器不允许网页唤起 Loon 的 URL Scheme（loon://），安装按钮在里面点了没有反应。
// 所以访问页面时直接返回一页引导，让用户改用系统浏览器打开；其余浏览器原样放行。
//
// 识别方式：微信（含企业微信、桌面版微信）的 User-Agent 都带 MicroMessenger。
// 只拦「读页面」的请求（GET / HEAD）。拦截页只依赖 /fonts/ 下的字体，该路径必须放行，
// 否则字体请求也会收到这页 403，拦截页自己的字体就加载不出来。

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
<style>
@font-face{font-family:"Geist Sans";src:url("/fonts/Geist-Variable.woff2") format("woff2");font-weight:100 900;font-display:swap}
:root{
  --bg:#f6f4ef;--card:#fdfcf9;--text:#1d1b17;--muted:#6a655a;--line:#e6e2d8;--chip:#efece4;
  --accent:#0f7f69;--accent-text:#0a6250;--accent-ink:#f7fbf9;
  --glow:color-mix(in srgb,var(--accent) 16%,transparent);
  --ease:cubic-bezier(.2,.8,.2,1);--spring:cubic-bezier(.34,1.4,.64,1);
  --font:"Geist Sans",-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Noto Sans SC","Segoe UI",sans-serif;
}
@media (prefers-color-scheme:dark){
  :root{--bg:#12110f;--card:#191815;--text:#efece5;--muted:#a39e92;--line:#2b2924;--chip:#23211d;
    --accent:#3fcfa6;--accent-text:#3fcfa6;--accent-ink:#04140e;
    --glow:color-mix(in srgb,var(--accent) 14%,transparent)}
}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--bg);-webkit-text-size-adjust:100%}
body{margin:0;min-height:100dvh;display:grid;place-items:center;
  padding:calc(24px + env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom));
  background:var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased}
/* 背景光晕：和主页（box/style.css 的 body::after）完全一致——固定在视口里，顶部和底部各 18% 渐变回底色 */
body::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    linear-gradient(var(--bg) 0,transparent 18%,transparent 82%,var(--bg) 100%),
    radial-gradient(75% 46% at 50% 14%,var(--glow),transparent 72%),
    radial-gradient(65% 40% at 85% 96%,color-mix(in srgb,var(--glow) 55%,transparent),transparent 70%)}
.hint{z-index:3;position:fixed;top:calc(12px + env(safe-area-inset-top));right:14px;display:flex;align-items:center;gap:6px;
  padding:7px 12px;border:1px solid var(--line);border-radius:999px;background:var(--card);
  font-size:12.5px;font-weight:600;box-shadow:0 6px 20px rgb(0 0 0 / 7%);animation:hint-in .5s var(--spring) .15s both}
.hint i{font-style:normal;color:var(--accent-text);font-size:15px;line-height:1}
.card{position:relative;z-index:2;width:min(100%,400px);padding:30px 22px 22px;border:1px solid var(--line);border-radius:16px;background:var(--card);
  text-align:center;box-shadow:0 12px 36px rgb(0 0 0 / 5%);animation:card-in .45s var(--ease) both}
.badge{display:inline-flex;align-items:center;height:26px;padding:0 10px;border:1px solid var(--line);border-radius:999px;
  background:var(--chip);color:var(--accent-text);font-size:12px;font-weight:600}
.icon{display:grid;place-items:center;width:48px;height:48px;margin:20px auto 14px;border-radius:13px;background:var(--chip);color:var(--accent)}
.icon svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
h1{margin:0;font-size:20px;line-height:1.35;font-weight:650;letter-spacing:-.02em}
.desc{margin:8px auto 20px;max-width:310px;color:var(--muted);font-size:13.5px;line-height:1.65}
.steps{margin:0;padding:0;list-style:none;border:1px solid var(--line);border-radius:10px;background:var(--bg);text-align:left;overflow:hidden}
.steps li{display:flex;align-items:center;gap:11px;min-height:50px;padding:0 14px;font-size:13.5px}
.steps li+li{border-top:1px solid var(--line)}
.n{flex:none;display:grid;place-items:center;width:21px;height:21px;border-radius:50%;background:var(--accent);color:var(--accent-ink);font-size:11px;font-weight:700}
.steps b{font-weight:650}
.copy{display:block;width:100%;margin-top:14px;padding:12px 16px;border:0;border-radius:10px;
  background:var(--accent);color:var(--accent-ink);font:inherit;font-size:14px;font-weight:650;cursor:pointer;
  transition:transform .35s var(--spring),opacity .2s}
.copy:active{transform:scale(.97)}
.copy[data-done]{opacity:.85}
.tip{margin:12px 0 0;color:var(--muted);font-size:12px;line-height:1.5}
@keyframes card-in{from{opacity:0;transform:translateY(8px)}}
@keyframes hint-in{from{opacity:0;transform:translateY(-5px) scale(.96)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="hint" aria-hidden="true"><span>点击右上角「${esc(menu)}」</span><i>↗</i></div>
<main class="card">
  <span class="badge">OliviaR13's Loon Box</span>
  <div class="icon" aria-hidden="true">
    <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
  </div>
  <h1>请在浏览器中打开</h1>
  <p class="desc">微信内置浏览器无法唤起 Loon。请改用系统浏览器打开本页，再继续安装插件。</p>
  <ol class="steps">
    <li><span class="n">1</span><span>点击右上角菜单 <b>「${esc(menu)}」</b></span></li>
    <li><span class="n">2</span><span>选择 <b>「${esc(open)}」</b></span></li>
  </ol>
  <button class="copy" id="copy" type="button">复制链接</button>
  <p class="tip">找不到菜单？复制链接后，到浏览器地址栏粘贴打开即可。</p>
</main>
<script>
(function () {
  var btn = document.getElementById("copy"), timer;
  function done(ok) {
    btn.textContent = ok ? "已复制，去浏览器粘贴打开" : "复制失败，请长按地址手动复制";
    btn.setAttribute("data-done", "");
    clearTimeout(timer);
    timer = setTimeout(function () { btn.textContent = "复制链接"; btn.removeAttribute("data-done"); }, 2500);
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
