// 登录相关的公共函数：签名 Cookie、会话读取、JSON 响应
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const hmacKey = (secret) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export const SESSION_TTL = 30 * 24 * 3600; // 登录有效期：30 天

// 把对象签名成 "内容.签名"
export async function seal(payload, secret) {
  const body = b64(enc.encode(JSON.stringify(payload)));
  const sig = b64(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${sig}`;
}

// 校验签名和过期时间，失败返回 null
export async function unseal(token, secret) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64(sig), enc.encode(body)))) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64(body)));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

export const getCookie = (req, name) => {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : "";
};

// 修复：默认 Path 统一为 "/"，并处理 Max-Age
export const cookie = (name, value, { maxAge, path = "/" } = {}) => {
  let cookieStr = `${name}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax`;
  if (typeof maxAge === "number") {
    cookieStr += `; Max-Age=${maxAge}`;
  }
  return cookieStr;
};

// 删除 Cookie。除了 Max-Age=0，再补一个过去的 Expires：
// 只写 Max-Age=0 在部分 WebKit 版本上不会真正删掉 Cookie，而 Expires 是所有
// 实现都认的兜底写法。删 Cookie 必须双写，别嫌啰嗦。
export const clearCookie = (name, path = "/") =>
  `${name}=; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

// 当前登录用户：{ id, login } 或 null
export const getSession = (request, env) =>
  env.SESSION_SECRET ? unseal(getCookie(request, "mlb_session"), env.SESSION_SECRET) : Promise.resolve(null);

// 写操作要求同源，配合 SameSite=Lax 防止跨站请求
export const sameOrigin = (request) => {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
};
