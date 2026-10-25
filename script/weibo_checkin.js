// 微博超话签到 for Loon
// 两种运行方式（同一个脚本）：
//   1) http-request：打开微博 App 的「超话」页面时，自动保存登录参数（不改动请求）
//   2) cron：定时读取已关注的超话并逐个签到，完成后推送汇总
// 参数（来自插件）：NOTIFY 签到通知开关；DEBUG 调试日志开关

const KEY = "MyLoon_WeiboCH";
const TITLE = "微博超话签到";
const MAX_PAGES = 30;       // 关注列表最多翻页数
const GAP_MS = 1200;        // 两次签到之间的间隔
const DEADLINE_MS = 240000; // 超过此时长不再继续签到（cron timeout 为 300s）

const arg = (typeof $argument === "object" && $argument) || {};
const notify = String(arg.NOTIFY) !== "false";
const debug = String(arg.DEBUG) === "true";
const log = (...a) => { if (debug) console.log("[weibo_checkin] " + a.join(" ")); };
const push = (sub, body) => { if (notify) $notification.post(TITLE, sub, body || ""); };

const sleep = (ms) => new Promise((r) => (typeof setTimeout === "function" ? setTimeout(r, ms) : r()));

// ---------- 存取 ----------
function load() {
  try { return JSON.parse($persistentStore.read(KEY) || "null"); } catch (e) { return null; }
}
function save(o) { return $persistentStore.write(JSON.stringify(o), KEY); }

// ---------- 方式一：获取登录参数 ----------
function capture() {
  const url = $request.url;
  const qs = url.split("?")[1] || "";
  // 保留原始（已编码）的参数，去掉翻页和列表相关的几项
  const DROP = /^(containerid|since_id|page|request_url)$/i;
  const pairs = qs.split("&").filter((p) => p && !DROP.test(p.split("=")[0]));
  const gsid = (pairs.find((p) => /^gsid=/i.test(p)) || "").slice(5);

  if (!gsid) {
    log("请求里没有 gsid，跳过");
    return;
  }
  const headers = $request.headers || {};
  const uaKey = Object.keys(headers).find((k) => k.toLowerCase() === "user-agent");
  const old = load();
  save({ pairs, ua: uaKey ? headers[uaKey] : "", at: Date.now() });

  if (!old || !old.pairs || old.pairs.indexOf("gsid=" + gsid) === -1) {
    push("登录参数获取成功", "之后会按定时任务自动签到");
  }
  log("已保存登录参数，参数个数=" + pairs.length);
}

// ---------- 网络 ----------
function get(url, ua) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: "*/*" };
    if (ua) headers["User-Agent"] = ua;
    $httpClient.get({ url, headers, timeout: 15 }, (err, resp, data) => {
      if (err) return reject(new Error(String(err)));
      resolve({ status: resp && resp.status, body: data || "" });
    });
  });
}
function parse(body) { try { return JSON.parse(body); } catch (e) { return null; } }

const isExpired = (status, j) =>
  status === 401 || status === 403 ||
  !!(j && (Number(j.errno) === -100 || /login|token|登录|重新登/i.test(String(j.errmsg || j.error || j.msg || ""))));

// ---------- 关注的超话列表 ----------
function extractTopics(json) {
  const out = [];
  const walk = (cards) => {
    for (const c of cards || []) {
      if (c.card_group) walk(c.card_group);
      const btn = (c.buttons || [])[0];
      if (!btn) continue;
      const action = (btn.params && btn.params.action) || "";
      const name = String(btn.name || "");
      if (!/active_checkin/.test(action) && !/^(签到|已签)/.test(name)) continue;

      let pageid = (/pageid=(\w+)/.exec(action) || [])[1];
      if (!pageid) pageid = (/containerid=(100808\w+)/.exec(c.scheme || "") || [])[1];
      if (!pageid) continue;

      out.push({
        pageid,
        name: c.title_sub || c.title || pageid,
        done: name.indexOf("已") !== -1,
        action: /^https?:\/\//.test(action) && /active_checkin/.test(action) ? action : "",
      });
    }
  };
  walk(json && json.cards);
  return out;
}

