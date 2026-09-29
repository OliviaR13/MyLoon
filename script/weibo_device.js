const arg = (typeof $argument === "object" && $argument) || {};
const MODEL = String(arg.MODEL || "iPhone19.7").replace(".", ",");
const DEBUG = String(arg.DEBUG) !== "false";

const before = $request.url;
// 只替换 ua 参数里的机型，保留 __weibo__版本__iphone__系统 部分
const after = before.replace(/([?&]ua=)iPhone\d+(?:,|%2C)\d+/i, "$1" + MODEL);

if (DEBUG) {
  const ua = (after.match(/[?&]ua=([^&]*)/) || [])[1];
  console.log("[weibo_device] changed=" + (after !== before) + " ua=" + ua);
}

$done(after !== before ? { url: after } : {});
