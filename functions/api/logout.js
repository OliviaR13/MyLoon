import { cookie } from "../_lib/auth.js";

export async function onRequest({ request }) {
  // 1. 设置 Max-Age=0 和 Path=/ 强制浏览器立即过期并销毁 Cookie
  const clearCookieHeader = cookie("mlb_session", "", {
    maxAge: 0,
    path: "/",
  });

  // 2. 如果前端是直接跳转请求，则重定向回首页；如果是 fetch 异步请求，则返回 JSON
  const isFetch = request.headers.get("accept")?.includes("application/json");

  if (isFetch) {
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": clearCookieHeader,
        "Cache-Control": "no-store",
      },
    });
  }

  // 页面直接点击退出时，清除 Cookie 并重定向回首页
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": clearCookieHeader,
      "Cache-Control": "no-store",
    },
  });
}
