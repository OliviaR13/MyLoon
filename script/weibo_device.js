// 微博机型伪装：把请求里的 ua 机型标识换成所选机型
// 覆盖：来源列表（/2/device/*）和发博（/2/statuses/send|update|repost）
// MODEL 参数可以是下拉框里的机型名，也可以直接写标识（iPhone19,7 或 iPhone19.7）

const MODELS = {
  "iPhone 18 Pro Max": "iPhone19,7",      // 国际版（国行同属此标识）
  "iPhone 18 Pro Max 美版": "iPhone19,3",
  "iPhone 18 Pro": "iPhone19,2",
  "iPhone Duo": "iPhone19,4",           // 折叠屏，10 月 23 日发售
  "iPhone 17 Pro Max": "iPhone18,2",
  "iPhone 17 Pro": "iPhone18,1",
  "iPhone 17": "iPhone18,3",
  "iPhone Air": "iPhone18,4",
  "iPhone 17e": "iPhone18,5",
  "iPhone 16 Pro Max": "iPhone17,2",
  "iPhone 16 Pro": "iPhone17,1",
  "iPhone 16 Plus": "iPhone17,4",
  "iPhone 16": "iPhone17,3",
  "iPhone 16e": "iPhone17,5",
  "iPhone 15 Pro Max": "iPhone16,2",
  "iPhone 15 Pro": "iPhone16,1",
  "iPhone 15 Plus": "iPhone15,5",
  "iPhone 15": "iPhone15,4",
  "iPhone 14 Pro Max": "iPhone15,3",
  "iPhone 14 Pro": "iPhone15,2",
  "iPhone 14 Plus": "iPhone14,8",
  "iPhone 14": "iPhone14,7",
  "iPhone 13 Pro Max": "iPhone14,3",
  "iPhone 13 Pro": "iPhone14,2",
  "iPhone 13": "iPhone14,5",
  "iPhone 13 mini": "iPhone14,4",
  "iPhone 12 Pro Max": "iPhone13,4",
  "iPhone 12 Pro": "iPhone13,3",
  "iPhone 12": "iPhone13,2",
  "iPhone 12 mini": "iPhone13,1",
  "iPhone 11 Pro Max": "iPhone12,5",
  "iPhone 11 Pro": "iPhone12,3",
  "iPhone 11": "iPhone12,1"
};
const DEFAULT_MODEL = "iPhone19,7"; // 参数缺失或无法识别时使用

function resolveModel(v) {
  const s = String(v == null ? "" : v).trim();
  if (MODELS[s]) return MODELS[s];
  const id = s.replace(".", ",");
  return /^iPhone\d+,\d+$/.test(id) ? id : DEFAULT_MODEL;
}

const arg = (typeof $argument === "object" && $argument) || {};
const model = resolveModel(arg.MODEL);
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
