/*
 * weibo_ip.js
 * 用于 Loon [Rewrite] script-response-body
 * 作用：递归遍历微博接口返回的 JSON，清除 / 隐藏 IP 归属地字段
 *
 * 已知微博会在以下位置携带 IP 归属地信息：
 *   - region_name        例如 "发布于 北京"
 *   - source（有时会拼接地区，不做处理，避免误删客户端来源）
 *   - user.ip_location / user.region_name（部分接口）
 *
 * 可按需增删 FIELDS_TO_STRIP 里的字段名。
 */

const FIELDS_TO_STRIP = ["region_name", "ip_location"];

// 是否完全删除字段（true），还是替换为空字符串保留字段但不显示内容（false）
const REMOVE_KEY = true;

function stripIpFields(node) {
  if (Array.isArray(node)) {
    for (const item of node) stripIpFields(item);
    return;
  }
  if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      if (FIELDS_TO_STRIP.includes(key)) {
        if (REMOVE_KEY) {
          delete node[key];
        } else {
          node[key] = "";
        }
        continue;
      }
      stripIpFields(node[key]);
    }
  }
}

function main() {
  const rawBody = $response.body;
  if (!rawBody) {
    $done({});
    return;
  }

  let data;
  try {
    data = JSON.parse(rawBody);
  } catch (e) {
    // 非 JSON 响应（例如 html / 图片占位），原样放行
    $done({});
    return;
  }

  try {
    stripIpFields(data);
  } catch (e) {
    // 出错时不影响正常访问，原样放行
    $done({ body: rawBody });
    return;
  }

  $done({ body: JSON.stringify(data) });
}

main();
