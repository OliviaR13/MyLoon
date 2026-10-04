// Cloudflare Pages Function：POST /api/manifest
// 先在服务端调用 Turnstile siteverify 校验令牌，通过后才返回插件清单。
// 需要的环境变量（Pages 项目 → Settings → Variables and Secrets）：
//   TURNSTILE_SECRET     Turnstile 小组件的 Secret key（请设为 Secret）
//   TURNSTILE_HOSTNAMES  允许的前端域名，逗号分隔，例如 myloon.pages.dev
import manifest from "../../manifest.json";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACTION = "load_manifest"; // 需与 app.js 中 CONFIG.turnstile.action 一致

const forbidden = (reason) => json({ error: "forbidden", reason }, 403);
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export async function onRequestPost({ request, env }) {
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_HOSTNAMES) return json({ error: "server_misconfigured" }, 500);
  const hostnames = new Set(env.TURNSTILE_HOSTNAMES.split(",").map((h) => h.trim()).filter(Boolean));

  let token;
  try { ({ token } = await request.json()); } catch {}
  if (typeof token !== "string" || !token || token.length > 2048) return forbidden("no_token");

  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) body.set("remoteip", ip);

  let result;
  try {
    const res = await fetch(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error("siteverify " + res.status);
    result = await res.json();
  } catch {
    return forbidden("siteverify_unreachable");
  }

  // reason 只包含错误码、action 和访问域名，便于排查，不含密钥
  if (!result.success) return forbidden("siteverify_failed:" + (result["error-codes"] || []).join(","));
  if (result.action !== ACTION) return forbidden("action_mismatch:" + result.action);
  if (!hostnames.has(result.hostname)) return forbidden("hostname_mismatch:" + result.hostname);
  return json(manifest);
}
