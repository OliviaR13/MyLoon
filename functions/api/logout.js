import { clearCookie, json, sameOrigin } from "../_lib/auth.js";

// 退出登录：只接受 POST，始终返回 200 JSON，不再返回重定向。
//
// 之前这里对「非 JSON 请求」返回 302 到首页，并把 Set-Cookie 挂在重定向响应上。
// 前端 fetch() 不带 Accept: application/json，所以每次登出走的都是这条 302 分支。
// 问题在于：WebKit（iOS Safari）不保证处理重定向响应上的 Set-Cookie，
// 会话 Cookie 就删不掉，表现为「点了退出登录，刷新后又回到已登录状态」。
// 登出只能是普通响应，Cookie 只在 200 上发，任何浏览器都会照做。
export async function onRequestPost({ request }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  return json({ ok: true }, 200, {
    "Set-Cookie": clearCookie("mlb_session"),
  });
}
