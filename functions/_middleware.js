export async function onRequest(context) {
  // 字体文件必须原样放行，否则微信里拿到的是下面的 403 页面，字体加载不出来
  if (new URL(context.request.url).pathname.startsWith("/fonts/")) return context.next();

  const userAgent = context.request.headers.get("user-agent") || "";

  // 微信内置浏览器无法直接唤起 Loon 的 URL Scheme
  if (userAgent.includes("MicroMessenger")) {
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1,viewport-fit=cover"
  >
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f6f4ef" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#111310" media="(prefers-color-scheme: dark)">
  <meta
    name="description"
    content="Loon Box - 请使用系统浏览器打开此页面"
  >
  <title>Loon Box · 请在浏览器中打开</title>

  <style>
    @font-face {
      font-family: "Geist Sans";
      src: url("/fonts/Geist-Variable.woff2") format("woff2");
      font-style: normal;
      font-weight: 100 900;
      font-display: swap;
    }

    :root {
      --bg: #f6f4ef;
      --card: #fdfcf9;
      --hover: #faf8f3;
      --text: #1d1b17;
      --muted: #6a655a;
      --line: #e6e2d8;
      --chip: #efece4;

      --accent: #0f7f69;
      --accent-text: #0a6250;
      --accent-ink: #f7fbf9;

      --r-lg: 16px;
      --r-md: 10px;
      --r-sm: 6px;

      --ease: cubic-bezier(.2,.8,.2,1);
      --spring: cubic-bezier(.34,1.4,.64,1);

      --font:
        "Geist Sans",
        -apple-system,
        BlinkMacSystemFont,
        "SF Pro Text",
        "PingFang SC",
        "Noto Sans SC",
        "Segoe UI",
        sans-serif;
    }

    :root[data-theme="dark"] {
      --bg: #111310;
      --card: #181a17;
      --hover: #1c1f1c;
      --text: #eeeeea;
      --muted: #a39e92;
      --line: #2a2d28;
      --chip: #222620;

      --accent: #4cae94;
      --accent-text: #6bc4aa;
      --accent-ink: #07130f;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #111310;
        --card: #181a17;
        --hover: #1c1f1c;
        --text: #eeeeea;
        --muted: #a39e92;
        --line: #2a2d28;
        --chip: #222620;

        --accent: #4cae94;
        --accent-text: #6bc4aa;
        --accent-ink: #07130f;
      }
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    html {
      min-height: 100%;
      background: var(--bg);
    }

    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100dvh;

      padding:
        calc(24px + env(safe-area-inset-top))
        18px
        calc(24px + env(safe-area-inset-bottom));

      display: flex;
      align-items: center;
      justify-content: center;

      background: var(--bg);
      color: var(--text);

      font-family: var(--font);
      -webkit-font-smoothing: antialiased;
      text-rendering: optimizeLegibility;
    }

    button,
    a {
      font: inherit;
    }

    .page {
      width: min(100%, 420px);
      animation: pageIn .45s var(--ease) both;
    }

    .card {
      position: relative;
      overflow: hidden;

      padding: 28px 24px 24px;

      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--r-lg);

      text-align: center;

      box-shadow:
        0 1px 2px rgb(0 0 0 / 2%),
        0 12px 36px rgb(0 0 0 / 4%);
    }

    .brand {
      display: inline-flex;
      align-items: center;

      min-height: 28px;
      padding: 0 10px;

      border: 1px solid var(--line);
      border-radius: 999px;

      background: var(--chip);
      color: var(--accent-text);

      font-size: 12px;
      font-weight: 600;
      letter-spacing: -.01em;
    }

    .icon {
      width: 48px;
      height: 48px;

      margin: 22px auto 16px;

      display: flex;
      align-items: center;
      justify-content: center;

      border-radius: 13px;

      background: var(--chip);
      color: var(--accent);
    }

    .icon svg {
      width: 23px;
      height: 23px;

      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    h1 {
      margin: 0;

      font-size: 20px;
      line-height: 1.35;
      font-weight: 650;
      letter-spacing: -.025em;
    }

    .description {
      max-width: 330px;

      margin: 9px auto 22px;

      color: var(--muted);

      font-size: 13.5px;
      line-height: 1.65;
      letter-spacing: -.005em;
    }

    .steps {
      overflow: hidden;

      border: 1px solid var(--line);
      border-radius: var(--r-md);

      background: var(--bg);

      text-align: left;
    }

    .step {
      min-height: 52px;

      padding: 0 14px;

      display: flex;
      align-items: center;
      gap: 11px;

      color: var(--text);

      font-size: 13px;
      line-height: 1.45;
    }

    .step + .step {
      border-top: 1px solid var(--line);
    }

    .number {
      width: 21px;
      height: 21px;

      flex: 0 0 21px;

      display: flex;
      align-items: center;
      justify-content: center;

      border-radius: 50%;

      background: var(--accent);
      color: var(--accent-ink);

      font-size: 10px;
      font-weight: 700;
    }

    .step strong {
      font-weight: 600;
    }

    .hint {
      margin-top: 14px;

      color: var(--muted);

      font-size: 11.5px;
      line-height: 1.5;
    }

    .wechat-pointer {
      position: fixed;

      top: calc(14px + env(safe-area-inset-top));
      right: 16px;

      display: flex;
      align-items: center;
      gap: 5px;

      padding: 7px 11px;

      border: 1px solid var(--line);
      border-radius: 999px;

      background: var(--card);
      color: var(--text);

      font-size: 12px;
      font-weight: 550;

      box-shadow: 0 5px 20px rgb(0 0 0 / 6%);

      animation: pointerIn .5s var(--spring) .15s both;
    }

    .pointer-arrow {
      color: var(--accent);
      font-size: 15px;
      line-height: 1;
    }

    @keyframes pageIn {
      from {
        opacity: 0;
        transform: translateY(8px);
      }

      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @keyframes pointerIn {
      from {
        opacity: 0;
        transform: translateY(-5px) scale(.96);
      }

      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    @media (max-width: 420px) {
      body {
        padding-left: 14px;
        padding-right: 14px;
      }

      .card {
        padding: 24px 18px 20px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .page,
      .wechat-pointer {
        animation: none;
      }
    }
  </style>
</head>

<body>

  <div class="wechat-pointer">
    <span>点击右上角「…」</span>
    <span class="pointer-arrow">↗</span>
  </div>

  <main class="page">
    <section class="card">

      <div class="brand">OliviaR13's Loon Box</div>

      <div class="icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
      </div>

      <h1>请在浏览器中打开</h1>

      <p class="description">
        微信内置浏览器无法直接唤起 Loon。
        请使用系统浏览器打开此页面后继续安装。
      </p>

      <div class="steps">
        <div class="step">
          <span class="number">1</span>
          <span>点击右上角菜单 <strong>「…」</strong></span>
        </div>

        <div class="step">
          <span class="number">2</span>
          <span>选择 <strong>「在默认浏览器中打开」</strong></span>
        </div>
      </div>

      <div class="hint">
        打开后返回插件页面，再点击「安装」即可。
      </div>

    </section>
  </main>

</body>
</html>`;

    return new Response(html, {
      status: 403,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  // 非微信浏览器正常放行
  return await context.next();
}
