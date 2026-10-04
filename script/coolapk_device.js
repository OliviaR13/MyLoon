// 酷安来源机型：把请求 User-Agent 里的机型代号和机型名称换成所选机型
// 覆盖：发布动态（/v6/feed/createFeed）
// UA 片段格式：(#Build; Apple; iPhone18,1; iPhone 17 Pro; iOS_27.2)

const MODELS = {
  "iPhone 18 Pro Max": "iPhone19,7",
  "iPhone 18 Pro": "iPhone19,2",
  "iPhone Duo": "iPhone19,4",
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
const DEFAULT_NAME = "iPhone 18 Pro Max"; // 参数缺失或无法识别时使用

const arg = (typeof $argument === "object" && $argument) || {};
const enabled = String(arg.ENABLE) !== "false"; // 开关关闭时原样放行，参数缺失时默认开启
const name = MODELS[String(arg.MODEL == null ? "" : arg.MODEL).trim()] ? String(arg.MODEL).trim() : DEFAULT_NAME;
const id = MODELS[name];
const debug = String(arg.DEBUG) !== "false";

const path = $request.url.split("?")[0].replace(/^https?:\/\/[^/]+/, "");
let result = {};

if (!enabled) {
  if (debug) console.log("[coolapk_device] 来源机型已关闭，请求原样放行");
} else {
  // 只替换 (#Build; Apple; 代号; 名称; 里的代号和名称，其余部分保持不变
  const re = /(\(#Build;\s*Apple;\s*)iPhone\d+,\d+;\s*[^;)]+;/;
  const headers = $request.headers || {};
  let changed = false;
  let seg = "";
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "user-agent" && re.test(headers[k])) {
      const next = headers[k].replace(re, "$1" + id + "; " + name + ";");
      changed = next !== headers[k];
      headers[k] = next;
      seg = (next.match(/\(#Build;[^)]*\)/) || [])[0] || "";
    }
  }
  result = { headers };
  if (debug) console.log("[coolapk_device] " + path + " changed=" + changed + " " + seg);
}

$done(result);
