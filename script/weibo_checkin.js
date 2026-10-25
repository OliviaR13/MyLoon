// 微博超话签到 for Loon（v2：按新版微博 App 抓包重写）
// 同一个脚本，按触发方式分工：
//   http-request（api.weibo.cn）  打开微博时保存登录状态；进入超话页时记录该超话
//   http-request（状态页域名）     visual 状态页：http://weibo-checkin.loon/
//   cron / generic               执行签到、推送汇总 / 推送当前状态
// 所有登录信息只保存在本机的 Loon 持久化存储里，不会出现在仓库或日志中。
// 参数：NOTIFY 通知开关，DEBUG 调试日志（日志不输出任何登录信息）

const AUTH_KEY = "MyLoon_WeiboCH_auth";
const STATE_KEY = "MyLoon_WeiboCH_state";
const HOST = "weibo-checkin.loon";
const PAGE = "http://" + HOST + "/";
const TITLE = "微博超话签到";
const MAX_PAGES = 30;
const DEADLINE_MS = 240000;
const KEEP_QS = ["aid", "b", "c", "dlang", "from", "ft", "gsid", "lang", "networktype", "s", "sflag", "skin", "ua", "v_f", "v_p", "wm"];
const KEEP_HD = ["authorization", "user-agent", "x-validator", "x-shanhai-pass", "x-sessionid", "x-log-uid", "x-log-level", "x-engine-type", "snrt", "cronet_rid", "accept", "accept-language"];
const ID_RE = /100808[0-9a-f]{10,}/i;

const arg = (typeof $argument === "object" && $argument) || {};
const notify = String(arg.NOTIFY) !== "false";
const debug = String(arg.DEBUG) === "true";
const log = (...a) => { if (debug) console.log("[weibo_checkin] " + a.join(" ")); };
const push = (sub, body) => { if (notify) $notification.post(TITLE, sub, body || "", { openUrl: PAGE, url: PAGE }); };
const sleep = (ms) => new Promise((r) => (typeof setTimeout === "function" ? setTimeout(r, ms) : r()));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 存取 ----------
const readJ = (k) => { try { return JSON.parse($persistentStore.read(k) || "null"); } catch (e) { return null; } };
const writeJ = (k, o) => $persistentStore.write(JSON.stringify(o), k);
const readState = () => Object.assign({ topics: {}, signed: { day: "", ids: {} }, login: {}, run: null, running: 0 }, readJ(STATE_KEY) || {});
const today = () => { const d = new Date(); return d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2); };

const pairsOf = (url) => (url.split("?")[1] || "").split("&").filter(Boolean);
const keyOf = (p) => p.split("=")[0];
const lowerKeys = (h) => { const o = {}; for (const k of Object.keys(h || {})) o[k.toLowerCase()] = h[k]; return o; };
const label = (id) => "超话 …" + id.slice(-6);

function learn(st, id) {
  if (!id || st.topics[id]) return false;
  st.topics[id] = { at: Date.now() };
  const ids = Object.keys(st.topics);
  if (ids.length > 300) delete st.topics[ids[0]];
  return true;
}

// ---------- 获取登录状态 / 记录超话 ----------
function capture() {
  const url = $request.url;
  const hd = lowerKeys($request.headers);
  const st = readState();
  let dirty = false;

  // 进入超话页（请求体里带超话 id）或点击签到时，记录该超话
  const body = typeof $request.body === "string" ? $request.body : "";
  const m = (/fid=(100808[0-9a-f]{10,})_-_feed/i.exec(body)) ||
    (/page_?id(?:=|%3D)(100808[0-9a-f]{10,})/i.exec(url));
  if (m) dirty = learn(st, m[1]) || dirty;

  // 只记录当前账号：当前账号的请求带 authorization 头
  const pairs = pairsOf(url);
  const gsid = (pairs.find((p) => /^gsid=/i.test(p)) || "").slice(5);
  const hasS = pairs.some((p) => /^s=/i.test(p));
  if (hd.authorization && gsid && hasS) {
    const old = readJ(AUTH_KEY);
    const same = old && old.gsid === gsid;
    if (!(same && Date.now() - old.at < 60000)) {
      const headers = {};
      for (const k of KEEP_HD) if (hd[k]) headers[k] = hd[k];
      writeJ(AUTH_KEY, {
        at: Date.now(), gsid, headers,
        pairs: pairs.filter((p) => KEEP_QS.indexOf(keyOf(p).toLowerCase()) !== -1),
      });
      const wasBad = !old || !same || st.login.state === "expired";
      st.login = { state: "ok", verified: st.login.verified || 0 };
      dirty = true;
      if (wasBad) push("登录状态已获取", "之后会按定时任务自动签到，点击查看状态页");
      log("已保存登录状态");
    }
  }
  if (dirty) writeJ(STATE_KEY, st);
}

