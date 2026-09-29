// 微博机型伪装：把请求里的 ua 机型标识换成指定机型
// 覆盖：来源列表（/2/device/*）和发博（/2/statuses/send|update|repost）
const DEFAULT_MODEL = "iPhone19,7"; // iPhone 18 Pro Max（国际版）

const arg = (typeof $argument === "object" && $argument) || {};
let model = String(arg.MODEL || "").replace(".", ",");
if (!/^iPhone\d+,\d+$/.test(model)) model = DEFAULT_MODEL; // 参数缺失或未替换时用默认值
const debug = String(arg.DEBUG) !== "false";

const url = $request.url;
const path = url.split("?")[0];
let result = {};

if (/\/2\/(device\/|statuses\/(send|update|repost))/.test(path)) {
  // URL 里的 ua 参数，保留后面的 __weibo__版本__iphone__系统
  const newUrl = url.replace(/([?&]ua=)iPhone\d+(?:,|%2C)\d+/i, "$1" + model);

  // 请求头里如果带机型（如 H5 页面的 UA），同步替换
  const headers = $request.headers || {};
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "user-agent") {
      headers[k] = headers[k].replace(/iPhone\d+(?:,|%2C)\d+/gi, model);
    }
  }

  result = { url: newUrl, headers };
  if (debug) {
    const ua = (newUrl.match(/[?&]ua=([^&]*)/) || [])[1];
    console.log("[weibo_device] " + path.replace(/^https?:\/\/[^/]+/, "") + " changed=" + (newUrl !== url) + " ua=" + ua);
  }
}

$done(result);
