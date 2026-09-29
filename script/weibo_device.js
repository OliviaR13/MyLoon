const arg = (typeof $argument === "object" && $argument) || {};
const MODEL = String(arg.MODEL || "iPhone19.7").replace(".", ",");
const DEBUG = String(arg.DEBUG) !== "false";

const re = /iPhone\d+(?:,|%2C)\d+/gi;

const beforeUrl = $request.url;
// 只替换 ua 参数里的机型，保留后面的 __weibo__版本__iphone__系统
const url = beforeUrl.replace(/([?&]ua=)iPhone\d+(?:,|%2C)\d+/i, "$1" + MODEL);

// 请求头里如果带机型（如 H5 页面的 UA），同步替换
const headers = $request.headers || {};
for (const k of Object.keys(headers)) {
  if (k.toLowerCase() === "user-agent") headers[k] = headers[k].replace(re, MODEL);
}

if (DEBUG) {
  const ua = (url.match(/[?&]ua=([^&]*)/) || [])[1];
  console.log("[weibo_device] " + $request.url.split("?")[0] + " changed=" + (url !== beforeUrl) + " ua=" + ua);
}

$done({ url, headers });
