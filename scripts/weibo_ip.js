/*
 * weibo_ip.js —— 精确模式保险层
 * 清理响应体里残留的 region_name / ip_location 字段
 */

const FIELDS_TO_STRIP = ["region_name", "ip_location"];
const REMOVE_KEY = true; // false = 置空字符串而不是删字段

function stripIpFields(node) {
  if (Array.isArray(node)) {
    node.forEach(stripIpFields);
    return;
  }
  if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      if (FIELDS_TO_STRIP.includes(key)) {
        REMOVE_KEY ? delete node[key] : (node[key] = "");
      } else {
        stripIpFields(node[key]);
      }
    }
  }
}

function main() {
  const rawBody = $response.body;
  if (!rawBody) return $done({});

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (e) {
    return $done({}); // 非 JSON,原样放行
  }

  try {
    stripIpFields(data);
    $done({ body: JSON.stringify(data) });
  } catch (e) {
    $done({ body: rawBody }); // 出错不影响正常访问
  }
}

main();
