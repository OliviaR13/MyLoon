// 参数来自插件，缺省值在这里
const arg = (typeof $argument === "object" && $argument) || {};
const MODEL = String(arg.MODEL || "iPhone19.7").replace(".", ",");
const NAME  = String(arg.NAME  || "iPhone 18 Pro Max");
const DEBUG = String(arg.DEBUG) !== "false";

let url = $request.url;
let headers = $request.headers || {};
let body = $request.body || "";

const enc = encodeURIComponent;

// 1) UA 里的机型标识
for (const k of Object.keys(headers)) {
  if (k.toLowerCase() === "user-agent") {
    headers[k] = headers[k].replace(/iPhone\d+,\d+/g, MODEL);
  }
}

// 2) 表单/查询参数里的机型字段
const setParam = (str, key, val) => {
  const re = new RegExp("(^|[?&])(" + key + "=)[^&]*");
  return re.test(str) ? str.replace(re, "$1$2" + enc(val)) : str;
};
for (const key of ["device_name", "model", "machine"]) {
  body = setParam(body, key, NAME);
  url  = setParam(url, key, NAME);
}

// 3) 其他位置出现的机型标识
body = body.replace(/iPhone\d+(%2C|,)\d+/g, enc(MODEL));

if (DEBUG) console.log("[weibo_device] url=" + url + "\nbody=" + body.slice(0, 500));

$done({ url, headers, body });