// ---------- 网络 ----------
function get(url, headers) {
  return new Promise((resolve, reject) => {
    $httpClient.get({ url, headers, timeout: 15 }, (err, resp, data) => {
      if (err) return reject(new Error(String(err)));
      resolve({ status: resp && resp.status, body: data || "" });
    });
  });
}
const parse = (b) => { try { return JSON.parse(b); } catch (e) { return null; } };
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const isExpired = (status, j) => status === 401 || status === 403 || !!(j && j.result !== 1 && (
  Number(j.errno) === -100 || /login|token|登录|重新登/i.test(String(j.errmsg || j.error || j.msg || ""))));

// ---------- 超话列表 ----------
// 旧版列表接口（cardlist），失败时会退回到「访问过的超话」
function extractTopics(json) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    walk(node.cards); walk(node.card_group);
    const btn = (node.buttons || [])[0];
    if (!btn) return;
    const hay = JSON.stringify([btn, node.scheme]);
    if (!/^(签到|已签)/.test(String(btn.name || "")) && !/active_checkin/.test(hay)) return;
    const id = (ID_RE.exec(hay) || [])[0];
    if (!id) return;
    out.push({ id, name: node.title_sub || node.title || "", done: /已/.test(String(btn.name || "")) });
  };
  walk(json);
  return out;
}

async function fetchList(auth) {
  const topics = [];
  const seen = new Set();
  let sinceId = "", note = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    let url = "https://api.weibo.cn/2/cardlist?" + auth.pairs.join("&") + "&containerid=100803_-_followsuper";
    if (sinceId) url += "&since_id=" + encodeURIComponent(sinceId);
    const { status, body } = await get(url, auth.headers);
    const j = parse(body);
    if (isExpired(status, j)) throw Object.assign(new Error("expired"), { expired: true });
    if (!j) { note = "列表接口返回异常（HTTP " + status + "）"; break; }
    if (j.errmsg && !j.cards) { note = "列表接口：" + clean(j.errmsg); break; }
    let added = 0;
    for (const t of extractTopics(j)) {
      if (seen.has(t.id)) continue;
      seen.add(t.id); topics.push(t); added++;
    }
    const next = j.cardlistInfo && j.cardlistInfo.since_id;
    log("列表第 " + (page + 1) + " 页，新增 " + added);
    if (!next || String(next) === sinceId || !added) break;
    sinceId = String(next);
    await sleep(500);
  }
  return { topics, note };
}

// ---------- 单个超话签到 ----------
function judge(status, body) {
  const j = parse(body);
  if (!j) return { r: "fail", msg: "返回异常（HTTP " + status + "）" };
  const msg = clean(j.msg || j.errmsg || j.error || j.error_msg);
  const btn = clean(j.button && j.button.name);
  const ext = clean(j.ext_button && j.ext_button.name);
  if (Number(j.result) === 1) {
    let inner = "";
    try { inner = decodeURIComponent(String(j.scheme || "")); } catch (e) { inner = String(j.scheme || ""); }
    const exp = (/int_ins=(\d+)/.exec(inner) || [])[1];
    const streak = (/连签\s*(\d+)\s*天/.exec(btn) || [])[1] || (/check_count=(\d+)/.exec(inner) || [])[1];
    return { r: "ok", msg: msg || btn, exp: exp ? +exp : 0, streak: streak ? +streak : 0 };
  }
  if (isExpired(status, j)) return { r: "expired", msg: "登录已失效" };
  if (/已.{0,3}签|重复/.test(msg) || /已签/.test(ext)) return { r: "already", msg };
  return { r: "fail", msg: msg || "HTTP " + status };
}

