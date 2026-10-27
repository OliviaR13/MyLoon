/*
 * 微博超话签到 (Loon 3.5.1 build 983+)
 * 同一个脚本两种用法：
 *   1. Request Script：打开微博 App 任意页面时，抓取 gsid / s / from / c 等登录参数
 *   2. Cron Script：用已保存的参数拉取关注的超话并逐个签到
 */
const KEY = "weibo_chaohua_params";
const TITLE = "微博超话签到";
const DEBUG = !!($argument && typeof $argument === "object" && $argument.debug === true);
const log = (m) => console.log(typeof m === "string" ? m : JSON.stringify(m));

function parseQuery(url) {
  const o = {};
  (url.split("?")[1] || "").split("&").forEach((p) => {
    if (!p) return;
    const i = p.indexOf("=");
    o[i < 0 ? p : p.slice(0, i)] = i < 0 ? "" : p.slice(i + 1); // 保持原始编码
  });
  return o;
}
const qs = (o) => Object.keys(o).map((k) => k + "=" + o[k]).join("&");

/* ---------- 1. 抓取参数 ---------- */
if (typeof $request !== "undefined") {
  try {
    const q = parseQuery($request.url);
    if (q.gsid && q.s) {
      const h = $request.headers || {};
      const now = {
        gsid: q.gsid,
        s: q.s,
        from: q.from || "10D0095010",
        c: q.c || "iphone",
        aid: q.aid || "",
        ua: h["User-Agent"] || h["user-agent"] || "",
      };
      const old = $persistentStore.read(KEY);
      if (old !== JSON.stringify(now)) {
        $persistentStore.write(JSON.stringify(now), KEY);
        $notification.post(TITLE, "登录参数已更新", "之后会按 Cron 自动签到");
      }
    }
  } catch (e) {
    log("capture error: " + e);
  }
  $done({});
} else {
  /* ---------- 2. 定时签到 ---------- */
  main();
}

function get(url, ua) {
  return new Promise((resolve) => {
    $httpClient.get(
      { url, timeout: 10000, headers: { "User-Agent": ua || "Weibo" } },
      (err, resp, data) => {
        if (err) return resolve({ err: String(err) });
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        resolve({ status: resp && resp.status, json, raw: data });
      }
    );
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTopics(p) {
  const topics = [];
  const seen = {};
  for (let page = 1; page <= 30; page++) {
    const url =
      "https://api.weibo.cn/2/cardlist?" +
      qs({ gsid: p.gsid, s: p.s, from: p.from, c: p.c, aid: p.aid,
           containerid: "100803_-_followsuper", page: page, count: 20 });
    const r = await get(url, p.ua);
    if (DEBUG) log({ page, status: r.status, head: (r.raw || "").slice(0, 300) });
    if (r.err) throw new Error("网络错误: " + r.err);
    if (!r.json) throw new Error("返回不是 JSON，登录参数可能已失效");
    if (r.json.errno && !r.json.cards) throw new Error(r.json.errmsg || r.json.errno);
    let added = 0;
    (r.json.cards || []).forEach((card) => {
      (card.card_group || []).forEach((it) => {
        if (it.card_type !== "8") return;
        const name = it.title_sub || it.desc1 || "";
        const b = it.buttons && it.buttons[0];
        if (!name || seen[name]) return;
        seen[name] = 1;
        added++;
        topics.push({
          name,
          done: !b || b.name !== "签到",
          action: b && b.params && b.params.action,
        });
      });
    });
    if (!added) break;
    await sleep(500);
  }
  return topics;
}

async function checkin(p, t) {
  const url =
    "https://api.weibo.cn/2/page/button?" +
    qs({ gsid: p.gsid, s: p.s, from: p.from, c: p.c, aid: p.aid,
         request_url: encodeURIComponent(t.action) });
  const r = await get(url, p.ua);
  if (DEBUG) log({ topic: t.name, raw: (r.raw || "").slice(0, 300) });
  if (r.err) return { ok: false, msg: r.err };
  const j = r.json || {};
  const msg = j.msg || j.errmsg || "";
  const ok = String(j.result) === "1" || /签到成功|已签到/.test(msg);
  return { ok, msg: msg || (r.raw || "").slice(0, 60) };
}

async function main() {
  try {
    const saved = $persistentStore.read(KEY);
    if (!saved) {
      $notification.post(TITLE, "没有登录参数", "请先打开微博 App 随便刷新一下页面");
      return $done();
    }
    const p = JSON.parse(saved);
    const topics = await listTopics(p);
    if (!topics.length) {
      $notification.post(TITLE, "没有获取到超话列表", "可能参数失效，或接口已变化，开 debug=true 查看日志");
      return $done();
    }
    const todo = topics.filter((t) => !t.done && t.action);
    let okN = 0;
    const fails = [];
    for (const t of todo) {
      const r = await checkin(p, t);
      if (r.ok) okN++; else fails.push(t.name + "：" + r.msg);
      await sleep(1500);
    }
    const already = topics.length - todo.length;
    let body = "成功 " + okN + "，已签 " + already + "，失败 " + fails.length;
    if (fails.length) body += "\n" + fails.slice(0, 5).join("\n");
    $notification.post(TITLE, "共 " + topics.length + " 个超话", body);
  } catch (e) {
    $notification.post(TITLE, "执行失败", String(e && e.message || e));
  }
  $done();
}
