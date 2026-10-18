// 微博「我」页会员区开关
// 作用于：/2/profile/me 的响应。MEMBER 为 true（默认）时原样放行；为 false 时把「我」页里的会员 / VVIP 区块从 JSON 里删掉。
// 参数（Loon 以对象形式传入 $argument）：
//   MEMBER  是否显示会员区，"true" / "false"（也接受布尔值），缺省按 true 处理
//   DEBUG   是否在 Loon 日志里打印被删掉的区块的文字，用来排查「该删的没删」或「误删」
//
// 怎么认出会员区：自上而下走一遍 JSON，凡是数组里的某个元素，它自身（向下最多 3 层）的短文字里出现了下面 KEYWORDS 里的任一短语，
// 就把这个元素整个从数组里删掉；先处理子元素再判断父元素，所以删掉的是「最里面那个包着关键词的元素」，不会把整页一起删掉。
// 注意：本脚本是对着页面上看到的文字写的，没有拿到过 /profile/me 的真实 JSON；如果开了开关却没删掉，
// 把 DEBUG 打开、在 Loon 日志里看有没有「删除」记录，没有的话说明关键词没对上，把日志或响应体发来再改 KEYWORDS 即可。

const KEYWORDS = [
  "创作者经营会员",
  "会员登录获额外成长",
  "VVIP中心",
  "VVIP 中心",
];
const MAX_DEPTH = 3; // 判断一个元素时，向下看几层
const MAX_LEN = 40;  // 只看不长于这个长度的字符串，长文本（微博正文等）不参与判断

const arg = (typeof $argument === "object" && $argument) || {};
const truthy = (v) => v === true || String(v).trim().toLowerCase() === "true";
const showMember = arg.MEMBER === undefined || arg.MEMBER === "" ? true : truthy(arg.MEMBER);
const debug = truthy(arg.DEBUG);

function texts(node, depth, out) {
  if (out.length > 60) return out;
  if (typeof node === "string") {
    if (node.length <= MAX_LEN) out.push(node);
  } else if (depth > 0 && node && typeof node === "object") {
    for (const k of Object.keys(node)) texts(node[k], depth - 1, out);
  }
  return out;
}

const isMember = (el) => {
  if (!el || typeof el !== "object") return false;
  const hit = texts(el, MAX_DEPTH, []).find((s) => KEYWORDS.some((w) => s.includes(w)));
  return hit === undefined ? null : hit;
};

let removed = 0;
function prune(node) {
  if (Array.isArray(node)) {
    /* 子元素里删过东西、并且因此变成空容器的（比如只装着会员横幅的一组），整个容器也删掉，免得页面上留一块空白 */
    const emptied = new Set();
    for (const el of node) {
      const before = removed;
      prune(el);
      if (removed > before && el && Array.isArray(el.items) && el.items.length === 0) emptied.add(el);
    }
    for (let i = node.length - 1; i >= 0; i--) {
      const hit = emptied.has(node[i]) ? "（空容器）" : isMember(node[i]);
      if (hit !== null && hit !== false) {
        if (debug) console.log(`[weibo_member] 删除：${hit}`);
        node.splice(i, 1);
        removed++;
      }
    }
  } else if (node && typeof node === "object") {
    for (const k of Object.keys(node)) prune(node[k]);
  }
}

if (showMember || !$response || !$response.body) {
  $done({});
} else {
  try {
    const data = JSON.parse($response.body);
    prune(data);
    if (debug) console.log(`[weibo_member] 共删除 ${removed} 个区块`);
    $done(removed ? { body: JSON.stringify(data) } : {});
  } catch (e) {
    if (debug) console.log(`[weibo_member] 解析失败：${e}`);
    $done({});
  }
}