async function checkin(auth, id) {
  const req = "http://i.chaohua.weibo.com/mobile/shproxy/active_checkin?in_page=1&lfid=232478_-_mine_topic&moment=&moment_date=&pageid=" +
    id + "&scene_id=page_header_checkin&sg_tab_config=2&sg_widget_state=0";
  const url = "https://api.weibo.cn/2/page/button?" + auth.pairs.join("&") +
    "&request_url=" + encodeURIComponent(req) +
    "&fid=" + id + "_-_feed&lfid=232478_-_mine_topic&luicode=10001387&uicode=10000011&featurecode=10000001&moduleID=pagecard&autoTranslate=0";
  for (let i = 0; i < 2; i++) {
    try {
      const { status, body } = await get(url, auth.headers);
      log(label(id) + " → HTTP " + status);
      return judge(status, body);
    } catch (e) {
      if (i === 1) return { r: "fail", msg: String(e.message || e) };
      await sleep(2000);
    }
  }
}

// ---------- 执行签到 ----------
async function run(trigger) {
  const auth = readJ(AUTH_KEY);
  const st = readState();
  if (!auth) {
    st.login = { state: "none" };
    writeJ(STATE_KEY, st);
    push("还没有登录状态", "打开一次微博 App 即可自动获取");
    return;
  }
  if (st.running && Date.now() - st.running < 300000) { log("上一次还在运行，跳过"); return; }
  st.running = Date.now();
  writeJ(STATE_KEY, st);

  const rec = { at: Date.now(), trigger, items: [], ok: 0, already: 0, fail: 0, skipped: 0, exp: 0, expired: false, listNote: "", listCount: 0 };
  try {
    let listed = [];
    try {
      const r = await fetchList(auth);
      listed = r.topics; rec.listNote = r.note; rec.listCount = listed.length;
    } catch (e) {
      if (e.expired) rec.expired = true; else rec.listNote = "列表接口：" + String(e.message || e);
    }

    // 合并：列表里的 + 访问过的超话
    const all = new Map();
    for (const t of listed) all.set(t.id, { id: t.id, name: t.name || label(t.id), done: t.done });
    rec.visited = 0;
    for (const id of Object.keys(st.topics)) if (!all.has(id)) { all.set(id, { id, name: label(id), done: false }); rec.visited++; }

    if (st.signed.day !== today()) st.signed = { day: today(), ids: {} };
    const start = Date.now();
    for (const t of all.values()) {
      if (rec.expired) break;
      if (t.done || st.signed.ids[t.id]) { rec.already++; rec.items.push({ name: t.name, st: "already", msg: "今日已签" }); st.signed.ids[t.id] = 1; continue; }
      if (Date.now() - start > DEADLINE_MS) { rec.skipped++; continue; }
      const res = await checkin(auth, t.id);
      if (res.r === "expired") { rec.expired = true; break; }
      if (res.r === "ok") { rec.ok++; rec.exp += res.exp || 0; st.signed.ids[t.id] = 1; }
      else if (res.r === "already") { rec.already++; st.signed.ids[t.id] = 1; }
      else rec.fail++;
      rec.items.push({ name: t.name, st: res.r, msg: res.msg, streak: res.streak, exp: res.exp });
      await sleep(1500 + Math.floor(Math.random() * 2000));
    }
  } finally {
    rec.total = rec.ok + rec.already + rec.fail + rec.skipped;
    rec.ms = Date.now() - rec.at;
    st.run = rec; st.running = 0;
    if (rec.expired) st.login = { state: "expired" };
    else st.login = { state: "ok", verified: Date.now() };
    writeJ(STATE_KEY, st);
  }

  if (rec.expired) { push("登录已失效", "请重新打开微博 App 刷新登录状态"); return; }
  if (!rec.total) { push("没有可签到的超话", rec.listNote || "请进入任意超话页一次，之后会自动记录"); return; }
  const head = "共 " + rec.total + " 个：成功 " + rec.ok + " · 已签 " + rec.already + " · 失败 " + rec.fail;
  const lines = [];
  if (rec.ok) lines.push("✅ 新签到 " + rec.ok + " 个" + (rec.exp ? "，经验 +" + rec.exp : ""));
  const bad = rec.items.filter((i) => i.st === "fail").slice(0, 4).map((i) => i.name + "（" + i.msg + "）");
  if (bad.length) lines.push("❌ " + bad.join("；"));
  if (rec.skipped) lines.push("⏱ 超时未处理 " + rec.skipped + " 个，下次继续");
  push(head, lines.join("\n"));
}

