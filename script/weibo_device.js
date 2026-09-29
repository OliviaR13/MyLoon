// 改这里
const MODEL = "iPhone19,7";          // 设备标识
const NAME  = "iPhone 18 Pro Max";   // 显示名

const DEBUG = true;

let body = $request.body || "";
let url = $request.url;
let headers = $request.headers;

// 1) UA 里的机型，如 iPhone15,3__weibo__...
for (const k of Object.keys(headers)) {
  if (k.toLowerCase() === "user-agent") {
    headers[k] = headers[k].replace(/iPhone\d+,\d+/g, MODEL);
  }
}

// 2) 表单参数里的机型字段
const setParam = (str, key, val) => {
  const re = new RegExp("(^|&|\\?)(" + key + "=)[^&]*");
  return re.test(str) ? str.replace(re, "$1$2" + encodeURIComponent(val)) : str;
};
for (const key of ["device_name", "model", "machine"]) {
  body = setParam(body, key, NAME);
  url = setParam(url, key, NAME);
}
body = body.replace(/iPhone\d+(%2C|,)\d+/g, MODEL.replace(",", "%2C"));

if (DEBUG) console.log("weibo body: " + body.slice(0, 500));

$done({ url, headers, body });
