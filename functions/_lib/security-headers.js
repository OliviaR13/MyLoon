// 静态页和函数响应共用的安全头。
// style-src 使用 'unsafe-inline'：隐私政策、使用条款、版权页和微信拦截页都有成块的内联 <style>，
// 拦截页的样式还会随模板一起下发。脚本则用固定哈希，不放开 unsafe-inline / unsafe-eval。
// 插件图标来自各个 https 地址（见 box/js/config.js 的 safeIcon），所以图片允许 https 和 data。
const SCRIPT_HASHES = [
  "sha256-W8za6OX5b4ruKIrBKgumXY6wW9mcFHs+bTxEvpDzxdM=", // box/index.html 主题脚本
  "sha256-QO4ETcmJ2VB8X88TqdzBg2Fe9cMhGDB0lpTfZ1XEplA=", // privacy / terms / license 主题脚本
  "sha256-rqAuO9hIpB5c9oT2uFv/jUWjSQdXKNdDLxsgCTOjWQ8=", // 微信拦截页的复制脚本
];

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  `script-src 'self' https://challenges.cloudflare.com ${SCRIPT_HASHES.map((h) => `'${h}'`).join(" ")}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self'",
  "connect-src 'self' https://challenges.cloudflare.com https://raw.githubusercontent.com",
  "frame-src https://challenges.cloudflare.com",
  "form-action 'self'",
].join("; ");

export const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "content-security-policy": CONTENT_SECURITY_POLICY,
};

export function applySecurityHeaders(response, request) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  const path = new URL(request.url).pathname;
  // Pages 会给响应加上 Access-Control-Allow-Origin: *。接口是同源调用的，不需要这个头。
  if (path.startsWith("/api")) headers.delete("access-control-allow-origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