// ---------- 可视化状态页 ----------
function ago(t) {
  if (!t) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return Math.floor(s / 60) + " 分钟前";
  if (s < 86400) return Math.floor(s / 3600) + " 小时前";
  return Math.floor(s / 86400) + " 天前";
}
function loginView(auth, st) {
  if (!auth) return { cls: "bad", t: "未获取", d: "打开微博 App 即可自动获取" };
  if (st.login.state === "expired") return { cls: "warn", t: "疑似失效", d: "请重新打开微博 App 刷新" };
  if (Date.now() - auth.at > 7 * 86400000) return { cls: "warn", t: "较久未刷新", d: ago(auth.at) + "获取，建议打开一次微博" };
  return { cls: "ok", t: "有效", d: ago(auth.at) + "获取" + (st.login.verified ? " · " + ago(st.login.verified) + "验证通过" : "") };
}
function renderPage() {
  const auth = readJ(AUTH_KEY), st = readState(), lv = loginView(auth, st), r = st.run;
  const dot = { ok: "ok", already: "mute", fail: "bad" };
  let runHtml = '<p class="mute">还没有签到记录。点下面的「立即签到」试一次。</p>';
  if (r) {
    const tot = Math.max(1, r.ok + r.already + r.fail);
    const seg = (n, c) => (n ? '<i class="' + c + '" style="flex:' + n + '"></i>' : "");
    runHtml =
      '<div class="stats"><div><b class="okc">' + r.ok + '</b>成功</div><div><b>' + r.already + '</b>已签</div><div><b class="badc">' + r.fail + '</b>失败</div><div><b>' + (r.exp ? "+" + r.exp : "—") + '</b>经验</div></div>' +
      '<div class="bar">' + seg(r.ok, "ok") + seg(r.already, "mute") + seg(r.fail, "bad") + '</div>' +
      '<p class="sub">' + ago(r.at) + " · 用时 " + Math.round(r.ms / 1000) + " 秒 · " + (r.trigger === "cron" ? "定时" : "手动") +
      (r.skipped ? " · 超时未处理 " + r.skipped : "") + "</p>" +
      '<ul>' + r.items.map((i) => '<li><span class="d ' + (dot[i.st] || "warn") + '"></span><span class="n">' + esc(i.name) + '</span><span class="m">' +
        esc(i.st === "ok" ? (i.streak ? "连签 " + i.streak + " 天" : "签到成功") + (i.exp ? " · +" + i.exp : "") : i.msg) + "</span></li>").join("") + "</ul>";
  }
  const src = r ? "关注列表 " + r.listCount + " 个 · 访问记录 " + (r.visited || 0) + " 个" + (r.listNote ? "<br>" + esc(r.listNote) : "") : "访问记录 " + Object.keys(st.topics).length + " 个";
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>微博超话签到</title><style>' +
    ':root{--bg:#f2f2f7;--card:#fff;--tx:#111;--sub:#8a8a8e;--ok:#34c759;--bad:#ff3b30;--warn:#ff9f0a;--mute:#c7c7cc;--ln:#eee}' +
    '@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--tx:#f5f5f7;--sub:#98989d;--mute:#48484a;--ln:#2c2c2e}}' +
    '*{box-sizing:border-box}body{margin:0;padding:max(16px,env(safe-area-inset-top)) 16px 32px;background:var(--bg);color:var(--tx);font:15px/1.5 -apple-system,"PingFang SC",sans-serif}' +
    'main{max-width:560px;margin:0 auto}h1{font-size:24px;margin:8px 4px 16px}.card{background:var(--card);border-radius:16px;padding:16px;margin-bottom:12px}' +
    '.card h2{font-size:13px;color:var(--sub);font-weight:600;margin:0 0 10px}.row{display:flex;align-items:center;gap:10px}.pill{padding:2px 12px;border-radius:99px;color:#fff;font-weight:600}' +
    '.pill.ok{background:var(--ok)}.pill.bad{background:var(--bad)}.pill.warn{background:var(--warn)}.sub,.mute{color:var(--sub);font-size:13px}p{margin:6px 0}' +
    '.stats{display:flex;justify-content:space-between;text-align:center;color:var(--sub);font-size:12px}.stats b{display:block;font-size:26px;color:var(--tx)}.okc{color:var(--ok)!important}.badc{color:var(--bad)!important}' +
    '.bar{display:flex;height:8px;border-radius:4px;overflow:hidden;gap:2px;margin:12px 0 4px;background:var(--ln)}.bar i{display:block}i.ok,.d.ok{background:var(--ok)}i.bad,.d.bad{background:var(--bad)}i.mute,.d.mute{background:var(--mute)}.d.warn{background:var(--warn)}' +
    'ul{list-style:none;margin:8px 0 0;padding:0}li{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--ln)}.d{width:8px;height:8px;border-radius:50%;flex:none}.n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.m{color:var(--sub);font-size:12px;max-width:50%;text-align:right}' +
    '.btns{display:flex;gap:10px}.btns a{flex:1;text-align:center;padding:12px;border-radius:12px;background:var(--card);color:var(--tx);text-decoration:none;font-weight:600}.btns a.p{background:var(--ok);color:#fff}' +
    '</style></head><body><main><h1>微博超话签到</h1>' +
    '<div class="card"><h2>登录状态</h2><div class="row"><span class="pill ' + lv.cls + '">' + lv.t + '</span><span class="sub">' + esc(lv.d) + '</span></div></div>' +
    '<div class="card"><h2>最近一次签到</h2>' + runHtml + '</div>' +
    '<div class="card"><h2>超话来源</h2><p class="sub">' + src + '</p></div>' +
    '<div class="btns"><a class="p" href="/run">立即签到</a><a href="/">刷新</a></div>' +
    '<p class="sub" style="text-align:center;margin-top:16px">数据仅保存在本机 Loon 中</p></main></body></html>';
}
function serve() {
  const path = ($request.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]) || "/";
  const done = () => {
    if (path === "/run") $done({ response: { status: 302, headers: { Location: PAGE, "Cache-Control": "no-store" }, body: "" } });
    else $done({ response: { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, body: renderPage() } });
  };
  if (path === "/run") run("manual").catch((e) => log("run error " + e)).then(done); else done();
}

