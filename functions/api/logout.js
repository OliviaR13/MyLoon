import { clearCookie, getSession, json, sameOrigin } from "../_lib/auth.js";
import { revokeSession } from "../_lib/revoked-sessions.js";
import { isAuthUnavailable } from "../_lib/auth-error.js";

// 退出登录：只接受 POST，只作废当前这张会话（sid），其他设备保持登录。
// 还没有 sid 的旧 Cookie 无法在服务端单独作废，这里只清掉本机这张。
// 解绑、删除通行密钥、注销账号仍会抬高会话代数，让所有设备一起退出。
//
// 之前这里对「非 JSON 请求」返回 302 到首页，并把 Set-Cookie 挂在重定向响应上。
// 前端 fetch() 不带 Accept: application/json，所以每次登出走的都是这条 302 分支。
// 问题在于：WebKit（iOS Safari）不保证处理重定向响应上的 Set-Cookie，
// 会话 Cookie 就删不掉，表现为「点了退出登录，刷新后又回到已登录状态」。
// 登出只能是普通响应，Cookie 只在 200 上发，任何浏览器都会照做。
function cleared(body, status) {
  return json(body, status, { "Set-Cookie": clearCookie("mlb_session") });
}

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  try {
    const user = await getSession(request, env);
    if (user?.sid) await revokeSession(env, user.sid, user.id, user.exp);
  } catch (err) {
    if (!isAuthUnavailable(err)) throw err;
    return cleared({ error: "auth_unavailable" }, 503);
  }
  return cleared({ ok: true }, 200);
}