async function fetchTopics(saved) {
  const base = saved.pairs.join("&");
  const topics = [];
  const seen = new Set();
  let sinceId = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    let url = "https://api.weibo.cn/2/cardlist?" + base + "&containerid=100803_-_followsuper";
    if (sinceId) url += "&since_id=" + encodeURIComponent(sinceId);
    const { status, body } = await get(url, saved.ua);
    const j = parse(body);
    if (isExpired(status, j)) throw Object.assign(new Error("expired"), { expired: true });
    if (!j) throw new Error("列表返回内容无法解析（HTTP " + status + "）");

    let added = 0;
    for (const t of extractTopics(j)) {
      if (seen.has(t.pageid)) continue;
      seen.add(t.pageid);
      topics.push(t);
      added++;
    }
    const next = j.cardlistInfo && j.cardlistInfo.since_id;
    log("第 " + (page + 1) + " 页，新增 " + added + " 个，since_id=" + next);
    if (!next || String(next) === String(sinceId) || !added) break;
    sinceId = String(next);
    await sleep(400);
  }
  return topics;
}

// ---------- 单个超话签到 ----------
function judge(status, body) {
  const j = parse(body);
  if (isExpired(status, j)) return { r: "expired", msg: "登录已失效" };
  const d = (j && j.data) || {};
  const msg = String(
    (j && (j.msg || j.errmsg || j.error_msg || j.error)) || d.alert_title || d.msg || ""
  ).replace(/\s+/g, " ").trim();

  if (j && Number(j.result) === 1) return { r: "ok", msg };
  if (/今[日天].{0,3}已.{0,2}签|已经签到|已签到过|重复签到/.test(msg)) return { r: "already", msg };
  if (/签到成功/.test(msg) || /签到成功/.test(String(d.alert_title || ""))) return { r: "ok", msg };
  return { r: "fail", msg: msg || "HTTP " + status + " " + body.slice(0, 60) };
}

async function checkin(saved, t) {
  const reqUrl = t.action ||
    "http://i.huati.weibo.com/mobile/super/active_checkin?pageid=" + t.pageid + "&in_page=1";
  const url = "https://api.weibo.cn/2/page/button?request_url=" + encodeURIComponent(reqUrl) +
    "&" + saved.pairs.join("&");
  for (let i = 0; i < 2; i++) {
    try {
      const { status, body } = await get(url, saved.ua);
      log(t.name + " → HTTP " + status + " " + body.slice(0, 120));
      return judge(status, body);
    } catch (e) {
      if (i === 1) return { r: "fail", msg: String(e.message || e) };
      await sleep(2000);
    }
  }
}

// ---------- 方式二：定时签到 ----------
async function run() {
  const saved = load();
  if (!saved || !saved.pairs || !saved.pairs.length) {
    push("还没有登录参数", "请先打开微博 App → 超话页，保存一次登录参数");
    return;
  }

  let topics;
  try {
    topics = await fetchTopics(saved);
  } catch (e) {
    if (e.expired) push("登录已失效", "请重新打开微博 App 的超话页面，更新登录参数");
    else push("获取超话列表失败", String(e.message || e));
    return;
  }
  if (!topics.length) {
    push("没有找到关注的超话", "请确认账号已关注超话；若确实有，把 DEBUG 打开后看日志");
    return;
  }

  const start = Date.now();
  const ok = [], already = [], fail = [];
  let skipped = 0, expired = false;
  for (const t of topics) {
    if (t.done) { already.push(t.name); continue; }
    if (Date.now() - start > DEADLINE_MS) { skipped++; continue; }
    const res = await checkin(saved, t);
    if (res.r === "expired") { expired = true; break; }
    if (res.r === "ok") ok.push(t.name);
    else if (res.r === "already") already.push(t.name);
    else fail.push(t.name + "（" + res.msg + "）");
    await sleep(GAP_MS);
  }

  if (expired) {
    push("登录已失效", "已签 " + (ok.length + already.length) + " 个后中断，请重新打开超话页面更新登录参数");
    return;
  }
  const head = "共 " + topics.length + " 个：成功 " + ok.length + " · 已签 " + already.length + " · 失败 " + fail.length;
  const lines = [];
  if (ok.length) lines.push("✅ " + ok.slice(0, 8).join("、") + (ok.length > 8 ? " 等" : ""));
  if (fail.length) lines.push("❌ " + fail.slice(0, 5).join("；") + (fail.length > 5 ? " 等" : ""));
  if (skipped) lines.push("⏱ 超时未处理 " + skipped + " 个，下次继续");
  push(head, lines.join("\n"));
  log(head);
}

// ---------- 入口 ----------
if (typeof $request !== "undefined" && $request) {
  try { capture(); } catch (e) { log("capture error: " + e); }
  $done({});
} else {
  run().catch((e) => { push("脚本出错", String(e && e.message || e)); }).then(() => $done());
}