function statusNotify() {
  const auth = readJ(AUTH_KEY), st = readState(), lv = loginView(auth, st), r = st.run;
  const sum = r ? "成功 " + r.ok + " · 已签 " + r.already + " · 失败 " + r.fail + "（" + ago(r.at) + "）" : "还没有签到记录";
  $notification.post(TITLE, "登录：" + lv.t + "｜" + lv.d, sum, { openUrl: PAGE, url: PAGE });
  $done({ title: TITLE, content: "登录：" + lv.t + "\n" + sum, icon: lv.cls === "ok" ? "checkmark.seal.fill" : "exclamationmark.triangle.fill", "icon-color": lv.cls === "ok" ? "#34C759" : "#FF9F0A" });
}

// ---------- 入口 ----------
const S = (typeof $script !== "undefined" && $script) || {};
if (typeof $request !== "undefined" && $request) {
  if ($request.url.indexOf(HOST) !== -1) serve();
  else { try { capture(); } catch (e) { log("capture error: " + e); } $done({}); }
} else if (S.type === "generic" && /状态/.test(S.name || "")) {
  statusNotify();
} else {
  run(S.type === "cron" ? "cron" : "manual")
    .catch((e) => push("脚本出错", String((e && e.message) || e)))
    .then(() => $done());
}
