export async function onRequest(context) {
  const userAgent = context.request.headers.get('user-agent') || '';

  // 匹配微信内置浏览器 User-Agent
  if (userAgent.includes('MicroMessenger')) {
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Loon Box - 请在浏览器中打开</title>
  <style>
    :root {
      --bg: #f6f7f6;
      --card: #ffffff;
      --text: #161a18;
      --muted: #68726d;
      --line: #e3e7e4;
      --accent: #2f6f5e;
      --accent-ink: #ffffff;
      --chip: #eef2ef;
      --radius: 14px;
      --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1110;
        --card: #171a19;
        --text: #eef1ef;
        --muted: #99a39e;
        --line: #262b29;
        --accent: #4aa58c;
        --accent-ink: #06130e;
        --chip: #202523;
      }
    }

    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font);
      background-color: var(--bg);
      color: var(--text);
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      -webkit-font-smoothing: antialiased;
      position: relative;
    }

    /* 右上角箭头引导气泡 */
    .wechat-pointer {
      position: fixed;
      top: calc(14px + env(safe-area-inset-top));
      right: 18px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--accent);
      color: var(--accent-ink);
      padding: 8px 16px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
      animation: cueBob 2s infinite ease-in-out;
      z-index: 100;
    }

    @keyframes cueBob {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-4px); }
    }

    /* 匹配 Loon Box 样式卡片 */
    .card {
      width: 100%;
      max-width: 400px;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      padding: 28px 20px;
      text-align: center;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03);
    }

    .brand-badge {
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      color: var(--accent);
      background: var(--chip);
      padding: 4px 12px;
      border-radius: 999px;
      margin-bottom: 16px;
    }

    .icon-box {
      width: 52px;
      height: 52px;
      margin: 0 auto 14px;
      background: var(--chip);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--accent);
    }

    .icon-box svg {
      width: 26px;
      height: 26px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    h1 {
      font-size: 18px;
      font-weight: 600;
      line-height: 1.3;
      margin-bottom: 8px;
    }

    p {
      font-size: 13.5px;
      color: var(--muted);
      line-height: 1.55;
      margin-bottom: 20px;
    }

    .step-list {
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px 14px;
      text-align: left;
    }

    .step-item {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
    }

    .step-item + .step-item {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--line);
    }

    .step-num {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--accent-ink);
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
  </style>
</head>
<body>

  <div class="wechat-pointer">
    点击右上角「...」 ↗
  </div>

  <div class="card">
    <div class="brand-badge">OliviaR13's Loon Box</div>
    
    <div class="icon-box">
      <svg viewBox="0 0 24 24">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
    </div>

    <h1>请在浏览器中打开</h1>
    <p>微信内置浏览器拦截了 URL Scheme，无法直接一键唤起 Loon 导入插件。</p>

    <div class="step-list">
      <div class="step-item">
        <span class="step-num">1</span>
        <span>点击右上角菜单 <strong>「 ... 」</strong></span>
      </div>
      <div class="step-item">
        <span class="step-num">2</span>
        <span>选择 <strong>「在默认浏览器中打开」</strong> 或 <strong>Safari</strong></span>
      </div>
    </div>
  </div>

</body>
</html>`;

    return new Response(html, {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  // 非微信浏览器正常放行
  return await context.next();
}
