import { clearCookie, json, sameOrigin } from "../../_lib/auth.js";

// 与 /api/logout 等价的别名，保留以兼容 auth 路由命名。
// 删除 Cookie 的写法统一走 _lib/auth.js 的 clearCookie，两边不会再各写一份。
export async function onRequestPost({ request }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  return json({ ok: true }, 200, {
    "Set-Cookie": clearCookie("mlb_session"),
  });
}
