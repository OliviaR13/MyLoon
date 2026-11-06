// 微博超话签到 for Loon（v2：按新版微博 App 抓包重写）
// 同一个脚本，按触发方式分工：
//   http-request（api.weibo.cn）  打开微博时（后台查未读数的请求）触发补签；不再保存任何 App 登录信息
//   http-request（状态页域名）     visual 状态页：http://weibo-checkin.loon/
//   cron / generic               执行签到、推送汇总 / 推送当前状态
// 所有登录信息只保存在本机的 Loon 持久化存储里，不会出现在仓库或日志中。
// 文件位置：script/weibo/weibo_checkin.js（与 weibo_device.js 同放在 script/weibo/ 下）
// 参数：CHECKIN 签到总开关，NOTIFY 通知开关，DEBUG 调试日志（日志不输出任何登录信息）
// 状态页（单页控制台）：总览 / 超话 / 记录 / 设置，四个区域用 # 切换；数据接口：/api/state、/api/topics、/api/history、/api/refresh，进度接口：/run/progress

const AUTH_KEY = "MyLoon_WeiboCH_auth";
const STATE_KEY = "MyLoon_WeiboCH_state";
const PREF_KEY = "MyLoon_WeiboCH_prefs"; // 状态页里的偏好（跳过哪些超话），只保存在本机
const PROG_KEY = "MyLoon_WeiboCH_prog"; // 签到进度（只保存在本机），状态页轮询它来显示「正在签哪个超话」
const WEB_KEY = "MyLoon_WeiboCH_web"; // 网页版登录（扫码获得的 Cookie），只保存在本机
const LOG_KEY = "MyLoon_WeiboCH_log"; // 签到记录（最近 30 次任务：超话名称、结果、失败原因），只保存在本机
const TL_KEY = "MyLoon_WeiboCH_tl"; // 上次读到的关注超话列表（名称、头像），只保存在本机
const LOCK_KEY = "MyLoon_WeiboCH_lock"; // 任务锁：手动、定时、打开微博补签共用
const CSRF_KEY = "MyLoon_WeiboCH_csrf"; // 状态页里危险操作用的一次性口令
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36";
const HOST = "weibo-checkin.loon";
const PAGE = "http://" + HOST + "/";
const TITLE = "微博超话签到";
const MAX_PAGES = 30;
const DEADLINE_MS = 240000;
const KEEP_QS = ["aid", "b", "c", "dlang", "from", "ft", "gsid", "lang", "networktype", "s", "sflag", "skin", "ua", "v_f", "v_p", "wm"];
const KEEP_HD = ["authorization", "user-agent", "x-validator", "x-shanhai-pass", "x-sessionid", "x-log-uid", "x-log-level", "x-engine-type", "snrt", "cronet_rid", "accept", "accept-language"];
const ID_RE = /100808[0-9a-f]{10,}/i;

const arg = (typeof $argument === "object" && $argument) || {};
const enabled = String(arg.CHECKIN) !== "false"; // 插件里的「超话签到」总开关
const notify = String(arg.NOTIFY) !== "false";
const debug = String(arg.DEBUG) === "true";
const tm = /^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})\s*$/.exec(String(arg.TIME || "08:10"));
const hhmm = (m) => ("0" + Math.floor(m / 60)).slice(-2) + ":" + ("0" + (m % 60)).slice(-2);
const ARG_SCHED = tm ? Math.min(23, +tm[1]) * 60 + Math.min(59, +tm[2]) : 8 * 60 + 10; // 插件里设置的签到时间（分钟数）
const SCHED_DEFAULT_TEXT = hhmm(ARG_SCHED);
let SCHED = ARG_SCHED, SCHED_TEXT = SCHED_DEFAULT_TEXT; // 每天几点开始自动签到；状态页里自定义过的时间优先（见 applySched）
const log = (...a) => { if (debug) console.log("[weibo_checkin] " + a.join(" ")); };
const push = (sub, body) => { if (notify) $notification.post(TITLE, sub, body || "", { openUrl: PAGE, url: PAGE }); };
// 分类通知：kind = ok（有新签到成功）/ fail（失败、未确认、登录失效）/ done（任务完成汇总）；状态页「设置 → 通知」里可以分别关闭
const pushK = (kind, sub, body) => { if (!notify || readPrefs().n[kind] === false) return; $notification.post(TITLE, sub, body || "", { openUrl: PAGE, url: PAGE }); };
const sleep = (ms) => new Promise((r) => (typeof setTimeout === "function" ? setTimeout(r, ms) : r()));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 存取 ----------
const readJ = (k) => { try { return JSON.parse($persistentStore.read(k) || "null"); } catch (e) { return null; } };
const writeJ = (k, o) => $persistentStore.write(JSON.stringify(o), k);
// 删除一个 Key：文档要求用 undefined；个别运行时不认就退回写空串（readJ 能处理空串）
const del = (k) => { $persistentStore.write(undefined, k); if ($persistentStore.read(k)) $persistentStore.write("", k); };
const readState = () => Object.assign({ topics: {}, signed: { day: "", ids: {} }, login: {}, run: null, running: 0, hist: {}, last: {} }, readJ(STATE_KEY) || {});
// 偏好：跳过列表、自动签到开关与自定义时间、是否自动获取列表、三类通知开关（都只保存在本机，缺省值与旧版行为一致）
const readPrefs = () => {
  const p = readJ(PREF_KEY) || {}, n = (p.n && typeof p.n === "object") ? p.n : {};
  return { skip: (p.skip && typeof p.skip === "object") ? p.skip : {}, auto: p.auto !== false, fetch: p.fetch !== false, time: /^\d{2}:\d{2}$/.test(p.time || "") ? p.time : "", n: { ok: n.ok !== false, fail: n.fail !== false, done: n.done !== false } };
};
function applySched() { const p = readPrefs(); if (p.time) { const m = p.time.split(":"); SCHED = Math.min(23, +m[0]) * 60 + Math.min(59, +m[1]); } else SCHED = ARG_SCHED; SCHED_TEXT = hhmm(SCHED); }
const today = () => { const d = new Date(); return d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2); };
const ymd = (t) => { const d = new Date(t); return d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2); };

const pairsOf = (url) => (url.split("?")[1] || "").split("&").filter(Boolean);
const keyOf = (p) => p.split("=")[0];
const lowerKeys = (h) => { const o = {}; for (const k of Object.keys(h || {})) o[k.toLowerCase()] = h[k]; return o; };
const label = (id) => "超话 …" + id.slice(-6);



// ---------- 网络 ----------
let gotResponse = false; // 本次是否收到过服务器的任何响应（用来判断登录状态是否真的验证过）
function get(url, headers, opt) {
  const o = opt || {};
  const sec = o.timeout || 20;
  return new Promise((resolve, reject) => {
    let fin = false;
    const timer = typeof setTimeout === "function" ? setTimeout(() => { if (!fin) { fin = true; reject(new Error("脚本等待 " + sec + " 秒无响应")); } }, sec * 1000) : null;
    const req = { url, headers, timeout: sec * 1000 }; // Loon 的 timeout 按毫秒算，传秒数会瞬间超时
    if (o.body != null) req.body = o.body;
    $httpClient[o.method === "POST" ? "post" : "get"](req, (err, resp, data) => {
      if (fin) return;
      fin = true;
      if (timer && typeof clearTimeout === "function") clearTimeout(timer);
      if (err) return reject(new Error(String(err).replace(/^HTTPClient request failed with error:/, "").slice(0, 120)));
      gotResponse = true;
      resolve({ status: resp && resp.status, body: data || "", headers: (resp && resp.headers) || {} });
    });
  });
}
const parse = (b) => { try { return JSON.parse(b); } catch (e) { return null; } };
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const isExpired = (status, j) => status === 401 || status === 403 || !!(j && j.result !== 1 && (
  Number(j.errno) === -100 || /login|token|登录|重新登/i.test(String(j.errmsg || j.error || j.msg || ""))));

// ---------- 超话列表 ----------
// ---------- 单个超话签到 ----------
function judge(status, body) {
  const j = parse(body);
  if (!j) return { r: status >= 400 ? "fail" : "unknown", msg: "返回异常（HTTP " + status + "）" };
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
  // 走到这里：没有成功标志。有明确失败信息 / 业务标志 / HTTP 错误才算失败，说不清的归为「状态未知」
  if (msg) return { r: "fail", msg };
  if (j.result !== undefined) return { r: "fail", msg: "result=" + j.result };
  if (status >= 400) return { r: "fail", msg: "HTTP " + status };
  return { r: "unknown", msg: "响应无法识别（没有成功或失败标志）" };
}


// ---------- 网页版：扫码登录 + 网页接口（取超话列表、签到） ----------
const jsonp = (t) => {
  const m = /^[^(]*\(([\s\S]*)\)[^)]*$/.exec(String(t || "").trim());
  try { return JSON.parse(m ? m[1] : t); } catch (e) { return null; }
};
function pickCookies(h, names) {
  let raw = "";
  for (const k of Object.keys(h || {})) if (k.toLowerCase() === "set-cookie") raw += "\n" + [].concat(h[k]).join("\n");
  const out = {};
  for (const n of names) { // 取最后一个有效值（旧的会被置为 deleted）
    const re = new RegExp("(?:^|[\\s,;])" + n + "=([^;,\\s]+)", "g");
    let m;
    while ((m = re.exec(raw))) if (m[1] !== "deleted") out[n] = m[1];
  }
  return out;
}
const sinaH = { Referer: "https://weibo.com/", "User-Agent": WEB_UA };
const webHeaders = (web, referer) => ({ Cookie: web.cookie, Referer: referer, "User-Agent": WEB_UA });
const webExpired = (status, body, j) => status === 401 || status === 403 ||
  !!(j && (Number(j.ok) === -100 || /login\.php|visitor/.test(String(j.url || "")))) ||
  (!j && /passport\.weibo\.com\/visitor|login\.php|<title>[^<]*登录/i.test(String(body).slice(0, 4000)));

const safePic = (u) => { u = String(u || ""); if (u.indexOf("//") === 0) u = "https:" + u; return /^https:\/\/[\w.-]+\.(sinaimg\.cn|weibo\.cn|weibo\.com)\//i.test(u) ? u : ""; };
async function fetchListWeb(web) {
  const topics = [], seen = new Set();
  let note = "", maxPage = 1, complete = false;
  for (let page = 1; page <= Math.min(maxPage, MAX_PAGES); page++) {
    const { status, body } = await get("https://weibo.com/ajax/profile/topicContent?tabid=231093_-_chaohua&page=" + page, webHeaders(web, "https://weibo.com/"), { timeout: 15 });
    const j = parse(body);
    if (webExpired(status, body, j)) throw Object.assign(new Error("expired"), { expired: true });
    if (!j || !j.data) { note = "网页列表返回异常（HTTP " + status + "）"; break; }
    maxPage = Number(j.data.max_page) || 1;
    let added = 0;
    for (const it of j.data.list || []) {
      const id = String(it.oid || "").split(":").pop();
      if (!/^\w{10,}$/.test(id) || seen.has(id)) continue;
      seen.add(id); topics.push({ id, name: it.title || label(id), pic: safePic(it.pic || it.pic_url || it.icon || it.avatar || it.image), done: false }); added++;
    }
    log("网页列表第 " + page + "/" + maxPage + " 页，新增 " + added);
    if (page >= maxPage) { complete = true; break; } // 最后一页也读完了
    if (!added) { note = "第 " + page + " 页没有新内容，列表可能不完整"; break; }
    await sleep(400);
  }
  if (!complete && !note && maxPage > MAX_PAGES) note = "超话页数超过 " + MAX_PAGES + " 页上限，列表可能不完整";
  if (!topics.length && !note) note = "网页列表里没有关注的超话";
  return { topics, note, src: "web", complete };
}

function judgeWeb(status, body) {
  const j = parse(body);
  if (webExpired(status, body, j)) return { r: "expired", msg: "登录已失效" };
  if (!j) return { r: status >= 400 ? "fail" : "unknown", msg: "返回异常（HTTP " + status + "）" };
  const d = j.data || {};
  const txt = clean([j.msg, d.alert_title, d.alert_subtitle, String(d.tipMessage || "").replace(/<[^>]+>/g, " ")].join(" "));
  const em = /(\d+)\s*点?经验|经验值?\s*\+?\s*(\d+)|\+\s*(\d+)/.exec(txt);
  const exp = em && (em[1] || em[2] || em[3]);
  const rank = (/第\s*(\d+)\s*名/.exec(txt) || [])[1];
  if (/签到成功/.test(txt)) return { r: "ok", msg: txt, exp: exp ? +exp : 0, rank };
  if (/已签到|已经签到|今天已|重复/.test(txt)) return { r: "already", msg: txt };
  if (String(j.code) === "100000") return { r: "ok", msg: txt, exp: exp ? +exp : 0, rank };
  if (status >= 400) return { r: "fail", msg: txt || "HTTP " + status };
  if (txt || j.code !== undefined) return { r: "fail", msg: txt || "code " + j.code };
  return { r: "unknown", msg: "响应无法识别（没有成功或失败标志）" };
}

async function checkinWeb(web, id) {
  const url = "https://weibo.com/p/aj/general/button?ajwvr=6&api=http://i.huati.weibo.com/aj/super/checkin&status=0&location=page_100808_super_index&id=" + id;
  for (let i = 0; i < 2; i++) {
    try {
      const { status, body } = await get(url, webHeaders(web, "https://weibo.com/p/" + id), { timeout: 15 });
      log(label(id) + " → HTTP " + status);
      return judgeWeb(status, body);
    } catch (e) {
      if (i === 1) return { r: "fail", msg: String(e.message || e) };
      await sleep(2000);
    }
  }
}

// 扫码登录：1 申请二维码 → 2 在微博 App 里确认 → 3 轮询并换取网页 Cookie
async function loginStart() {
  const { body } = await get("https://login.sina.com.cn/sso/qrcode/image?entry=sinawap&size=180&callback=STK_1", sinaH, { timeout: 15 });
  const j = jsonp(body);
  if (!j || !j.data || !j.data.qrid) throw new Error("没有拿到二维码（新浪登录接口无响应）");
  const st = readState();
  st.qr = { id: j.data.qrid, image: j.data.image || "", at: Date.now() };
  writeJ(STATE_KEY, st);
  return loginPage(st.qr);
}

async function exchangeLogin(alt) {
  const r1 = await get("https://login.sina.com.cn/sso/login.php?entry=sinawap&returntype=TEXT&crossdomain=1&cdult=3&domain=weibo.cn&alt=" + encodeURIComponent(alt) + "&savestate=30&callback=STK_3", sinaH, { timeout: 15 });
  const j1 = jsonp(r1.body);
  const u = ((j1 && j1.crossDomainUrlList) || []).find((x) => String(x).indexOf("https://passport.weibo.com") === 0);
  if (!u) return { s: "fail", msg: "换取登录信息失败，请重新获取二维码" };
  const r2 = await get(u, sinaH, { timeout: 15 });
  const j2 = jsonp(r2.body);
  const ck = pickCookies(r2.headers, ["SUBP", "ALF", "SUB", "SCF"]);
  if (!ck.SUB) return { s: "fail", msg: "没有拿到网页登录 Cookie，请重新获取二维码" };
  const ui = (j2 && j2.userinfo) || {}, uid = String(ui.uniqueid || ui.uid || ui.userid || ""), nick = ui.displayname || "";
  writeJ(WEB_KEY, {
    cookie: Object.keys(ck).map((k) => k + "=" + ck[k]).join("; "),
    at: Date.now(), nick, uid,
  });
  const st = readState(), who = uid || nick;
  let switched = false;
  if (who && st.acct && st.acct !== who) { // 换了账号：旧账号的签到记录、跳过设置都不再适用，清掉避免混用
    switched = true;
    st.run = null; st.hist = {}; st.signed = { day: "", ids: {} }; st.auto = null;
    { const p0 = readPrefs(); p0.skip = {}; writeJ(PREF_KEY, p0); }
    st.last = {}; del(LOG_KEY); del(TL_KEY);
  }
  if (who) st.acct = who;
  st.qr = null; st.login = { state: "ok", verified: Date.now(), route: "web" };
  writeJ(STATE_KEY, st);
  return { s: "ok", msg: switched ? "登录成功，已切换账号，旧账号的记录已清除" : "登录成功" };
}

async function loginCheck() {
  const st = readState();
  if (!st.qr) return { s: "fail", msg: "请先获取二维码" };
  const { body } = await get("https://login.sina.com.cn/sso/qrcode/check?entry=sinawap&qrid=" + encodeURIComponent(st.qr.id) + "&callback=STK_2", sinaH, { timeout: 15 });
  const j = jsonp(body);
  if (!j) return { s: "wait", msg: "等待中…" };
  if (j.retcode === 50114001) return { s: "wait", msg: "等待确认：请点上面的按钮，在微博里确认登录" };
  if (j.retcode === 50114002) return { s: "scanned", msg: "已扫码，请在微博里点「确认登录」" };
  if (j.retcode === 20000000 && j.data && j.data.alt) return exchangeLogin(j.data.alt);
  return { s: "fail", msg: String(j.msg || "二维码已失效") + "，请重新获取" };
}

// ---------- 任务锁 ----------
// 手动、定时、打开微博补签、刷新列表共用同一把锁：先写入自己的口令，稍等一下再读回来，读到的还是自己的才算拿到。
// 锁里带时间戳，执行期间会不断续期；脚本被系统杀掉后，超过 5 分钟没续期的锁会自动失效。
const LOCK_TTL = 300000;
const lockRead = () => { const s = String($persistentStore.read(LOCK_KEY) || ""), i = s.lastIndexOf("|"); return i < 0 ? { tok: "", ts: 0 } : { tok: s.slice(0, i), ts: Number(s.slice(i + 1)) || 0 }; };
const lockFresh = () => { const l = lockRead(); return !!l.tok && Date.now() - l.ts < LOCK_TTL; };
async function lockAcquire() {
  if (lockFresh()) return null;
  const tok = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  $persistentStore.write(tok + "|" + Date.now(), LOCK_KEY);
  await sleep(90);
  return lockRead().tok === tok ? tok : null;
}
const lockTouch = (tok) => { if (lockRead().tok === tok) $persistentStore.write(tok + "|" + Date.now(), LOCK_KEY); };
const lockRelease = (tok) => { if (lockRead().tok === tok) del(LOCK_KEY); };

// ---------- 签到记录（最近 30 次任务，只存超话名称、结果、失败原因） ----------
function pushLog(rec) {
  if (!(rec.items.length || rec.expired || rec.netFail)) return;
  const lg = readJ(LOG_KEY) || [];
  lg.unshift({
    at: rec.at, tr: rec.trigger, ms: rec.ms, total: rec.total, exp: rec.expired ? 1 : 0, net: rec.netFail ? 1 : 0,
    it: rec.items.map((i) => [String(i.name || "").slice(0, 30), i.st, (i.st === "fail" || i.st === "unknown") ? friendly(i.msg) : ""]),
  });
  lg.length = Math.min(lg.length, 30);
  while (lg.length > 3 && JSON.stringify(lg).length > 300000) lg.pop();
  writeJ(LOG_KEY, lg);
}

// ---------- 执行签到 ----------
async function run(trigger, opt) {
  const web = readJ(WEB_KEY);
  if (!web) {
    const st0 = readState();
    st0.login = { state: "none" };
    writeJ(STATE_KEY, st0);
    if (!(opt && opt.silentExpired)) pushK("fail", "还没有登录", "打开状态页 http://weibo-checkin.loon/ 扫码登录");
    return null;
  }
  const tok = await lockAcquire();
  if (!tok) { log("上一次还在运行，跳过"); return "busy"; }
  const st = readState(), prefs = readPrefs();
  const P = { id: Date.now(), phase: "list", total: 0, n: 0, cur: "", items: [], q: [], muted: 0, upd: 0 };
  const prog = () => { P.upd = Date.now(); writeJ(PROG_KEY, P); lockTouch(tok); };
  prog();

  const rec = { at: Date.now(), trigger, route: "web", items: [], ok: 0, already: 0, fail: 0, skipped: 0, muted: 0, unknown: 0, exp: 0, expired: false, listNote: "", listCount: 0, listErr: false, listState: "" };
  // 记下每个超话最近一次的结果（今天已经「成功」的，再次检查变成「已签」时仍记为成功）
  const mark = (t, s, m) => {
    const now = Date.now(), prev = st.last[t.id];
    const keep = s === "already" && prev && prev.s === "ok" && ymd(prev.at) === today();
    st.last[t.id] = { n: t.name, s: keep ? "ok" : s, at: now, ok: (s === "ok" || s === "already") ? now : ((prev && prev.ok) || 0), m: (s === "fail" || s === "unknown") ? String(m || "").slice(0, 40) : "" };
  };
  try {
    let listed = [], listFull = false;
    const saved = readJ(TL_KEY);
    if (!prefs.fetch && saved && saved.items && saved.items.length) { // 设置里关掉了「自动获取关注超话」：用上次保存的列表
      listed = saved.items.map((t) => ({ id: t.id, name: t.name, pic: t.pic || "", done: false }));
      listFull = saved.state === "full";
      rec.listNote = "使用上次保存的列表"; rec.listCount = listed.length; rec.listSrc = "saved";
    } else {
      try {
        const r = await fetchListWeb(web);
        listed = r.topics; rec.listNote = r.note; rec.listCount = listed.length; rec.listSrc = r.src;
        listFull = !!r.complete; rec.listErr = !r.complete && !!r.note;
      } catch (e) {
        if (e.expired) rec.expired = true; else { rec.listNote = "列表接口：" + String(e.message || e).slice(0, 80); rec.listErr = true; }
      }
    }

    // 合并：列表里的 + 访问过的超话
    const all = new Map();
    for (const t of listed) all.set(t.id, { id: t.id, name: t.name || label(t.id), done: t.done });
    rec.visited = 0;
    for (const id of Object.keys(st.topics)) if ((!web || !listed.length) && !all.has(id)) { all.set(id, { id, name: label(id), done: false }); rec.visited++; }
    // 列表来源：full = 完整关注列表；partial = 只读到一部分；visited = 没读到列表，只有访问过的；none = 什么都没有
    rec.listState = listed.length ? (listFull ? "full" : "partial") : (rec.visited ? "visited" : "none");
    if (listed.length && rec.listSrc !== "saved") writeJ(TL_KEY, { at: Date.now(), state: rec.listState, note: rec.listNote, items: listed.map((t) => ({ id: t.id, name: t.name || label(t.id), pic: t.pic || "" })) });

    if (st.signed.day !== today()) st.signed = { day: today(), ids: {} };
    const start = Date.now();
    const active = Array.from(all.values()).filter((t) => !prefs.skip[t.id]);
    P.total = active.length; P.q = active.map((t) => String(t.name).slice(0, 30)).slice(0, 300); P.muted = all.size - active.length; P.phase = "run"; prog();
    for (const t of all.values()) {
      if (rec.expired) break;
      if (prefs.skip[t.id]) { rec.muted++; rec.items.push({ id: t.id, name: t.name, st: "skip", msg: "已跳过" }); continue; } // 在设置里关掉的超话
      if (t.done || st.signed.ids[t.id]) { rec.already++; rec.items.push({ id: t.id, name: t.name, st: "already", msg: "今日已签" }); st.signed.ids[t.id] = 1; mark(t, "already", ""); P.n++; P.items.push({ n: t.name, s: "already" }); prog(); continue; }
      if (Date.now() - start > DEADLINE_MS) { rec.skipped++; continue; }
      P.cur = t.name; prog();
      const res = await checkinWeb(web, t.id);
      if (res.r === "expired") { rec.expired = true; break; }
      if (res.r === "ok") { rec.ok++; rec.exp += res.exp || 0; st.signed.ids[t.id] = 1; }
      else if (res.r === "already") { rec.already++; st.signed.ids[t.id] = 1; }
      else if (res.r === "unknown") rec.unknown++; // 状态未知：不算已签，也不记入「今日已签」
      else rec.fail++;
      const shown = ["ok", "already", "unknown"].indexOf(res.r) >= 0 ? res.r : "fail";
      mark(t, shown, res.msg);
      rec.items.push({ id: t.id, name: t.name, st: res.r, msg: res.msg, streak: res.streak, exp: res.exp, rank: res.rank });
      P.n++; P.cur = ""; P.items.push({ n: t.name, s: shown }); prog();
      await sleep(1500 + Math.floor(Math.random() * 2000));
    }
    if (listFull && !rec.expired) for (const id of Object.keys(st.last)) if (!all.has(id)) delete st.last[id]; // 取消关注的超话不再占位置
  } finally {
    P.phase = "done"; P.cur = ""; prog();
    rec.total = rec.ok + rec.already + rec.fail + rec.unknown + rec.skipped;
    rec.ms = Date.now() - rec.at;
    st.run = rec;
    if (!rec.expired && gotResponse && rec.total && !rec.fail && !rec.unknown && !rec.skipped && rec.listState !== "partial" && rec.listState !== "visited") { // 手动 / 补签也算：今天全部签完了，之后的定时检查直接跳过
      const d0 = today(); st.auto = st.auto && st.auto.day === d0 ? Object.assign(st.auto, { done: true }) : { day: d0, tries: 0, done: true, last: 0 };
    }
    if (!rec.expired && gotResponse && rec.total) { // 近两周的每日结果，状态页画「近 7 天」
      const d = today(), prev = st.hist[d] || { signed: 0 };
      st.hist[d] = { signed: Math.max(prev.signed, rec.ok + rec.already), fail: rec.fail + rec.unknown, total: rec.total };
      Object.keys(st.hist).sort().slice(0, -14).forEach((k) => delete st.hist[k]);
    }
    if (rec.expired) st.login = { state: "expired", route: rec.route };
    else if (gotResponse) st.login = { state: "ok", verified: Date.now(), route: rec.route };
    else rec.netFail = true;
    try { pushLog(rec); } catch (e) { log("pushLog error " + e); }
    writeJ(STATE_KEY, st);
    lockRelease(tok);
  }

  if (rec.expired) { if (!(opt && opt.silentExpired)) pushK("fail", "登录已失效", "网页登录已过期，请打开状态页重新扫码"); return rec; }
  if (!rec.total && rec.muted) { pushK("done", "没有需要签到的超话", "已在设置里跳过 " + rec.muted + " 个超话"); return rec; }
  if (!rec.total) { pushK("fail", "没有可签到的超话", rec.listNote || "网页登录读不到关注的超话"); return rec; }
  if (rec.netFail) { if (!(opt && opt.silentNet)) pushK("fail", "网络请求全部失败", "没有收到微博服务器的任何响应，详情见状态页"); return rec; }
  const head = "共 " + rec.total + " 个：成功 " + rec.ok + " · 已签 " + rec.already + " · 失败 " + rec.fail + (rec.unknown ? " · 未确认 " + rec.unknown : "");
  const lines = [];
  if (rec.ok) lines.push("✅ 新签到 " + rec.ok + " 个" + (rec.exp ? "，经验 +" + rec.exp : ""));
  const bad = rec.items.filter((i) => i.st === "fail").slice(0, 4).map((i) => i.name + "（" + i.msg + "）");
  if (bad.length) lines.push("❌ " + bad.join("；"));
  const unk = rec.items.filter((i) => i.st === "unknown").slice(0, 3).map((i) => i.name);
  if (rec.unknown) lines.push("❓ 未确认 " + rec.unknown + " 个，不计入已签：" + unk.join("、") + (rec.unknown > unk.length ? " 等" : ""));
  if (rec.skipped) lines.push("⏱ 超时未处理 " + rec.skipped + " 个，" + (rec.listState === "full" ? "下次继续" : "稍后继续"));
  if (rec.listState === "partial") lines.push("⚠️ 只读到部分关注列表" + (rec.listNote ? "：" + friendly(rec.listNote) : ""));
  else if (rec.listState === "visited") lines.push("⚠️ 没读到关注列表，只签了进入过的 " + rec.visited + " 个" + (rec.listNote ? "：" + friendly(rec.listNote) : ""));
  const n = prefs.n, badRun = rec.fail || rec.unknown || rec.skipped;
  if (notify && (n.done || (rec.ok && n.ok) || (badRun && n.fail))) $notification.post(TITLE, head, lines.join("\n"), { openUrl: PAGE, url: PAGE });
  return rec;
}

// ---------- 定时入口 ----------
// Loon 每 5 分钟调用一次；到了设定的时间才真正签到，错过的会补签，失败的会隔一会儿重试。
// 每次调用都记录一下，状态页就能看出 Loon 到底有没有触发过定时任务。
// 打开微博时的补签是第二条触发路径，两条路共用同一把任务锁和同一份 st.auto 记录。
function openDue() {
  const day = today(), now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  const st = readState();
  const a = st.auto && st.auto.day === day ? st.auto : { day, tries: 0, done: false, last: 0 };
  return !(a.done || mins < SCHED || a.tries >= 6 || (a.last && Date.now() - a.last < 10 * 60000) || !readJ(WEB_KEY) || !readPrefs().auto || lockFresh());
}
async function auto(src) {
  const day = today();
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  const st = readState();
  const a = st.auto && st.auto.day === day ? st.auto : { day, tries: 0, done: false, last: 0 };
  if (a.done) return; // 今天已经签完：什么都不做（不写状态、不打日志、不访问微博）
  const open = src === "open"; // 打开微博时的补签：微博会频繁请求，不满足条件就什么都不做、也不写状态
  if (!readPrefs().auto) { if (!open) { st.tick = { at: Date.now() }; writeJ(STATE_KEY, st); } return; } // 在状态页关掉了自动签到
  if (open && !openDue()) return;
  if (open) st.open = { at: Date.now() }; else st.tick = { at: Date.now() };
  st.auto = a;
  writeJ(STATE_KEY, st);
  log((open ? "打开微博补签检查：" : "定时检查：") + "现在 " + mins + " 分，设定 " + SCHED + " 分，今日已完成=" + a.done + "，已尝试 " + a.tries + " 次");
  if (a.done || mins < SCHED) return;
  if (a.tries >= 6 || (a.last && Date.now() - a.last < 10 * 60000)) return; // 到点后每 10 分钟重试一次，最多 6 次

  a.tries++; a.last = Date.now();
  writeJ(STATE_KEY, st);
  const res = await run(open ? "open" : "cron", { silentNet: a.tries < 3, silentExpired: !!a.expNotified });
  const st2 = readState();
  const a2 = st2.auto && st2.auto.day === day ? st2.auto : a;
  if (res === "busy") a2.tries = Math.max(0, a2.tries - 1);
  else if (!res || res.expired) {
    // 没登录 / 登录失效：不占用重试次数，也不当作「今日已完成」；重新登录后下一轮定时检查会接着签
    a2.tries = Math.max(0, a2.tries - 1); a2.last = 0; a2.done = false; a2.expNotified = true; a2.final = "expired";
  } else {
    a2.expNotified = false;
    const retry = res.netFail || res.skipped > 0 || (a2.tries < 5 && (res.fail > 0 || res.unknown > 0 || res.listErr));
    a2.done = !retry || a2.tries >= 6; // 最多尝试 6 次，用完就收工，状态页显示最终结果
    a2.final = res.netFail ? "net" : res.skipped > 0 ? "timeout" : (res.fail > 0 || res.unknown > 0) ? "partial" : (res.listState && res.listState !== "full") ? "list" : "ok";
  }
  st2.auto = a2;
  writeJ(STATE_KEY, st2);
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
function loginView(st) {
  const web = readJ(WEB_KEY);
  if (!web) return { cls: "bad", t: "未登录", d: "请扫码登录微博网页版" };
  const who = web.nick ? web.nick + " · " : "";
  if (st.login.state === "expired") return { cls: "warn", t: "疑似失效", d: "网页登录已过期，请重新扫码" };
  return { cls: "ok", t: "有效", d: who + "网页登录 · " + ago(web.at) + "登录" + (st.login.verified ? " · " + ago(st.login.verified) + "验证通过" : "") };
}
const friendly = (m) => {
  m = String(m || "");
  if (/Request timeout|无响应/.test(m)) return "请求超时";
  if (/HTTPClient|NSURL|Domain=/.test(m)) return "网络请求失败";
  return m.length > 36 ? m.slice(0, 36) + "…" : m;
};
const clock = (t) => { const d = new Date(t); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); };

// ---------- 页面样式：与主站一致的设计变量（暖纸色 + 绿色强调、16/10/6 圆角、弹簧缓动、逐层入场）；没有固定底栏，也不再叠加整屏模糊，Safari 更省电 ----------
const PAGE_CSS = `
@font-face{font-family:"Geist Sans";src:local("Geist"),local("Geist Sans"),url(https://raw.githubusercontent.com/OliviaR13/MyLoon/refs/heads/main/fonts/Geist-Variable.woff2) format("woff2");font-weight:100 900;font-display:swap}
:root{color-scheme:light dark;--bg:#f6f4ef;--card:#fdfcf9;--hover:#faf8f3;--text:#1d1b17;--muted:#6a655a;--line:#e6e2d8;--chip:#efece4;--accent:#0f7f69;--accent-text:#0a6250;--accent-ink:#f7fbf9;--shadow:40 30 10;
--glow:color-mix(in srgb,var(--accent) 16%,transparent);--warn:#b45309;--bad:#b42318;--r-lg:16px;--r-md:10px;--r-sm:6px;--spring:cubic-bezier(.34,1.4,.64,1);--ease:cubic-bezier(.2,.8,.2,1);
--ap-bg:color-mix(in srgb,var(--card) 80%,transparent);--ap-filter:saturate(180%) blur(20px);--ap-line:rgb(0 0 0 / .1);
--font:"Geist Sans",-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Noto Sans SC","Segoe UI",sans-serif;--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#12110f;--card:#191815;--hover:#1e1d19;--text:#efece5;--muted:#a39e92;--line:#2b2924;--chip:#23211d;--accent:#3fcfa6;--accent-text:#3fcfa6;--accent-ink:#04140e;--shadow:0 0 0;
--glow:color-mix(in srgb,var(--accent) 14%,transparent);--warn:#fbbf24;--bad:#f87171;--ap-line:rgb(255 255 255 / .14)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.shell{position:relative;z-index:2;max-width:720px;margin:0 auto;padding:calc(18px + env(safe-area-inset-top)) 16px calc(40px + env(safe-area-inset-bottom))}
h1,h2,p{margin:0}a{color:var(--accent-text)}button,a{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
.head{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.head-text{flex:1;min-width:0}.head h1{font-size:24px;line-height:1.05;font-weight:700;letter-spacing:-.03em}
.head p{color:var(--muted);font-size:13px;font-weight:500;margin-top:5px;line-break:strict;text-wrap:balance}
.btn{font:inherit;font-size:14px;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:var(--r-md);padding:8px 14px;cursor:pointer;text-decoration:none;white-space:nowrap;line-height:1.2;display:inline-flex;align-items:center;justify-content:center;transition:background-color .15s,border-color .15s,filter .15s,transform .35s var(--spring)}
.btn:active{transform:scale(.97)}.btn-ghost{background:transparent}.btn-primary{background:var(--accent);border-color:transparent;color:var(--accent-ink);box-shadow:0 6px 14px color-mix(in srgb,var(--accent) 26%,transparent)}
.btn-icon{display:grid;place-items:center;width:40px;height:40px;padding:0;flex:none}.head .btn{background:var(--ap-bg);border-color:var(--ap-line);color:var(--text)}
.btn-lg{width:100%;padding:14px;font-size:15px}
.btn.swap{display:inline-grid;grid-template-areas:"s";align-items:center;justify-items:center;overflow:hidden}.btn.swap>.lbl{grid-area:s;display:inline-flex;align-items:center;gap:7px;transition:transform .34s var(--ease),opacity .2s}
.btn.swap>.lbl-alt{transform:translateY(70%);opacity:0}.btn.swap[data-done]>.lbl:not(.lbl-alt){transform:translateY(-70%);opacity:0}.btn.swap[data-done]>.lbl-alt{transform:none;opacity:1;transition-delay:.04s}.btn-primary.swap[data-done]{filter:brightness(1.12)}
.spin{animation:rot 1.4s linear infinite}.spin circle{stroke:currentColor;stroke-dasharray:1,150;stroke-dashoffset:0;animation:dash 1.4s ease-in-out infinite}
@keyframes rot{to{transform:rotate(360deg)}}@keyframes dash{0%{stroke-dasharray:1,150;stroke-dashoffset:0}50%{stroke-dasharray:90,150;stroke-dashoffset:-35}100%{stroke-dasharray:90,150;stroke-dashoffset:-124}}
.panel{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--card);overflow:hidden;margin-bottom:14px}
.row{display:grid;grid-template-columns:40px 1fr auto;gap:12px 14px;align-items:center;padding:14px 16px}.row+.row{border-top:1px solid var(--line)}
.ico{width:40px;height:40px;border-radius:var(--r-md);background:var(--chip);box-shadow:0 0 0 1px var(--line);display:grid;place-items:center;color:var(--muted);font-weight:700;transition:background-color .3s,color .3s}
.ico.ok{background:color-mix(in srgb,var(--accent) 13%,transparent);color:var(--accent-text)}.ico.warn{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}.ico.bad{background:color-mix(in srgb,var(--bad) 13%,transparent);color:var(--bad)}
.rt{font-size:15.5px;line-height:1.35;font-weight:620;letter-spacing:-.005em;overflow-wrap:anywhere}.rm{color:var(--muted);font-size:12.5px;line-height:1.4;margin-top:2px;overflow-wrap:anywhere}
.chip{display:inline-block;font-size:11.5px;line-height:1;padding:4px 7px;border-radius:var(--r-sm);background:var(--chip);color:var(--muted);white-space:nowrap}
.chip.ok{background:color-mix(in srgb,var(--accent) 13%,transparent);color:var(--accent-text);font-weight:600}.chip.warn{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn);font-weight:600}.chip.bad,.chip.fail{background:color-mix(in srgb,var(--bad) 13%,transparent);color:var(--bad);font-weight:600}
.chip.cap,.chip.already{background:transparent;color:color-mix(in srgb,var(--text) 80%,var(--muted));box-shadow:inset 0 0 0 1px var(--line)}
.heat{display:inline-flex;align-items:center;gap:4px;height:24px;white-space:nowrap;padding:0 9px 0 7px;border-radius:999px;background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn);font-size:12.5px;font-weight:650;line-height:1}
.hero{display:flex;align-items:center;gap:18px;padding:18px}.ring{position:relative;width:96px;height:96px;flex:none}.ring svg{transform:rotate(-90deg)}.ring .bg{stroke:var(--line)}.ring .fg{stroke:var(--accent);animation:fill 1s var(--ease) .2s backwards}.ring.warn .fg{stroke:var(--warn)}
@keyframes fill{from{stroke-dasharray:0 var(--c)}}.ring div{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}.num{display:inline-flex;font-size:25px;font-weight:700;line-height:1;letter-spacing:-.02em}.num.n4{font-size:22px}.num.n5{font-size:19px}.num.n6{font-size:16px}.prog[hidden]{display:none}.prog{padding:16px}.prog-h{display:flex;align-items:center;gap:10px;font-weight:650;font-size:15.5px}.prog-h svg{color:var(--accent);flex:none}.prog.fin .spin{display:none}
.pbar{height:6px;border-radius:99px;background:var(--chip);overflow:hidden;margin:12px 0 8px}.pbar i{display:block;height:100%;width:0;background:var(--accent);border-radius:inherit;transition:width .5s var(--ease)}
.pc{color:var(--muted);font-size:12.5px;min-height:1.4em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl{list-style:none;margin:8px 0 0;padding:0;max-height:260px;overflow:auto;overscroll-behavior:contain}.pl li{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--line);animation:rise .3s var(--ease) both}.pl li span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.hero.stale .ring{opacity:.55}.ring small{color:var(--muted);font-size:11.5px;margin-top:4px}
.dg{display:inline-block;height:1em;overflow:hidden;vertical-align:top}.dg i{display:block;font-style:normal;transition:transform 1s var(--ease)}.dg b{display:block;height:1em;font-weight:inherit}
.side{min-width:0;flex:1}.side .rt{margin-bottom:2px}.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.week{display:flex;justify-content:space-between;padding:16px}.week div{text-align:center;color:var(--muted);font-size:11.5px}.week i{display:block;width:34px;height:34px;border-radius:var(--r-md);margin:0 auto 6px;background:var(--chip);box-shadow:inset 0 0 0 1px var(--line)}
.week i.ok{background:var(--accent);box-shadow:none}.week i.warn{background:var(--warn);box-shadow:none}.week .now{color:var(--accent-text);font-weight:650}
.tabs{position:relative;display:flex;gap:20px;box-shadow:inset 0 -1px 0 var(--line);margin:22px 0 14px;overflow-x:auto;overflow-y:hidden;overscroll-behavior:contain;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}
.tab{font:inherit;font-size:15px;font-weight:600;color:var(--muted);background:none;border:0;border-bottom:2px solid transparent;margin-bottom:0;padding:8px 2px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:color .2s}
.tab[aria-pressed="true"]{color:var(--text)}.tab small{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--muted);background:var(--chip);border-radius:999px;padding:1px 7px;line-height:1.5}
.tab[aria-pressed="true"] small{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent-text)}
.tab-ind{position:absolute;bottom:0;height:2px;border-radius:2px;background:var(--accent);pointer-events:none}
.tab-ind[data-dir="fwd"]{transition:right .18s var(--ease),left .45s var(--spring) .07s}.tab-ind[data-dir="back"]{transition:left .18s var(--ease),right .45s var(--spring) .07s}.tab-ind.no-anim{transition:none}
.list{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--card);overflow:hidden}
.item{display:grid;grid-template-columns:40px 1fr auto;gap:12px 14px;align-items:center;padding:14px 16px}.item+.item{border-top:1px solid var(--line)}.item[hidden],#items[hidden],#empty[hidden]{display:none}
.list.enter .item{animation:rise .34s var(--ease) both;animation-delay:calc(var(--i,0) * 45ms)}@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.av{width:40px;height:40px;border-radius:var(--r-md);display:grid;place-items:center;font-weight:700;font-size:16px;box-shadow:0 0 0 1px var(--line);background:color-mix(in srgb,hsl(var(--h) 55% 50%) 16%,var(--card));color:color-mix(in srgb,hsl(var(--h) 60% 38%) 85%,var(--text))}
.it{min-width:0}.it .rt{font-size:15.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.notice{padding:28px 18px;text-align:center;color:var(--muted)}.notice h2{color:var(--text);font-size:16px;margin-bottom:4px}
.foot{text-align:center;color:var(--muted);font-size:12.5px;margin-top:28px}.foot details{margin-top:10px}.foot summary{cursor:pointer;list-style:none}.foot summary::-webkit-details-marker{display:none}.foot summary:after{content:" ›"}.foot details[open] summary:after{content:" ⌄"}.foot details p{margin-top:8px;line-height:1.7;word-break:break-all}
.qr{padding:18px;text-align:center}.qr img{width:180px;height:180px;border-radius:var(--r-md);background:#fff;padding:8px;box-shadow:0 0 0 1px var(--line)}.qr .rm{margin-top:10px}
.wait{display:flex;align-items:center;justify-content:center;gap:10px;margin:6px 0 14px;font-weight:620;color:var(--text)}.wait svg{color:var(--accent)}.wait.done svg,.wait.fail svg{display:none}.wait.done{color:var(--accent-text)}.wait.fail{color:var(--bad)}
@keyframes intro-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@keyframes intro-glow{from{opacity:0}to{opacity:1}}
.head-text{animation:intro-up .6s var(--ease) .08s backwards}.head .btn{animation:intro-up .6s var(--ease) .16s backwards}
.s1{animation:intro-up .6s var(--ease) .22s backwards}.s2{animation:intro-up .6s var(--ease) .28s backwards}.s3{animation:intro-up .6s var(--ease) .34s backwards}.s4{animation:intro-up .6s var(--ease) .4s backwards}.s5{animation:intro-up .6s var(--ease) .46s backwards}
.foot{animation:intro-glow .5s ease-out .6s backwards}
.sec{font-size:12.5px;font-weight:650;color:var(--muted);letter-spacing:.02em;margin:22px 4px 8px}
.note{color:var(--muted);font-size:12.5px;line-height:1.5;padding:0 4px;margin:-6px 0 14px}
.act{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:14px 16px}.row+.act{border-top:1px solid var(--line)}
.btn-danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}.btn-danger-fill{background:var(--bad);border-color:transparent;color:#fff}
.cfm{display:contents}.cfm [data-cf],.cfm [data-cn]{display:none}.cfm[data-ask] [data-go]{display:none}.cfm[data-ask] [data-cf],.cfm[data-ask] [data-cn]{display:inline-flex;animation:intro-up .25s var(--ease) both}
.item.off .av,.item.off .it{opacity:.5}.item .it{transition:opacity .2s}
/* 交互细节：键盘焦点、取消双击缩放延迟、悬停反馈（仅支持悬停的设备） */
a,button,.sw{touch-action:manipulation}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.tab:focus-visible{outline-offset:-2px;border-radius:var(--r-sm)}
@media (hover:hover){.btn:not(.btn-primary):not(.btn-danger-fill):hover{background:var(--hover)}.btn-primary:hover,.btn-danger-fill:hover{filter:brightness(1.07)}.tab:hover{color:var(--text)}.item:hover{background:var(--hover)}}
/* 从「立即签到」「定时刷新」回到状态页时不再重播入场动画（数字滚动和圆环仍会动） */
.skip .head-text,.skip .head .btn,.skip .s1,.skip .s2,.skip .s3,.skip .s4,.skip .s5,.skip .foot{animation:none}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.spin circle{stroke-dasharray:60,150!important}}
/* ---- 控制台（总览 / 超话 / 记录 / 设置） ---- */
.nav{position:sticky;top:env(safe-area-inset-top,0px);z-index:20;margin:0 -16px 16px;padding:8px 16px}
.seg{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:2px;padding:3px;border-radius:12px;background:var(--chip);box-shadow:inset 0 0 0 1px var(--line)}
.seg button{font:inherit;font-size:13.5px;font-weight:600;color:var(--muted);background:none;border:0;border-radius:9px;padding:8px 4px;cursor:pointer;white-space:nowrap;transition:color .2s}
.seg button{position:relative;z-index:1}.seg button[aria-selected="true"]{color:var(--text)}
.seg-i{position:absolute;top:3px;bottom:3px;left:3px;width:calc((100% - 12px) / 4);border-radius:9px;background:var(--card);box-shadow:0 1px 3px rgb(0 0 0 / .14);transform:translateX(calc(var(--i,0) * (100% + 2px)));pointer-events:none}.seg-i.on{transition:transform .45s cubic-bezier(.22,1,.36,1)} /* 不能用带回弹的弹簧曲线：跨三格移动时回弹的距离按比例放大，会冲出分段控件的边 */
@media (prefers-reduced-motion:reduce){.seg-i.on{transition:none}}

/* ════ 四个移植自 Bencho 的组件（MIT，bencho.dev/licence）：液态开关 / 通知堆叠 / 灵动岛 / 浮标签输入框 ════
   Bencho 的设计变量对应到本页：--fill-on / --ink → --text，--fill-slab / --card → --card，--signal → --accent，
   --ink-3 / --ink-4 → --muted，--font-ui → 继承页面字体；状态色用本页的 --accent / --warn / --bad。 */

/* ── 液态开关 ── 一个水滴在轨道里；开 = 绿色轨道，关 = 浅色轨道。水滴的位置、拉伸全由脚本写进 transform，所以这里不给 transform 加过渡 */
.sw{position:relative;flex:none;width:58px;height:32px;padding:0;border:0;border-radius:999px;background:var(--chip);box-shadow:inset 0 0 0 1px var(--line);cursor:pointer;touch-action:pan-y;-webkit-tap-highlight-color:transparent;transition:background-color .42s ease,box-shadow .42s ease}
.sw[aria-checked="true"]{background:var(--accent);box-shadow:none}.sw:disabled{opacity:.6}
.lt{position:absolute;left:0;top:50%;width:24px;height:24px;margin-top:-12px;border-radius:999px;background:var(--card);box-shadow:0 1px 3px rgb(0 0 0 / .25);pointer-events:none;will-change:transform}

/* ── 通知堆叠 ── 三条：最新的在最前，前两条缩小一档叠在后面；点一下展开成列表 */
.tst{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));width:min(320px,calc(100vw - 32px));height:0;transform:translateX(-50%);z-index:40;pointer-events:none;color:var(--text);
  --tst-mute:color-mix(in srgb,var(--text) 52%,var(--card));--tst-wash:color-mix(in srgb,var(--text) 7%,var(--card))}
.tst-toast{position:absolute;left:0;bottom:0;width:100%;height:60px;box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:0 10px 0 16px;border-radius:20px;background:var(--card);box-shadow:0 0 0 1px var(--line),0 10px 28px rgb(var(--shadow) / .16);
  transform-origin:50% 100%;pointer-events:none;cursor:pointer;will-change:transform;transition:transform .5s cubic-bezier(.3,1.12,.5,1),opacity .22s ease,background-color .22s ease,box-shadow .22s ease}
.tst-toast[data-front="1"],.tst[data-open] .tst-toast{pointer-events:auto}
.tst:not([data-open]) .tst-toast[data-front="0"]{background:var(--tst-wash);box-shadow:0 0 0 1px color-mix(in srgb,var(--text) 6%,transparent)}
.tst-toast>*{transition:opacity .22s ease}.tst:not([data-open]) .tst-toast[data-front="0"]>*{opacity:0}
.tst-icon{flex:none;display:grid;place-items:center}
.tst-toast[data-kind="success"] .tst-icon{color:var(--accent)}.tst-toast[data-kind="error"] .tst-icon{color:var(--bad)}.tst-toast[data-kind="warning"] .tst-icon{color:var(--warn)}.tst-toast[data-kind="info"] .tst-icon{color:var(--tst-mute)}
.tst-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.tst-text b{font-size:14px;font-weight:600;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}
.tst-text span{font-size:12.5px;line-height:16px;color:var(--tst-mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tst-x{flex:none;width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:999px;background:none;color:var(--tst-mute);cursor:pointer;transition:background-color .16s ease,color .16s ease}
.tst-x:active{background:var(--tst-wash);color:var(--text)}
@media (hover:hover){.tst-x:hover{background:var(--tst-wash);color:var(--text)}}
.tst-x:focus-visible{outline:none;box-shadow:0 0 0 2px var(--accent)}

/* ── 浮标签输入框 ── 标签就是占位符；聚焦时标签升到上边线，线从中间向两边让出缺口，轮廓颜色变深。轮廓一直是完整的，只有缺口在动 */
.lbi{position:relative;display:block;padding-top:12px;margin-bottom:10px}
.lbi-box{position:relative;height:48px;border-radius:16px;background:transparent;cursor:text;--lbi-x:20px}
.lbi-ring{position:absolute;inset:0;overflow:visible;pointer-events:none}
.lbi-ring path{fill:none;stroke:color-mix(in srgb,var(--text) 32%,var(--card));stroke-width:1;stroke-linecap:butt;transition:stroke .22s ease,stroke-width .22s ease}
.lbi[data-focus="true"] .lbi-ring path{stroke:var(--accent);stroke-width:1.5}
.lbi-gap{stroke-dasharray:1 2;stroke-dashoffset:0;transition:stroke .22s ease,stroke-width .22s ease,stroke-dashoffset .42s cubic-bezier(.22,1,.36,1)}
.lbi[data-up="true"] .lbi-gap{stroke-dashoffset:-1}
.lbi-label{position:absolute;left:var(--lbi-x);top:50%;font-size:16px;line-height:1;letter-spacing:-.01em;white-space:pre;color:var(--muted);transform-origin:left center;transform:translateY(-50%);transition:transform .42s cubic-bezier(.22,1,.36,1),color .22s ease;cursor:text;-webkit-user-select:none;user-select:none}
.lbi[data-up="true"] .lbi-label{transform:translateY(-50%) translateY(-24px) scale(.78)}
.lbi[data-focus="true"] .lbi-label{color:var(--accent-text)}
.lbi-label span{display:inline-block}
.lbi[data-focus="true"] .lbi-label span{animation:lbi-hop .46s cubic-bezier(.3,.7,.3,1) both;animation-delay:calc(var(--i) * 24ms)}
.lbi-field{position:absolute;inset:0;width:100%;height:100%;padding:0 var(--lbi-x);border:0;border-radius:inherit;background:transparent;font:inherit;font-size:16px;letter-spacing:-.01em;color:var(--text);outline:none;-webkit-appearance:none;appearance:none}
@keyframes lbi-hop{0%{transform:translateY(0)}38%{transform:translateY(-3px)}100%{transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){.lbi-ring path,.lbi-gap,.lbi-label{transition-duration:.16s}.lbi[data-focus="true"] .lbi-label span{animation:none}}
.view[hidden]{display:none}.view{animation:intro-up .4s var(--ease) both}
.acc{display:flex;align-items:center;gap:12px;padding:16px}
.avc{width:44px;height:44px;border-radius:50%;flex:none;display:grid;place-items:center;font-weight:700;font-size:17px;background:var(--chip);color:var(--muted);box-shadow:0 0 0 1px var(--line)}
.avc.ok{background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent-text)}.avc.warn{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}
.acc>div:nth-child(2){flex:1;min-width:0}
.kv{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--line)}.kv>div{padding:12px 16px;min-width:0}.kv>div+div{border-left:1px solid var(--line)}
.kv small{display:block;color:var(--muted);font-size:11.5px;margin-bottom:2px}.kv b{font-size:14px;font-weight:620;overflow-wrap:anywhere}
.runbox{padding:16px}.btn-run{width:100%;padding:15px;font-size:16px;border-radius:14px}.btn.swap[data-done]{pointer-events:none}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.stat{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--card);padding:14px 16px;min-width:0}
.stat small{color:var(--muted);font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:6px}
.stat .num{font-size:30px;margin-top:6px}.stat .sub{color:var(--muted);font-size:12px;margin-top:6px;min-height:1.3em}
.stat.okc .num{color:var(--accent-text)}.stat.badc .num{color:var(--bad)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--muted);flex:none}.dot.ok{background:var(--accent)}.dot.bad{background:var(--bad)}.dot.warn{background:var(--warn)}
.pstat{display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin:2px 0 10px;text-align:center}.pstat b{display:block;font-size:18px;font-weight:700}.pstat span{font-size:11px;color:var(--muted)}
.pq{color:var(--muted);font-size:12px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.last{padding:16px}.last .top{display:flex;justify-content:space-between;align-items:center;gap:10px}.last .rm{margin-top:4px}
.fchips{display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;margin:0 -16px 10px;padding:0 16px}.fchips::-webkit-scrollbar{display:none}
.fc{font:inherit;font-size:13px;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:999px;padding:6px 12px;white-space:nowrap;cursor:pointer;flex:none;display:inline-flex;gap:6px;align-items:center}
.fc i{font-style:normal;font-family:var(--mono);font-size:11px;opacity:.75}.fc[aria-pressed="true"]{background:var(--text);color:var(--bg);border-color:transparent}
.bulk{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 4px 8px;color:var(--muted);font-size:12.5px}.bulk div{display:flex;gap:6px}
.btn-sm{padding:6px 11px;font-size:13px;border-radius:9px}
.lsrow{display:flex;align-items:center;gap:12px;padding:14px 16px}.lsrow>div{flex:1;min-width:0}
.av{position:relative;overflow:hidden}.av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:var(--card)}
.rc{display:flex;align-items:center;gap:10px}
.chip.pending{background:var(--chip);color:var(--muted)}
.chip.already{background:color-mix(in srgb,var(--accent) 7%,transparent);color:color-mix(in srgb,var(--accent-text) 78%,var(--muted));box-shadow:none;font-weight:600}
.chip.unknown{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn);font-weight:600}
.chip.skip{background:var(--chip);color:var(--muted);opacity:.85}
.day{font-size:12.5px;font-weight:650;color:var(--muted);margin:14px 4px 8px}
.tlist{margin-bottom:12px}
.hrow{display:grid;grid-template-columns:46px 1fr auto;gap:10px;padding:11px 16px;align-items:start}.hrow+.hrow{border-top:1px solid var(--line)}
.hrow time{font:12px var(--mono);color:var(--muted);padding-top:2px}.hrun{background:var(--hover)}.hrun .rt{font-size:14px}
.srow{display:flex;align-items:center;gap:12px;padding:13px 16px}.srow+.srow,.srow+.act,.row+.srow,.srow+.row{border-top:1px solid var(--line)}.srow>div:first-child{flex:1;min-width:0}
.srow .rt{font-size:15px}
.diagbox{margin-top:18px}
@media (max-width:360px){.stat .num{font-size:26px}.seg button{font-size:13px}}

/* 弹出卡片：与主站「排序」菜单同一套 —— 一个按钮展开成卡片，不是两个元素 */
.panel.ov{overflow:visible}.srow.pop-open{position:relative;z-index:6}
.pop{position:relative;flex:none;height:40px}
.pop-btn{height:100%;display:flex;align-items:center;gap:6px;padding:0 12px 0 14px;font:inherit;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--text);background:var(--card);border:1px solid var(--line);border-radius:20px;cursor:pointer;position:relative;z-index:2;transition:border-color .1s .3s,background-color .1s .3s,transform .35s var(--spring)}
.pop-btn:active{transform:scale(.94)}
.pop-btn svg{width:16px;height:16px;flex:none;color:var(--muted);fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pop-btn>*{transition:opacity .16s .16s}
.pop[data-open="true"] .pop-btn{background:transparent;border-color:transparent;pointer-events:none;transition:border-color 0s,background-color 0s,transform .35s var(--spring)}
.pop[data-open="true"] .pop-btn>*{opacity:0;transition:opacity .1s}
.pop-menu{position:absolute;right:0;top:0;z-index:1;overflow:hidden;width:var(--bw,100px);height:var(--bh,40px);background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:0 0 0 rgb(var(--shadow) / 0);opacity:0;visibility:hidden;pointer-events:none;transition:width .36s cubic-bezier(.32,.72,0,1),height .36s cubic-bezier(.32,.72,0,1),border-radius .36s cubic-bezier(.32,.72,0,1),box-shadow .3s,opacity 0s .36s,visibility 0s .36s}
.pop-menu[data-open="true"]{width:var(--mw);height:var(--mh);box-shadow:0 14px 36px rgb(var(--shadow) / .22);opacity:1;visibility:visible;pointer-events:auto;transition:width .48s cubic-bezier(.22,1,.36,1),height .48s cubic-bezier(.22,1,.36,1),border-radius .48s cubic-bezier(.22,1,.36,1),box-shadow .3s,opacity 0s,visibility 0s}
.pop-inner{position:absolute;top:0;right:0;width:max-content;min-width:232px;padding:6px}
.pop-menu .pop-inner>*{opacity:0;transform:translateY(-6px);transition:opacity .14s calc((var(--n) - 1 - var(--i)) * 14ms),transform .2s var(--ease) calc((var(--n) - 1 - var(--i)) * 14ms),background-color .15s}
.pop-menu[data-open="true"] .pop-inner>*{--d:calc(90ms + var(--i) * 34ms);opacity:1;transform:none;transition:opacity .24s var(--d),transform .42s var(--ease) var(--d),background-color .15s}
.pop-title{display:flex;align-items:center;justify-content:space-between;min-height:36px;padding:0 10px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer}
.pop-title svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pop-item{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;padding:10px;font:inherit;font-size:14.5px;font-variant-numeric:tabular-nums;color:var(--text);background:none;border:0;border-radius:var(--r-md);text-align:left;cursor:pointer;transition:background-color .15s}
.pop-item.pop-save{color:var(--accent-text);font-weight:650;justify-content:center}
.pop-sep{height:1px;margin:6px 4px;background:var(--line)}
@media (hover:hover){.pop-item:hover{background:var(--chip)}.pop-btn:hover{border-color:var(--muted)}}
@media (hover:none){.pop-item:active{background:var(--chip)}}
@media (prefers-reduced-motion:reduce){.pop-menu,.pop-menu .pop-inner>*{transition:none}}

/* 上下渐进模糊：3 层毛玻璃（层数越多 Safari 越卡）；顶部只在导航吸顶后出现，底部只在下面还有内容可滚时出现 */
.nav{--nf:36px;--nl:64px;background:none}
.navs{display:block;height:0}
.nav::before,.nav-blur{content:"";position:absolute;z-index:-1;left:0;right:0;top:calc(-1 * (env(safe-area-inset-top,0px) + var(--nl)));bottom:calc(-1 * var(--nf));pointer-events:none;visibility:hidden;opacity:0;transition:opacity .25s,visibility 0s .25s}
.nav::before{background:linear-gradient(to bottom,color-mix(in srgb,var(--bg) 72%,transparent) 0,color-mix(in srgb,var(--bg) 64%,transparent) calc(100% - var(--nf)),color-mix(in srgb,var(--bg) 40%,transparent) calc(100% - var(--nf) * .65),color-mix(in srgb,var(--bg) 14%,transparent) calc(100% - var(--nf) * .3),transparent 100%)}
.nav[data-stuck]::before,.nav[data-stuck] .nav-blur{visibility:visible;opacity:1;transition:opacity .1s linear}
.nav-blur i{position:absolute;inset:0}
.nav-blur i:nth-child(1){-webkit-backdrop-filter:blur(2.5px);backdrop-filter:blur(2.5px);-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - var(--nf) * 1 / 3),transparent 100%);mask-image:linear-gradient(to bottom,#000 calc(100% - var(--nf) * 1 / 3),transparent 100%)}
.nav-blur i:nth-child(2){-webkit-backdrop-filter:blur(5.5px);backdrop-filter:blur(5.5px);-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - var(--nf) * 2 / 3),transparent calc(100% - var(--nf) * 1 / 3));mask-image:linear-gradient(to bottom,#000 calc(100% - var(--nf) * 2 / 3),transparent calc(100% - var(--nf) * 1 / 3))}
.nav-blur i:nth-child(3){-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);-webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - var(--nf) * 3 / 3),transparent calc(100% - var(--nf) * 2 / 3));mask-image:linear-gradient(to bottom,#000 calc(100% - var(--nf) * 3 / 3),transparent calc(100% - var(--nf) * 2 / 3))}
.bblur{--f:76px;position:fixed;left:0;right:0;bottom:0;height:calc(var(--f) + env(safe-area-inset-bottom,0px));z-index:5;pointer-events:none;visibility:hidden;opacity:0;transition:opacity .2s,visibility 0s .2s}.bblur[data-on]{visibility:visible;opacity:1;transition:opacity .2s}
.bblur::before{content:"";position:absolute;inset:0;background:linear-gradient(to top,color-mix(in srgb,var(--bg) 78%,transparent) 0,color-mix(in srgb,var(--bg) 60%,transparent) 55%,color-mix(in srgb,var(--bg) 22%,transparent) 80%,transparent 100%)}
.bblur i{position:absolute;inset:0}
.bblur i:nth-child(1){-webkit-backdrop-filter:blur(2.5px);backdrop-filter:blur(2.5px);-webkit-mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 1 / 3),transparent 100%);mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 1 / 3),transparent 100%)}
.bblur i:nth-child(2){-webkit-backdrop-filter:blur(5.5px);backdrop-filter:blur(5.5px);-webkit-mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 2 / 3),transparent calc(100% - var(--f) * 1 / 3));mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 2 / 3),transparent calc(100% - var(--f) * 1 / 3))}
.bblur i:nth-child(3){-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);-webkit-mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 3 / 3),transparent calc(100% - var(--f) * 2 / 3));mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 3 / 3),transparent calc(100% - var(--f) * 2 / 3))}
/* ══ Time scrubber ═══════════════════════════════════════ */
/* Bencho 的设计变量在这里就近映射到页面自己的变量，只定义在组件根上，不外泄：
   --card 本页已有同名变量，原样沿用；
   --fill-slab 底板 → --chip（比弹层的 --card 深一档，像嵌进去的一块）；
   --fill-on / --ink 字和刻度的墨色 → --text；--font-ui → --font；
   --pane-edge 描边 → --line；--signal 焦点环 → --accent。 */
.tms {
  --fill-slab: var(--chip);
  --fill-on: var(--text);
  --ink: var(--text);
  --font-ui: var(--font);
  --pane-edge: var(--line);
  --signal: var(--accent);
  width: 300px;
  padding: 20px 20px 16px;
  border-radius: var(--tms-r);
  background: var(--fill-slab, var(--card));
  color: var(--fill-on, var(--ink));
  font-family: var(--font-ui);
  user-select: none;
  -webkit-user-select: none;}

[data-stroke="on"] .tms { box-shadow: 0 0 0 1px var(--pane-edge); }

.tms-read {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;}

.tms-time {
  display: inline-flex;
  font-size: 30px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;}

/* a digit rolls through a window that FADES rather than clips.
   Each cell is 1.5em for a 1em line, the digit centred in it, so
   at rest the neighbours sit wholly outside the window; the mask
   takes the top and bottom quarter-em to nothing, so a digit on
   the move leaves and arrives through a fade, never an edge. The
   negative margin keeps the line box at 1em. */
.tms-col {
  display: inline-block;
  height: 1.5em;
  margin: -0.25em 0;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(transparent, #000 30%, #000 70%, transparent);
  mask-image: linear-gradient(transparent, #000 30%, #000 70%, transparent);}

.tms-strip {
  display: flex;
  flex-direction: column;
  transition: transform 220ms cubic-bezier(0.24, 1.34, 0.38, 1);}

.tms-strip > span { height: 1.5em; line-height: 1.5em; }

/* and it smears a little while it rolls */
.tms-strip[data-flip="a"] { animation: tms-blur-a 260ms ease-out; }

.tms-strip[data-flip="b"] { animation: tms-blur-b 260ms ease-out; }

.tms-colon { padding: 0 0.02em; }

.tms-mer {
  font-size: 14px;
  font-weight: 500;
  color: color-mix(in srgb, var(--fill-on, #17181a) 52%, var(--fill-slab, #ffffff));
  letter-spacing: -0.01em;}

.tms-ruler {
  position: relative;
  height: 58px;
  margin-top: 16px;
  cursor: grab;
  touch-action: pan-y;
  outline: none;
  /* the ruler fades out at both ends, like a wheel turning away */
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 22%, #000 78%, transparent);
  mask-image: linear-gradient(90deg, transparent, #000 22%, #000 78%, transparent);}

.tms-ruler:active { cursor: grabbing; }

.tms-ruler:focus-visible { box-shadow: inset 0 0 0 2px var(--signal, #2231dd); border-radius: 10px; }

.tms-track { position: absolute; left: 50%; top: 0; bottom: 0; }

.tms-tick {
  position: absolute;
  left: -1px;
  top: 8px;
  width: 2px;
  height: 10px;
  border-radius: 1px;
  background: var(--fill-on, var(--ink));
  transform-origin: 50% 0;}

.tms-tick[data-kind="quarter"] { height: 17px; }

.tms-tick[data-kind="hour"] { height: 25px; }

.tms-hour {
  position: absolute;
  left: 0;
  top: 38px;
  font-size: 11px;
  font-weight: 400;
  white-space: nowrap;
  color: color-mix(in srgb, var(--fill-on, #17181a) 52%, var(--fill-slab, #ffffff));
  letter-spacing: 0em;}

/* the fixed mark the ruler runs under */
.tms-mark {
  position: absolute;
  left: 50%;
  top: 2px;
  width: 3px;
  height: 32px;
  margin-left: -1.5px;
  border-radius: 2px;
  background: #e5484d;}

@keyframes tms-blur-a { from { filter: blur(2px); } to { filter: blur(0); } }

@keyframes tms-blur-b { from { filter: blur(2px); } to { filter: blur(0); } }
@media (prefers-reduced-motion:reduce){.tms-strip{transition:none;animation:none!important}}
`;

const svgi = (d, z) => '<svg width="' + (z || 18) + '" height="' + (z || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
const IC = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20v.01M20 20v.01M17 17v3"/>',
};
const SPIN = '<svg class="spin" viewBox="0 0 50 50" width="18" height="18" aria-hidden="true"><circle cx="25" cy="25" r="20" fill="none" stroke-width="4.5" stroke-linecap="round"/></svg>';
const headHtml = (title, sub, right) => '<header class="head"><div class="head-text"><h1>' + title + "</h1>" + (sub ? "<p>" + sub + "</p>" : "") + "</div>" + (right || "") + "</header>";
const shellOpen = (title, page) => '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f6f4ef" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#12110f" media="(prefers-color-scheme: dark)"><title>' + title + "</title><script>if(/[?&]m=/.test(location.search))document.documentElement.className='skip'</script><style>" + PAGE_CSS + '</style></head><body data-page="' + (page || "") + '">';

// 简单提示页（出错 / 功能已关闭）：沿用同一套样式，而不是一段裸文字
const msgPage = (title, msg, links) => shellOpen(title) + '<main class="shell">' + headHtml(title, "") + '<section class="panel s1"><div class="notice"><p>' + esc(msg) + "</p></div></section>" + (links ? '<div class="foot s2">' + links + "</div>" : "") + "</main></body></html>";

const PAGE_JS = `(function(){
var $=function(i){return document.getElementById(i)},Q=function(s,r){return (r||document).querySelectorAll(s)};
var LB={pending:"待签到",ok:"签到成功",already:"已签到",fail:"签到失败",unknown:"未确认",skip:"已跳过"};
function post(u){return fetch(u).then(function(r){return r.json()})}

// 数字滚动：每一位数字是一条 0-9 的竖条，入场时依次滚到目标位置
function spin(t,c){requestAnimationFrame(function(){requestAnimationFrame(function(){t.style.transform="translateY(-"+c*10+"%)"})})}
function roll(el){
  var s=el.getAttribute("data-n");el.setAttribute("role","img");el.setAttribute("aria-label",s);el.textContent="";
  for(var i=0;i<s.length;i++){
    var c=s.charAt(i),w=document.createElement("span");
    if(c>="0"&&c<="9"){
      var t=document.createElement("i");w.className="dg";
      for(var d=0;d<10;d++){var b=document.createElement("b");b.textContent=d;t.appendChild(b)}
      t.style.transitionDelay=(i*70+250)+"ms";w.appendChild(t);spin(t,+c)
    }else w.textContent=c;
    el.appendChild(w)
  }
}
var ns=Q(".num");for(var n=0;n<ns.length;n++)roll(ns[n]);

// ── 通知堆叠（移植自 Bencho「Toast stack」，MIT）──
// 最多三条：最新的在最前，前面两条缩小一档、露出一道边叠在后面；点一下展开成列表，点别处收回。
// 每条的位置只由「它是第几条 + 是否展开」算出来：展开、收起、离开、新来一条都是同一个动作，所以只用一条过渡曲线。
var TH=60,TG=10,TPK=12,TMAX=3,tst=$("tst"),tstack=[],topen=false;
var TP={success:'<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',error:'<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',warning:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'};
function svgs(p,n){return '<svg viewBox="0 0 24 24" width="'+n+'" height="'+n+'" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+p+'</svg>'}
function tkind(t){return /失败|连不上|过期|出错|错误|没有读到/.test(t)?"error":/部分|不完整|没有变化/.test(t)?"warning":/已|成功|完成/.test(t)?"success":"info"}
function tlay(){
  for(var k=0;k<tstack.length;k++){
    var e=tstack[k].el,d=Math.min(k,TMAX-1),y=topen?-k*(TH+TG):-d*TPK,sc=topen?1:1-d*.05;
    e.style.transform="translate3d(0,"+y+"px,0) scale("+sc+")";e.style.zIndex=TMAX-k;
    e.setAttribute("data-front",k===0?"1":"0");e.setAttribute("aria-hidden",!topen&&k>0?"true":"false")
  }
}
function tarm(t,ms){clearTimeout(t.tm);t.tm=setTimeout(function(){tdrop(t)},ms)}
function topenSet(o){
  topen=o;if(o)tst.setAttribute("data-open","");else tst.removeAttribute("data-open");
  for(var i=0;i<tstack.length;i++){if(o)clearTimeout(tstack[i].tm);else tarm(tstack[i],2200)}
  tlay()
}
function tdrop(t){
  var i=tstack.indexOf(t);if(i<0)return;
  tstack.splice(i,1);clearTimeout(t.tm);
  t.el.style.opacity="0";t.el.style.transform+=" translateX(60px)";t.el.style.pointerEvents="none";
  setTimeout(function(){if(t.el.parentNode)t.el.parentNode.removeChild(t.el)},260);
  if(topen&&tstack.length<2)topenSet(false);else tlay()
}
function toast(title,kind,body){
  if(!tst)return;kind=kind||tkind(title);
  var e=document.createElement("div");e.className="tst-toast";e.setAttribute("data-kind",kind);
  e.style.opacity="0";e.style.transform="translate3d(0,24px,0)"; // 从前面那条的下方升起
  e.innerHTML='<span class="tst-icon">'+svgs(TP[kind],18)+'</span><span class="tst-text"><b></b><span></span></span><button type="button" class="tst-x" aria-label="关闭">'+svgs('<path d="M18 6 6 18M6 6l12 12"/>',16)+'</button>';
  e.querySelector("b").textContent=title;
  var sp=e.querySelector(".tst-text span");if(body)sp.textContent=body;else sp.parentNode.removeChild(sp);
  var t={el:e,tm:0};tst.appendChild(e);void e.offsetWidth;
  tstack.unshift(t);while(tstack.length>TMAX)tdrop(tstack[tstack.length-1]);
  e.style.opacity="1";tlay();if(!topen)tarm(t,kind==="error"?5200:3200);
  e.querySelector(".tst-x").onclick=function(ev){ev.stopPropagation();tdrop(t)};
  e.onclick=function(){if(tstack.length>1||topen)topenSet(!topen)}
}
document.addEventListener("click",function(ev){if(topen&&tst&&!tst.contains(ev.target))topenSet(false)});
var MSG={login:"登录成功",out:"已退出登录",cleared:"已清理历史记录",cfg:"已重置模块配置"};
var mm=/[?&]m=([A-Za-z]+)/.exec(location.search);
if(mm){
  var mk=mm[1],dn=tst?tst.getAttribute("data-done")||"":"";
  if(mk==="done"&&dn){var di=dn.indexOf(" · ");toast(di>0?dn.slice(0,di):dn,/失败|未确认|不完整/.test(dn)?"warning":"success",di>0?dn.slice(di+3):"")}
  else if(MSG[mk])toast(MSG[mk],"success");
  history.replaceState(null,"",location.pathname+location.hash)
}

// 四个区域：用 # 切换（#overview / #topics / #history / #settings），不新增历史记录
var VS=["overview","topics","history","settings"],seg=Q("#seg button");
function curV(){var h=location.hash.replace("#","");return VS.indexOf(h)>=0?h:"overview"}
function show(v,top){
  for(var i=0;i<VS.length;i++){var el=$("v-"+VS[i]);if(el)el.hidden=VS[i]!==v}
  for(var j=0;j<seg.length;j++)seg[j].setAttribute("aria-selected",seg[j].getAttribute("data-v")===v?"true":"false");
  var sg=$("seg");if(sg)sg.style.setProperty("--i",VS.indexOf(v));
  if(top)window.scrollTo(0,0);
  if(v==="history")drawH();
  if(v==="topics"&&typeof lbiFit==="function")requestAnimationFrame(lbiFit);
  if(typeof stuck==="function")requestAnimationFrame(stuck)
}
function go(v){history.replaceState(null,"","#"+v);show(v,true)}
for(var si=0;si<seg.length;si++)seg[si].onclick=function(){go(this.getAttribute("data-v"))};
var gv=Q("[data-gv]");for(var gi=0;gi<gv.length;gi++)gv[gi].onclick=function(e){e.preventDefault();go(this.getAttribute("data-gv"))};
addEventListener("hashchange",function(){show(curV(),true)});

// ---------- 超话管理 ----------
var rows=Q("#tl .item"),fs="all",qs="";
function cntT(){
  var c={pending:0,ok:0,already:0,fail:0,unknown:0,skip:0},en=0,i;
  for(i=0;i<rows.length;i++){var s=rows[i].getAttribute("data-st");c[s]++;if(s!=="skip")en++}
  var fc=Q(".fc[data-f]");
  for(i=0;i<fc.length;i++){var k=fc[i].getAttribute("data-f");fc[i].querySelector("i").textContent=k==="all"?rows.length:c[k]}
  var te=$("ten");if(te)te.textContent="已启用 "+en+" / "+rows.length
}
function applyT(){
  var k=0;
  for(var i=0;i<rows.length;i++){
    var r=rows[i],ok=(fs==="all"||r.getAttribute("data-st")===fs)&&(!qs||r.getAttribute("data-n").toLowerCase().indexOf(qs)>=0);
    r.hidden=!ok;if(ok)k++
  }
  var em=$("tempty"),tl=$("tl");if(em)em.hidden=!!k||!rows.length;if(tl)tl.hidden=!k
}
function setRow(row,en){
  var st0=row.getAttribute("data-st0"),s=en?st0:"skip",sw=row.querySelector(".sw"),ch=row.querySelector(".chip"),rm=row.querySelector(".rm");
  row.setAttribute("data-st",s);row.classList.toggle("off",!en);sw.setAttribute("aria-checked",en?"true":"false");
  ch.className="chip "+s;ch.textContent=LB[s];rm.textContent=en?row.getAttribute("data-m"):"已跳过，不参与自动签到"
}
for(var ri=0;ri<rows.length;ri++)(function(row){
  var sw=row.querySelector(".sw");
  sw.addEventListener("liq",function(){
    var en=sw.getAttribute("aria-checked")==="true";
    setRow(row,!en);cntT();applyT();
    post("/prefs/skip?id="+encodeURIComponent(sw.getAttribute("data-id"))+"&on="+(en?1:0)).then(function(j){if(!j.ok)throw 0}).catch(function(){setRow(row,en);cntT();applyT();toast("保存失败，请重试")})
  })
})(rows[ri]);
var fcs=Q(".fc[data-f]");
for(var fi=0;fi<fcs.length;fi++)fcs[fi].onclick=function(){
  fs=this.getAttribute("data-f");
  for(var j=0;j<fcs.length;j++)fcs[j].setAttribute("aria-pressed",fcs[j]===this?"true":"false");
  applyT()
};
var qi=$("q");if(qi)qi.oninput=function(){qs=this.value.trim().toLowerCase();applyT()};
function bulk(skip){
  var ids=[],rs=[];
  for(var i=0;i<rows.length;i++){
    var r=rows[i];if(r.hidden)continue;
    var en=r.getAttribute("data-st")!=="skip";
    if(skip?en:!en){ids.push(r.querySelector(".sw").getAttribute("data-id"));rs.push(r)}
  }
  if(!ids.length){toast(skip?"没有需要跳过的超话":"没有需要启用的超话");return}
  var p=0,bad=0;
  (function next(){
    if(p>=ids.length){cntT();applyT();toast(bad?"部分保存失败，请重试":(skip?"已取消 ":"已启用 ")+ids.length+" 个");return}
    var part=ids.slice(p,p+40),rr=rs.slice(p,p+40);p+=40;
    post("/prefs/skip?on="+(skip?1:0)+"&ids="+encodeURIComponent(part.join(","))).then(function(j){
      if(!j.ok)throw 0;for(var q=0;q<rr.length;q++)setRow(rr[q],!skip)
    }).catch(function(){bad++}).then(next)
  })()
}
var ba=$("ball"),bn=$("bnone");if(ba)ba.onclick=function(){bulk(false)};if(bn)bn.onclick=function(){bulk(true)};
function refreshList(btn){
  if(btn.disabled)return;btn.disabled=true;var t=btn.textContent;btn.textContent="刷新中…";
  post("/api/refresh").then(function(j){
    toast(j.msg||(j.ok?"已刷新":"刷新失败"));
    if(j.ok)setTimeout(function(){location.reload()},700);else{btn.disabled=false;btn.textContent=t}
  }).catch(function(){toast("连不上脚本，请确认 Loon 已开启");btn.disabled=false;btn.textContent=t})
}
var rfs=Q("[data-refresh]");for(var xi=0;xi<rfs.length;xi++)rfs[xi].onclick=function(){refreshList(this)};
cntT();applyT();

// ---------- 签到记录（数据来自页面内嵌的 JSON，只含超话名称、结果、失败原因，不含登录信息） ----------
var LOG=[];try{LOG=JSON.parse($("logdata").textContent)}catch(e){}
var hd=0,hf="all",TR={cron:"定时",open:"补签",manual:"手动"};
function dk(t){var d=new Date(t);return d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate()}
function dl(k){var n=Date.now();if(k===dk(n))return"今天";if(k===dk(n-86400000))return"昨天";return Math.floor(k/100)%100+"月"+k%100+"日"}
function hm(t){var d=new Date(t);return("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2)}
function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function ents(run){
  var a=[],it=run.it||[];
  if(run.exp)a.push(["整体","fail","登录已失效，任务已中止"]);
  else if(run.net)a.push(["整体","unknown","没有收到微博服务器的响应，无法确认结果"]);
  for(var i=0;i<it.length;i++)a.push(it[i]);
  return a
}
function notice(box,t,p){var w=el("div","panel"),n=el("div","notice");n.appendChild(el("h2",null,t));if(p)n.appendChild(el("p",null,p));w.appendChild(n);box.appendChild(w)}
function drawH(){
  var box=$("hist"),dc=$("hdays");if(!box||!dc)return;
  var ds=[],i,j;
  for(i=0;i<LOG.length;i++){var k=dk(LOG[i].at);if(ds.indexOf(k)<0)ds.push(k)}
  box.textContent="";dc.textContent="";
  var hfc=Q(".fc[data-hf]");
  if(!ds.length){for(i=0;i<hfc.length;i++)hfc[i].querySelector("i").textContent="0";notice(box,"还没有签到记录","完成一次签到后，这里会按日期列出每个超话的结果");return}
  if(ds.indexOf(hd)<0)hd=ds[0];
  ds.forEach(function(k){var b=el("button","fc",dl(k));b.type="button";b.setAttribute("aria-pressed",k===hd?"true":"false");b.onclick=function(){hd=k;drawH()};dc.appendChild(b)});
  var runs=[],cnt={all:0,ok:0,already:0,fail:0,unknown:0,skip:0};
  for(i=0;i<LOG.length;i++)if(dk(LOG[i].at)===hd){runs.push(LOG[i]);var es=ents(LOG[i]);for(j=0;j<es.length;j++){cnt.all++;cnt[es[j][1]]++}}
  for(i=0;i<hfc.length;i++)hfc[i].querySelector("i").textContent=cnt[hfc[i].getAttribute("data-hf")]||0;
  var shown=0;
  box.appendChild(el("h2","day",dl(hd)+" · "+Math.floor(hd/100)%100+"月"+hd%100+"日"));
  runs.forEach(function(run){
    var es=ents(run).filter(function(e){return hf==="all"||e[1]===hf});
    if(!es.length)return;
    var ul=el("ul","list tlist"),h=el("li","hrow hrun");
    h.appendChild(el("time",null,hm(run.at)));
    h.appendChild(el("div","rt",(TR[run.tr]||"手动")+"签到 · 共 "+(run.total||0)+" 个"+(run.ms?" · 用时 "+Math.max(1,Math.round(run.ms/1000))+" 秒":"")));
    h.appendChild(el("span"));ul.appendChild(h);
    es.forEach(function(e){
      var li=el("li","hrow"),d=el("div");
      li.appendChild(el("span"));d.appendChild(el("div","rt",e[0]));if(e[2])d.appendChild(el("div","rm",e[2]));
      li.appendChild(d);li.appendChild(el("span","chip "+e[1],LB[e[1]]||""));ul.appendChild(li);shown++
    });
    box.appendChild(ul)
  });
  if(!shown)notice(box,"这一天没有「"+(LB[hf]||"")+"」记录")
}
var hfs=Q(".fc[data-hf]");
for(var hi=0;hi<hfs.length;hi++)hfs[hi].onclick=function(){
  hf=this.getAttribute("data-hf");
  for(var j=0;j<hfs.length;j++)hfs[j].setAttribute("aria-pressed",hfs[j]===this?"true":"false");
  drawH()
};

// ---------- 设置 ----------
var ss=Q(".sw[data-k]");
for(var ki=0;ki<ss.length;ki++)ss[ki].addEventListener("liq",function(){
  var el2=this,on=el2.getAttribute("aria-checked")==="true";
  el2.setAttribute("aria-checked",on?"false":"true");el2.disabled=true;
  post("/prefs/set?k="+el2.getAttribute("data-k")+"&v="+(on?0:1)).then(function(j){if(!j.ok)throw 0;el2.disabled=false}).catch(function(){el2.setAttribute("aria-checked",on?"true":"false");el2.disabled=false;toast("保存失败，请重试")})
});
function saveTime(v){post("/prefs/time?v="+encodeURIComponent(v)).then(function(j){toast(j.ok?"签到时间已保存":"保存失败，请检查时间格式");if(j.ok)setTimeout(function(){location.reload()},600)}).catch(function(){toast("连不上脚本，请确认 Loon 已开启")})}
// ── 时间拨盘（移植自 Bencho「Time scrubber」，MIT，bencho.dev/licence）──
// 原版是 React 组件；这个页面没有 React，所以把同一套逻辑原样改写成原生 JS（数值、弹簧、刻度一个没动，注释照原样保留）。
// 只有两处不同：弹簧不再单独成文件，直接写在下面；刻度用一个按分钟取整的对象池代替 React 的重渲染。
/* ══ Time scrubber ════════════════════════════════════════
   A time over a ruler. Drag the ruler under the centre mark and
   the time runs with it; fling it and it coasts, then settles on
   the nearest step.

   ── ONE SPRING FOR THE THROW AND THE SNAP ───────────────
   On release the landing is decided at once: where the ruler
   would coast to at the speed it was let go, rounded to the
   nearest step. Then one spring carries it there, starting with
   the hand's own velocity — so a flick coasts and a slow
   release just settles, and there is no seam between "gliding"
   and "snapping" because they are the same motion.

   ── A DIAL SEEN FROM THE FRONT ──────────────────────────
   Ticks at the centre stand tall and dark and fall away toward
   the edges, in height and in ink, which is what makes a flat
   strip read as the face of a wheel. Only the ticks near the
   window are drawn at all, so a day of them costs thirty. */

/* ── inlined from lab/spring ──────────────────────── */
/* ── one spring, for everything that settles ───────────────
   The maths was already on this bench twice, copied by hand:
   Humidity's wheel and Brightness's column both accumulate
   velocity toward a target, damp it, and snap when both the
   delta and the velocity fall under 0.02. Two copies is a
   coincidence; five would be a policy, so it comes out here
   before the elastic blocks are written against it.

   The two shipped copies are deliberately NOT refactored onto
   this. They work, they are tuned, and rewriting the innards
   of two live components to prove a point about duplication
   is how a good afternoon becomes a bad one. This is the one
   new code uses.

   Frames, not milliseconds. "dt" is expressed in sixtieths of
   a second and the damping is RAISED to it rather than
   multiplied by it, so a dropped frame decays the same amount
   of energy as the two frames it replaced. Multiplying is the
   version that makes a spring behave differently on a busy
   page, which is the hardest kind of bug to see.

   The loop parks itself the moment the value has settled.
   CLAUDE.md is not complimentary about the one permanent
   requestAnimationFrame already on this bench and there is no
   case for five more. */

/* Read once, the way the wheel and the pill nav do. A
   preference, not a live input. */
var TMS_STILL=!!(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches);

var TMS_W=300;
/* px per minute along the ruler */
var TMS_PX=2,TMS_HALF=(TMS_W-36)/2,TMS_DAY=1440;

function tmsClamp(v,a,b){return Math.min(b,Math.max(a,v))}
function tmsWrap(m){return((m%TMS_DAY)+TMS_DAY)%TMS_DAY}

function tmsLabel(m,h24){
  var t=tmsWrap(Math.round(m)),h=Math.floor(t/60),mm=("0"+(t%60)).slice(-2);
  if(h24)return{time:("0"+h).slice(-2)+":"+mm,mer:""};
  return{time:(h%12||12)+":"+mm,mer:h<12?"AM":"PM"}
}

/* ── a digit that rolls, through a window that fades ────────
   A strip of 0–9 slides to the digit, as it did first — but the
   window it slides through is taller than the line and fades to
   nothing at its top and bottom instead of clipping. Each digit
   sits in a cell with room above and below it, so at rest the
   neighbours are wholly outside the window, and on the move a
   digit leaves and arrives through the fade rather than being
   sliced by an edge. It smears a little while it rolls: a short
   blur restarted on every change, two names taken in turn
   because re-applying the same one does not replay. */
function tmsDigit(){
  var col=el("span","tms-col"),strip=el("span","tms-strip");
  for(var n=0;n<10;n++)strip.appendChild(el("span","",String(n)));
  col.appendChild(strip);
  return{col:col,strip:strip,prev:null,flip:false}
}
function tmsSetDigit(d,ch){
  if(d.prev===ch)return;
  if(d.prev!==null){d.flip=!d.flip;d.strip.setAttribute("data-flip",d.flip?"a":"b")}
  d.prev=ch;
  d.strip.style.transform="translateY("+(-Number(ch)*1.5)+"em)"
}

function timeScrubber(o){
  o=o||{};
  var step=Number(o.step)||15,
      /* how far a fling carries, 0..100 */
      momentum=o.momentum==null?50:o.momentum,
      h24=o.format==="24h",
      corner=o.corner==null?20:o.corner,
      /* what it settles on, minutes */
      start=o.start==null?570:o.start;
  var p={x:start,v:0,to:start},raf=0,g=null,idle=0,lastStep=Math.floor(start/step);

  var root=el("div","tms");
  root.style.setProperty("--tms-r",Math.max(0,corner)+"px");
  var read=el("div","tms-read"),timeEl=el("span","tms-time"),merEl=el("span","tms-mer");
  read.setAttribute("aria-live","polite");read.appendChild(timeEl);read.appendChild(merEl);
  var ruler=el("div","tms-ruler"),track=el("div","tms-track"),mark=el("span","tms-mark");
  ruler.tabIndex=0;ruler.setAttribute("role","slider");ruler.setAttribute("aria-label","签到时间");
  ruler.setAttribute("aria-valuemin","0");ruler.setAttribute("aria-valuemax",String(TMS_DAY-1));
  mark.setAttribute("aria-hidden","true");
  ruler.appendChild(track);ruler.appendChild(mark);
  root.appendChild(read);root.appendChild(ruler);

  /* ── the digits, and the ticks in the window ───────────── */
  var digs={},colons={},pat="",tickEls={},hourEls={};
  function render(){
    var pos=p.x,lb=tmsLabel(pos,h24),time=lb.time,i,c,node;
    var np=time.replace(/[0-9]/g,"d");
    if(np!==pat){
      pat=np;timeEl.textContent="";
      for(i=0;i<time.length;i++){
        c=time.charAt(i);
        if(c===":")node=colons[i]||(colons[i]=el("span","tms-colon",":"));
        else{var k=time.length-i;node=(digs[k]||(digs[k]=tmsDigit())).col}
        timeEl.appendChild(node)
      }
    }
    for(i=0;i<time.length;i++){c=time.charAt(i);if(c!==":")tmsSetDigit(digs[time.length-i],c)}
    merEl.textContent=lb.mer;merEl.hidden=!lb.mer;
    read.setAttribute("aria-label",(time+" "+lb.mer).replace(/ $/,""));
    ruler.setAttribute("aria-valuetext",(time+" "+lb.mer).replace(/ $/,""));
    ruler.setAttribute("aria-valuenow",String(tmsWrap(Math.round(pos))));

    var span=TMS_HALF/TMS_PX+10,seenT={},seenH={};
    for(var m=Math.ceil((pos-span)/5)*5;m<=pos+span;m+=5){
      var x=(m-pos)*TMS_PX,f=tmsClamp(1-Math.pow(Math.abs(x)/TMS_HALF,2),0,1),w=tmsWrap(m);
      var kind=w%60===0?"hour":w%15===0?"quarter":"five";
      var t=tickEls[m];
      if(!t){t=tickEls[m]=el("span","tms-tick");t.setAttribute("data-kind",kind);track.appendChild(t)}
      t.style.transform="translateX("+x.toFixed(2)+"px) scaleY("+(.55+.45*f).toFixed(3)+")";
      t.style.opacity=.18+.82*f;seenT[m]=1;
      if(kind==="hour"){
        var h=Math.floor(w/60),lab=hourEls[m];
        if(!lab){lab=hourEls[m]=el("span","tms-hour",h24?("0"+h).slice(-2):(h%12||12)+" "+(h<12?"AM":"PM"));track.appendChild(lab)}
        lab.style.transform="translateX("+x.toFixed(2)+"px) translateX(-50%)";
        lab.style.opacity=.15+.85*f;seenH[m]=1
      }
    }
    var key;
    for(key in tickEls)if(!seenT[key]){track.removeChild(tickEls[key]);delete tickEls[key]}
    for(key in hourEls)if(!seenH[key]){track.removeChild(hourEls[key]);delete hourEls[key]}
  }

  /* a tick under the thumb for every step crossed, a firmer one
     on the hour */
  function hear(x){
    var k=Math.floor(x/step);
    if(k===lastStep)return;
    lastStep=k;
    if(o.onStep)o.onStep(k*step)
  }
  function set(x){p.x=x;hear(x);render()}

  function run(){
    if(raf)return;
    var prev=0;
    function tick(t){
      var dt=prev?tmsClamp((t-prev)/16.67,0,2.5):1;
      prev=t;
      /* near-critical: glides in and lands with a hint of give,
         no swing back and no slow creep at the end */
      p.v+=((p.to-p.x)*.022-p.v*.26)*dt;
      var x=p.x+p.v*dt;
      if(Math.abs(p.to-x)<.01&&Math.abs(p.v)<.01){p.v=0;set(p.to);raf=0;return}
      set(x);
      raf=requestAnimationFrame(tick)
    }
    raf=requestAnimationFrame(tick)
  }

  /* go to a time, by the spring */
  function goTo(to,v){
    p.to=to;
    p.v=v==null?p.v:v;
    if(TMS_STILL){p.v=0;set(to);return}
    run()
  }

  /* ── the drag ──────────────────────────────────────────── */
  ruler.addEventListener("pointerdown",function(e){
    try{ruler.setPointerCapture(e.pointerId)}catch(_){/* a scripted pointer */}
    cancelAnimationFrame(raf);raf=0;
    var k=ruler.getBoundingClientRect().width/ruler.offsetWidth||1;
    g={x:e.clientX,t:performance.now(),v:0,k:k};
    p.v=0
  });
  ruler.addEventListener("pointermove",function(e){
    if(!g)return;
    var now=performance.now();
    /* left is later: the ruler moves under a fixed mark */
    var dm=-(e.clientX-g.x)/g.k/TMS_PX,dt=Math.max(1,now-g.t)/16.67;
    g.v=g.v*.5+(dm/dt)*.5;
    g.x=e.clientX;
    g.t=now;
    set(p.x+dm)
  });
  function onUp(e){
    var h=g;g=null;
    try{ruler.releasePointerCapture(e.pointerId)}catch(_){/* never captured */}
    if(!h)return;
    /* a hand that stopped before letting go threw nothing */
    /* capped, so a flick spins it hours, never days */
    var v=performance.now()-h.t>80?0:tmsClamp(h.v,-14,14);
    var carry=6+(tmsClamp(momentum,0,100)/100)*30;
    var land=Math.round((p.x+v*carry)/step)*step;
    /* the landing already includes the throw, so the spring starts
       with only part of the hand's speed — the whole of it on top
       would carry it well past the step and swing back */
    goTo(land,v*.6)
  }
  ruler.addEventListener("pointerup",onUp);
  ruler.addEventListener("pointercancel",onUp);

  /* a trackpad's sideways swipe moves it too — only sideways, so
     scrolling the page past the block is never caught */
  ruler.addEventListener("wheel",function(e){
    if(Math.abs(e.deltaX)<=Math.abs(e.deltaY))return;
    e.preventDefault();
    cancelAnimationFrame(raf);raf=0;
    set(p.x+e.deltaX/TMS_PX);
    clearTimeout(idle);
    idle=setTimeout(function(){goTo(Math.round(p.x/step)*step,0)},120)
  },{passive:false});

  ruler.addEventListener("keydown",function(e){
    var d=e.key==="ArrowRight"?step:e.key==="ArrowLeft"?-step:0;
    if(!d)return;
    e.preventDefault();
    goTo(Math.round(p.to/step)*step+d,0)
  });

  render();
  return{
    el:root,
    /* where it is headed, as minutes in the day */
    value:function(){return tmsWrap(Math.round((raf||g?p.to:p.x)/step)*step)}
  }
}

var tp=$("tpop");
if(tp){
  var tb=$("tbtn"),tmn=$("tmenu"),tin=$("tinner"),trow=$("trow"),cv=tp.getAttribute("data-v").split(":"),def=tp.getAttribute("data-def"),cust=tp.getAttribute("data-custom")==="1";
  var ttl=el("div","pop-title");ttl.innerHTML='<span>签到时间</span><svg viewBox="0 0 24 24"><path d="M6 14l6-6 6 6"/></svg>';
  /* 24 小时制、一分钟一档：签到时间要精确到分（默认 00:01），15 分钟一档落不到 */
  var scr=timeScrubber({step:1,momentum:50,format:"24h",corner:14,start:(+cv[0])*60+(+cv[1])});
  var sv=el("button","pop-item pop-save","保存");sv.type="button";
  tin.appendChild(ttl);tin.appendChild(scr.el);tin.appendChild(el("div","pop-sep"));tin.appendChild(sv);
  if(cust){var rs=el("button","pop-item","恢复默认（"+def+"）");rs.type="button";rs.onclick=function(){saveTime("")};tin.appendChild(rs)}
  for(var q=0;q<tin.children.length;q++){tin.children[q].style.setProperty("--i",q);tin.children[q].style.setProperty("--n",tin.children.length)}
  function measure(){var s=tmn.style;s.setProperty("--bw",tb.offsetWidth+"px");s.setProperty("--bh",tb.offsetHeight+"px");s.setProperty("--mw",tin.offsetWidth+2+"px");s.setProperty("--mh",tin.offsetHeight+2+"px")}
  function isOpen(){return tmn.getAttribute("data-open")==="true"}
  function setOpen(o){
    if(o){measure();tmn.style.transition="none";void tmn.offsetWidth;tmn.style.transition=""}
    var v=o?"true":"false";tmn.setAttribute("data-open",v);tp.setAttribute("data-open",v);tb.setAttribute("aria-expanded",v);trow.classList.toggle("pop-open",o);
    if(o)setTimeout(function(){tmn.scrollIntoView({block:"nearest",behavior:"smooth"})},60)
  }
  tb.onclick=function(){setOpen(!isOpen())};
  ttl.onclick=function(){setOpen(false);tb.focus()};
  sv.onclick=function(){var v=tmsLabel(scr.value(),true).time;setOpen(false);if(v===tp.getAttribute("data-v")){toast("时间没有变化");return}saveTime(v)};
  document.addEventListener("click",function(e){if(isOpen()&&!tp.contains(e.target))setOpen(false)});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&isOpen()){setOpen(false);tb.focus()}})
}
var rl=$("rl");if(rl)rl.onclick=function(){location.reload()};


// ── 液态开关（移植自 Bencho「Liquid toggle」，MIT，bencho.dev/licence）──
// 一个水滴：手指拖着走，松手后由弹簧落到两端；拖得越快越被拉长（面积不变：scaleY = 1/scaleX）。
// 原版没有第二个「拖尾」水滴，也不用 goo 滤镜 —— 一个圆没有什么可融合的，滤镜只会把边缘糊掉；这里同样是一个普通圆。
// 比原版（92×46，水滴 36）小一圈、比例不变：水滴四周留的空隙，两端和上下相等。
// 位置是一个数，手指和弹簧都往里写；抓住它时弹簧不干预，松手后从当前位置接着落。一次没动过的按下 = 点击，照样切换。
var LQW=58,LQH=32,LQT=24,LQP=(LQH-LQT)/2,LQO=LQW-LQT-LQP,LQM=(LQP+LQO)/2,LQSTILL=!!(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches);
function liquify(sw){
  var th=document.createElement("span");th.className="lt";sw.appendChild(th);
  var isOn=function(){return sw.getAttribute("aria-checked")==="true"};
  var x=isOn()?LQO:LQP,v=0,ev=0,held=false,raf=0,last=0,grip=null;
  var fire=function(){sw.dispatchEvent(new Event("liq"))};
  function paint(){var k=1+Math.min(.4,Math.abs(ev)/600)*.36;th.style.transform="translate3d("+x.toFixed(2)+"px,0,0) scale("+k.toFixed(3)+","+(1/k).toFixed(3)+")"}
  function frame(t){
    raf=0;var dt=Math.min(.034,Math.max(.001,(t-last)/1000));last=t;
    var target=isOn()?LQO:LQP;
    if(!held){
      if(LQSTILL){x=target;v=0}
      else{ // 弹簧：刚度 170、阻尼 21.5、质量 0.9 —— 到站时只带一点点回弹，不是「甩过去」
        var n=Math.ceil(dt/.008),h=dt/n;
        for(var i=0;i<n;i++){v+=(-170*(x-target)-21.5*v)/.9*h;x+=v*h}
        if(x<1){x=1;if(v<0)v=0}else if(x>LQW-LQT-1){x=LQW-LQT-1;if(v>0)v=0} // 回弹最多顶到轨道边缘，水滴不会冲出轨道
        if(Math.abs(x-target)<.02&&Math.abs(v)<.5){x=target;v=0}
      }
    }else v*=.8;
    ev+=(v-ev)*.35;if(!held&&v===0&&Math.abs(ev)<.5)ev=0;
    paint();
    if(held||v!==0||ev!==0||x!==target)raf=requestAnimationFrame(frame)
  }
  function go(){if(!raf){last=performance.now();raf=requestAnimationFrame(frame)}}
  sw.addEventListener("pointerdown",function(e){
    if(sw.disabled||(e.pointerType==="mouse"&&e.button!==0))return;
    // 偏移量等第一次移动时才取：按在轨道任何位置都不会让水滴瞬移
    grip={id:e.pointerId,grab:null,moved:false,t:0};held=true;
    try{sw.setPointerCapture(e.pointerId)}catch(_){}
    go()
  });
  sw.addEventListener("pointermove",function(e){
    var g=grip;if(!g||g.id!==e.pointerId)return;
    var at=e.clientX-sw.getBoundingClientRect().left;
    if(g.grab===null)g.grab=at-x;
    var nx=Math.min(LQO,Math.max(LQP,at-g.grab)),now=performance.now();
    if(Math.abs(nx-x)>.4)g.moved=true;
    if(g.t)v=Math.max(-2000,Math.min(2000,(nx-x)/Math.max(.008,(now-g.t)/1000)));
    g.t=now;x=nx;
    if(g.moved&&(nx>LQM)!==isOn())fire(); // 过了中线就切换，轨道在手指下面回应
    go()
  });
  function end(e){
    var g=grip;if(!g)return;grip=null;
    try{sw.releasePointerCapture(e.pointerId)}catch(_){}
    held=false;
    if(!g.moved&&e.type==="pointerup")fire();
    go()
  }
  sw.addEventListener("pointerup",end);sw.addEventListener("pointercancel",end);
  sw.addEventListener("click",function(e){if(e.detail===0)fire()}); // 键盘（空格 / 回车）仍是普通开关
  new MutationObserver(go).observe(sw,{attributes:true,attributeFilter:["aria-checked"]}); // 别处改了状态（批量、保存失败回滚）也会落过去
  paint()
}
var lqs=Q(".sw");for(var qi2=0;qi2<lqs.length;qi2++)liquify(lqs[qi2]);

// ── 浮标签输入框（移植自 Bencho「Label input」，MIT）──
// 标签就是占位符；聚焦时标签升到上边线并逐字跳一下，轮廓变色，上边线从中间向两边让出缺口。
// 缺口 = 标签自己的宽度（量出来的），而且开在上边线的直线段上，圆角越大标签越靠里。轮廓宽度随容器变，所以用 ResizeObserver 重画。
var lb=$("lbi");
if(lb){
  var lbox=$("lbib"),lring=$("lbir"),llab=$("lbil"),lin=$("q"),LHT=48,LRD=16,LSC=.78,LNW=.75,lw=0;
  var ltx=llab.textContent;llab.textContent="";
  for(var ci=0;ci<ltx.length;ci++){var lsp=document.createElement("span");lsp.style.setProperty("--i",ci);lsp.textContent=ltx.charAt(ci);llab.appendChild(lsp)}
  function lbiState(){
    var f=document.activeElement===lin,fl=lin.value.length>0;
    lb.setAttribute("data-focus",f?"true":"false");lb.setAttribute("data-up",f||fl?"true":"false");lb.setAttribute("data-filled",fl?"true":"false")
  }
  function lbiFit(){
    var W=lbox.offsetWidth;if(!W)return;
    if(!lw)lw=llab.offsetWidth;
    var r=LRD,lx=Math.max(14,r+4),x0=Math.max(r*.6,lx-5),x1=lx+lw*LSC+5,a=r-LNW,R=W-LNW,B=LHT-LNW,mid=W/2,nm=(x0+x1)/2;
    var right="M"+x1+","+LNW+" L"+(W-r)+","+LNW+" A"+a+","+a+" 0 0 1 "+R+","+r+" L"+R+","+(LHT-r)+" A"+a+","+a+" 0 0 1 "+(W-r)+","+B+" L"+mid+","+B;
    var left="M"+x0+","+LNW+" L"+r+","+LNW+" A"+a+","+a+" 0 0 0 "+LNW+","+r+" L"+LNW+","+(LHT-r)+" A"+a+","+a+" 0 0 0 "+r+","+B+" L"+mid+","+B;
    lring.setAttribute("width",W);lring.setAttribute("height",LHT);lring.setAttribute("viewBox","0 0 "+W+" "+LHT);
    lring.innerHTML='<path d="'+right+'"/><path d="'+left+'"/><path class="lbi-gap" pathLength="1" d="M'+nm+","+LNW+" L"+x0+","+LNW+'"/><path class="lbi-gap" pathLength="1" d="M'+nm+","+LNW+" L"+x1+","+LNW+'"/>';
    lbox.style.setProperty("--lbi-x",lx+"px")
  }
  lin.addEventListener("focus",lbiState);lin.addEventListener("blur",lbiState);lin.addEventListener("input",lbiState);
  if(window.ResizeObserver)new ResizeObserver(lbiFit).observe(lbox);else addEventListener("resize",lbiFit);
  lbiFit()
}

// 危险操作二次确认：第一次点击变成「确认 / 取消」，4 秒不操作自动还原
var cf=Q(".cfm");
for(var a=0;a<cf.length;a++)(function(b){
  var tm,go2=b.querySelector("[data-go]"),cn=b.querySelector("[data-cn]");
  function rs(){b.removeAttribute("data-ask");clearTimeout(tm)}
  if(go2)go2.onclick=function(){b.setAttribute("data-ask","");clearTimeout(tm);tm=setTimeout(rs,4000)};
  if(cn)cn.onclick=rs
})(cf[a]);

// 页面恢复（返回键 / 缓存）：重新载入，避免显示旧结果；正在签到时保持「签到中」按钮
addEventListener("pageshow",function(e){
  if(e.persisted){location.reload();return}
  var rb=$("run"),pg=$("prog");if(rb&&pg&&pg.hidden)rb.removeAttribute("data-done")
});
// 从微博 / 其他应用切回来且超过 1 分钟：静默刷新一次，让定时签到的结果及时显示
var born=Date.now();
document.addEventListener("visibilitychange",function(){
  if(document.hidden||Date.now()-born<60000)return;
  var pg=$("prog");if(pg&&!pg.hidden)return;
  var ae=document.activeElement;if(ae&&ae.tagName==="INPUT")return;
  location.reload()
});
// 导航吸顶后才显示顶部模糊（用一个零高度的哨兵判断，滚动时只在 rAF 里量一次）
var nv=document.querySelector(".nav"),nsn=$("navs"),tk=0;
var bb=document.querySelector(".bblur"),nt=null;
function stuck(){tk=0;if(!nv||!nsn)return;if(nt===null)nt=parseFloat(getComputedStyle(nv).top)||0;var t=nt;if(nsn.getBoundingClientRect().top<=t+0.5)nv.setAttribute("data-stuck","");else nv.removeAttribute("data-stuck");if(bb){if(document.documentElement.scrollHeight-innerHeight-(window.pageYOffset||0)>8)bb.setAttribute("data-on","");else bb.removeAttribute("data-on")}}
addEventListener("scroll",function(){if(!tk)tk=requestAnimationFrame(stuck)},{passive:true});addEventListener("resize",function(){nt=null;if(!tk)tk=requestAnimationFrame(stuck)});stuck();
show(curV(),false);
var si2=$("segi");if(si2)requestAnimationFrame(function(){requestAnimationFrame(function(){si2.className="seg-i on"})});
})();`;

// 签到进度：点「立即签到」后页面不跳转，而是请求 /run/go（脚本在后台签到），同时每秒轮询 /run/progress 显示进度
// 签到进度：点「立即签到」后页面不跳转，而是请求 /run/go（脚本在后台签到），同时每秒轮询 /run/progress 显示进度
const PROG_JS = `(function(){
var $=function(i){return document.getElementById(i)};
var rb=$('run'),box=$('prog');if(!box)return;
var bar=$('pbar'),tt=$('pt'),cur=$('pc'),qq=$('pq'),ul=$('pl');
var t0=0,shown=0,tm,fails=0,gone=0,seen=0,fin=0,LB={ok:'成功',already:'已签',fail:'失败',unknown:'未确认'};
function setc(k,v){var e=$('c-'+k);if(e)e.textContent=v}
function paint(p){
  var tot=p.total||0,n=p.n||0,it=p.items||[],c={ok:0,already:0,fail:0,unknown:0};
  for(var i=0;i<it.length;i++)if(c[it[i].s]!=null)c[it[i].s]++;
  box.hidden=false;
  bar.style.width=(p.phase==='done'?100:tot?Math.max(4,n/tot*100):6)+'%';
  setc('ok',c.ok);setc('already',c.already);setc('fail',c.fail);setc('unknown',c.unknown);setc('skip',p.muted||0);
  var q=(p.q||[]).slice(n+(p.cur?1:0));
  if(p.phase==='list'){tt.textContent='正在读取关注的超话…';cur.textContent='';qq.textContent=''}
  else if(p.phase==='done'){tt.textContent='签到完成 · 共处理 '+n+' 个';cur.textContent='';qq.textContent='';box.className='panel prog fin'}
  else{
    tt.textContent='正在签到 · '+n+'/'+tot;cur.textContent=p.cur?'正在处理：'+p.cur:'';
    qq.textContent=q.length?'等待中：'+q.slice(0,3).join('、')+(q.length>3?' 等 '+q.length+' 个':''):''
  }
  for(;shown<it.length;shown++){
    var li=document.createElement('li'),a=document.createElement('span'),b=document.createElement('span');
    a.textContent=it[shown].n;b.className='chip '+it[shown].s;b.textContent=LB[it[shown].s]||'';
    li.appendChild(a);li.appendChild(b);ul.insertBefore(li,ul.firstChild)
  }
}
function done(){if(fin)return;fin=1;clearTimeout(tm);setTimeout(function(){location.replace('/?r='+Date.now()+'&m=done#overview')},1800)}
function poll(){
  fetch('/run/progress?_='+Date.now()).then(function(r){return r.json()}).then(function(p){
    fails=0;
    if(p&&p.phase&&p.id>=t0-5000){seen=1;paint(p);if(p.phase==='done'){done();return}}
    else if(gone&&!seen){location.reload();return}
    tm=setTimeout(poll,1000)
  }).catch(function(){if(++fails>8){location.reload();return}tm=setTimeout(poll,2000)})
}
function start(e){
  if(e)e.preventDefault();if(!rb||rb.hasAttribute('data-done'))return;
  rb.setAttribute('data-done','');t0=Date.now();shown=0;seen=0;gone=0;ul.innerHTML='';box.className='panel prog';
  paint({phase:'list'});window.scrollTo({top:0,behavior:'smooth'});
  fetch('/run/go').then(function(r){return r.json()}).then(function(){gone=1}).catch(function(){gone=1});
  tm=setTimeout(poll,700)
}
if(rb)rb.onclick=start;
if(box.getAttribute('data-live')){if(rb)rb.setAttribute('data-done','');box.hidden=false;poll()}
})();`;

function loginPage(qr) {
  const web = readJ(WEB_KEY);
  const img = qr.image ? (qr.image.indexOf("//") === 0 ? "https:" + qr.image : qr.image) : "";
  const scan = "https://passport.weibo.cn/signin/qrcode/scan?qr=" + qr.id + "&sinainternalbrowser=topnav&showmenu=0";
  const app = "sinaweibo://browser?url=" + encodeURIComponent(scan);
  const ck = svgi(IC.check).replace(/"/g, "'");
  // 轮询：从微博切回来时立即检查；没扫码 2.5 分钟（扫了码 5 分钟）后停止并提示重新获取；连续出错时提示检查 Loon
  const js = [
    "(function(){var m=document.getElementById('m'),w=document.getElementById('w'),re=document.getElementById('re'),",
    "ic=[document.getElementById('s1'),document.getElementById('s2'),document.getElementById('s3')],CK=\"" + ck + "\",",
    "t0=Date.now(),busy=0,tm=0,dead=0,errs=0,sc=0;",
    "function mark(n){for(var i=0;i<3;i++){ic[i].className='ico'+(i<n?' ok':'');ic[i].innerHTML=i<n?CK:(i+1)}}",
    "function stop(t){dead=1;clearTimeout(tm);m.textContent=t;w.className='wait fail';re.style.display=''}",
    "function tick(){if(dead||busy)return;if(Date.now()-t0>(sc?300000:150000)){stop('二维码已超时，请重新获取');return}busy=1;",
    "fetch('/login/check').then(function(r){return r.json()}).then(function(j){busy=0;errs=0;m.textContent=j.msg||'';",
    "if(j.s==='scanned'){sc=1;mark(2)}",
    "if(j.s==='ok'){dead=1;mark(3);w.className='wait done';setTimeout(function(){location.replace('/?m=login')},700);return}",
    "if(j.s==='fail'){stop(j.msg||'二维码已失效，请重新获取');return}",
    "tm=setTimeout(tick,2000)}).catch(function(){busy=0;errs++;if(errs>=4)m.textContent='连不上脚本，请确认 Loon 已开启';tm=setTimeout(tick,3000)})}",
    "document.addEventListener('visibilitychange',function(){if(!document.hidden&&!dead){clearTimeout(tm);tick()}});tick()})();",
  ].join("");
  const step = (id, n, t, d) => '<div class="row"><span class="ico" id="' + id + '">' + n + '</span><div><div class="rt">' + t + '</div><div class="rm">' + d + "</div></div></div>";
  return shellOpen("扫码登录") + '<main class="shell">' + headHtml("扫码登录", "微博网页版 · 扫一次码，长期有效") +
    (web ? '<p class="note">当前已登录' + (web.nick ? "：" + esc(web.nick) : "") + "，重新扫码会替换当前的网页登录。</p>" : "") +
    '<section class="panel s1">' + step("s1", 1, "在微博中打开确认页", "点下面的按钮，会跳到微博 App") + step("s2", 2, "点「确认登录」", "在微博里确认这次登录") + step("s3", 3, "自动完成", "回到这里，页面会自动跳回状态页") + "</section>" +
    '<a class="btn btn-primary btn-lg s2" href="' + esc(app) + '">在微博中打开确认</a>' +
    (img ? '<section class="panel qr s3" style="margin-top:14px"><img src="' + esc(img) + '" alt="二维码" referrerpolicy="no-referrer"><div class="rm">或用另一台设备的微博扫一扫</div></section>' : "") +
    '<div class="wait s4" id="w" aria-live="polite" style="margin-top:14px">' + SPIN + '<span id="m">等待确认…</span></div>' +
    '<a id="re" class="btn btn-lg" style="display:none" href="/login">重新获取二维码</a>' +
    '<div class="foot"><a href="/">返回状态页</a></div></main><script>' + js + "</script></body></html>";
}

// ---------- 设置页：账号（重新扫码 / 退出登录）+ 签到偏好（跳过某些超话）+ 清除记录 ----------
const rowHtml = (cls, ico, title, meta, right) => '<div class="row"><span class="ico ' + cls + '">' + svgi(IC[ico]) + '</span><div><div class="rt">' + title + '</div><div class="rm">' + esc(meta) + "</div></div>" + (right || "") + "</div>";
const confirmBtn = (label, href, okLabel) => '<span class="cfm"><button class="btn btn-danger" type="button" data-go>' + label + '</button><a class="btn btn-danger-fill" href="' + href + '" data-cf>' + okLabel + '</a><button class="btn btn-ghost" type="button" data-cn>取消</button></span>';

// ---------- 控制台数据 ----------
const fmtDT = (t) => { const d = new Date(t); return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + clock(t); };
const when = (t) => (ymd(t) === today() ? "今天 " + clock(t) : fmtDT(t));
const TRIG = { cron: "定时", open: "补签", manual: "手动" };
const STL = { pending: "待签到", ok: "签到成功", already: "已签到", fail: "签到失败", unknown: "未确认", skip: "已跳过" };
const LS_TXT = {
  full: ["FULL", "完整获取", "已读取到全部关注的超话"],
  partial: ["PARTIAL", "部分获取", "只读到一部分关注的超话；没获取到的超话不会被当作已签到"],
  visited: ["VISITED", "仅访问记录", "没有读到关注列表，只包含访问过的超话，无法确认是否完整"],
  none: ["—", "未获取", "还没有读取过关注列表，点「刷新超话列表」试一次"],
};
const readCsrf = () => { let t = $persistentStore.read(CSRF_KEY); if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); $persistentStore.write(t, CSRF_KEY); } return t; };

// 超话清单 = 保存的关注列表（没有就用访问过的）+ 已跳过的；每个超话只在「今天确实有结果」时才显示为已完成
function topicList(st, prefs, tl) {
  const out = new Map(), d = today(), last = st.last || {};
  for (const t of (tl && tl.items) || []) out.set(t.id, { id: t.id, name: t.name || label(t.id), pic: t.pic || "" });
  if (!out.size) for (const id of Object.keys(st.topics || {})) out.set(id, { id, name: (last[id] && last[id].n) || label(id), pic: "" });
  if (!out.size) for (const i of (st.run && st.run.items) || []) if (i.id && i.st !== "skip") out.set(i.id, { id: i.id, name: i.name || label(i.id), pic: "" }); // 旧版本只留下了上次结果：先用它顶一下，下次签到或刷新后换成完整列表
  for (const id of Object.keys(prefs.skip)) if (!out.has(id)) out.set(id, { id, name: prefs.skip[id] || label(id), pic: "" });
  return Array.from(out.values()).map((t) => {
    const l = last[t.id], skip = !!prefs.skip[t.id];
    const s0 = l && ymd(l.at) === d ? l.s : "pending";
    return Object.assign(t, { skip, s0, s: skip ? "skip" : s0, at: (l && l.ok) || 0, m: (l && l.m) || "" });
  });
}
function nextPlan(st, prefs) {
  if (!prefs.auto) return "自动签到已关闭";
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  const au = st.auto && st.auto.day === today() ? st.auto : null;
  if (au && au.done) return "明天 " + SCHED_TEXT;
  if (mins < SCHED) return "今天 " + SCHED_TEXT;
  if (au && au.tries && au.last) { const at = au.last + 10 * 60000; return at > Date.now() ? "约 " + clock(at) + " 重试" : "即将重试"; }
  return "下次检查（每 5 分钟）";
}
function resultText(r) {
  if (!r) return ["", "还没有签到记录"];
  if (r.expired) return ["bad", "登录已失效，任务中止"];
  if (r.netFail) return ["warn", "网络失败，结果未确认"];
  if (r.fail) return ["bad", "部分失败"];
  if (r.unknown) return ["warn", "部分结果未确认"];
  if (r.skipped) return ["warn", "超时，未全部处理"];
  if (r.listState === "partial" || r.listState === "visited") return ["warn", "完成，但列表不完整"];
  return ["ok", "全部完成"];
}
function apiState() {
  const web = readJ(WEB_KEY), st = readState(), prefs = readPrefs(), tl = readJ(TL_KEY) || {};
  const topics = topicList(st, prefs, tl), c = { pending: 0, ok: 0, already: 0, fail: 0, unknown: 0, skip: 0 };
  topics.forEach((t) => { c[t.s]++; });
  const lv = loginView(st), pg = readJ(PROG_KEY);
  return {
    login: { state: web ? (st.login.state === "expired" ? "expired" : "ok") : "none", nick: (web && web.nick) || "" },
    running: lockFresh() || !!(pg && pg.phase !== "done" && Date.now() - pg.upd < 120000),
    list: { state: tl.state || "none", at: tl.at || 0, total: topics.length },
    today: c, last: st.run ? { at: st.run.at, trigger: st.run.trigger, total: st.run.total, text: resultText(st.run)[1] } : null,
    auto: { on: prefs.auto, time: SCHED_TEXT, next: nextPlan(st, prefs) }, loginText: lv.t,
  };
}

// 手动刷新超话列表：只读关注列表并保存，不签到；与签到任务共用同一把锁
async function refreshTopics() {
  const web = readJ(WEB_KEY);
  if (!web) return { ok: false, msg: "还没有登录，请先扫码登录" };
  const tok = await lockAcquire();
  if (!tok) return { ok: false, msg: "签到任务正在执行，稍后再刷新" };
  try {
    const r = await fetchListWeb(web);
    const state = r.complete ? "full" : r.topics.length ? "partial" : "none";
    if (r.topics.length) writeJ(TL_KEY, { at: Date.now(), state, note: r.note, items: r.topics.map((t) => ({ id: t.id, name: t.name, pic: t.pic || "" })) });
    const st = readState(); st.login = { state: "ok", verified: Date.now(), route: "web" }; writeJ(STATE_KEY, st);
    if (!r.topics.length) return { ok: false, msg: r.note || "没有读到关注的超话" };
    return { ok: true, count: r.topics.length, state, msg: state === "full" ? "已刷新，共 " + r.topics.length + " 个超话" : "只读到部分超话（" + r.topics.length + " 个）：" + friendly(r.note) };
  } catch (e) {
    if (e && e.expired) { const st = readState(); st.login = { state: "expired", route: "web" }; writeJ(STATE_KEY, st); return { ok: false, msg: "登录已失效，请重新扫码" }; }
    return { ok: false, msg: "读取失败：" + friendly(String((e && e.message) || e)) };
  } finally { lockRelease(tok); }
}

// ---------- 页面 ----------
const swRow = (title, desc, k, on) => '<div class="srow"><div><div class="rt">' + title + '</div><div class="rm">' + desc + '</div></div><button class="sw" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '" aria-label="' + title + '" data-k="' + k + '"></button></div>';
const infoRow = (title, desc, right) => '<div class="srow"><div><div class="rt">' + title + '</div><div class="rm">' + esc(desc) + "</div></div>" + (right || "") + "</div>";

function renderConsole() {
  const web = readJ(WEB_KEY), st = readState(), prefs = readPrefs(), tl = readJ(TL_KEY) || {}, lg = readJ(LOG_KEY) || [];
  const lv = loginView(st), r = st.run, tk = readCsrf(), now = new Date();
  const topics = topicList(st, prefs, tl);
  const c = { pending: 0, ok: 0, already: 0, fail: 0, unknown: 0, skip: 0 };
  topics.forEach((t) => { c[t.s]++; });
  const loggedIn = !!web && st.login.state !== "expired";
  const dateStr = (now.getMonth() + 1) + "月" + now.getDate() + "日 周" + "日一二三四五六"[now.getDay()];
  const ls = tl.state || (r && r.listState) || "none", lsT = LS_TXT[ls] || LS_TXT.none;
  const rt = resultText(r), nick = (web && web.nick) || "";
  const pg = readJ(PROG_KEY), live = !!(pg && pg.phase !== "done" && Date.now() - pg.upd < 120000);
  const au = st.auto && st.auto.day === today() ? st.auto : null, tick = st.tick;
  const nStat = (n) => (topics.length || r ? String(n) : "—");
  const warnList = ls === "partial" || ls === "visited";

  // ===== 总览 =====
  const acct = '<section class="panel s1"><div class="acc"><div class="avc ' + (loggedIn ? "ok" : lv.cls === "warn" ? "warn" : "") + '">' + esc(Array.from(nick || "?")[0]) + '</div><div><div class="rt">' + esc(nick || "未登录") + '</div><div class="rm">' + esc(lv.d) + '</div></div><span class="chip ' + lv.cls + '">' + lv.t + "</span></div>" +
    '<div class="kv"><div><small>最后一次签到</small><b>' + (r ? fmtDT(r.at) : "—") + '</b></div><div><small>下次计划签到</small><b>' + esc(nextPlan(st, prefs)) + "</b></div></div></section>";
  const prog = '<section class="panel prog s1" id="prog" ' + (live ? 'data-live="1"' : "hidden") + '><div class="prog-h">' + SPIN + '<span id="pt" aria-live="polite">正在签到…</span></div><div class="pbar"><i id="pbar"></i></div>' +
    '<div class="pstat"><div><b id="c-ok">0</b><span>成功</span></div><div><b id="c-already">0</b><span>已签</span></div><div><b id="c-fail">0</b><span>失败</span></div><div><b id="c-unknown">0</b><span>未确认</span></div><div><b id="c-skip">0</b><span>跳过</span></div></div>' +
    '<div class="pc" id="pc"></div><div class="pq" id="pq"></div><ul class="pl" id="pl"></ul></section>';
  const runBtn = loggedIn ?
    '<a class="btn btn-primary btn-run swap" id="run" href="/run"><span class="lbl">立即签到</span><span class="lbl lbl-alt">' + SPIN + "签到中…</span></a>" :
    '<a class="btn btn-primary btn-run" href="/login">扫码登录</a>';
  const runBox = '<section class="runbox panel s2">' + runBtn + '<p class="rm" style="margin-top:10px;text-align:center">' + (loggedIn ? "同一时间只会执行一个签到任务，进行中会显示实时进度" : "需要先登录微博网页版才能签到") + "</p></section>";
  const stat = (cls, dot, name, n, sub) => '<div class="stat ' + (n > 0 ? cls : "") + '"><small><i class="dot ' + dot + '"></i>' + name + '</small><span class="num" data-n="' + nStat(n) + '">' + nStat(n) + '</span><div class="sub">' + sub + "</div></div>";
  const stats = '<section class="stats s3">' +
    stat("", "", "关注超话", topics.length, '<span class="chip ' + (ls === "full" ? "ok" : ls === "none" ? "" : "warn") + '">' + lsT[1] + "</span>") +
    stat("okc", "ok", "今日签到成功", c.ok, "今天新签到的") +
    stat("", "ok", "已经签到", c.already, "今天之前已签过的") +
    stat("badc", "bad", "签到失败", c.fail, c.unknown ? "另有 " + c.unknown + " 个未确认" : "明确失败的") + "</section>";
  const lastBox = r ? '<section class="panel last s4"><div class="top"><div class="rt">最近一次签到</div><span class="chip ' + rt[0] + '">' + rt[1] + '</span></div><div class="rm">' + fmtDT(r.at) + " · " + (TRIG[r.trigger] || "手动") + "签到 · 处理 " + (r.total || 0) + " 个 · 用时 " + Math.max(1, Math.round((r.ms || 0) / 1000)) + " 秒</div>" +
    '<div class="chips">' + '<span class="chip ok">成功 ' + r.ok + '</span><span class="chip already">已签 ' + r.already + "</span>" + (r.fail ? '<span class="chip fail">失败 ' + r.fail + "</span>" : "") + (r.unknown ? '<span class="chip unknown">未确认 ' + r.unknown + "</span>" : "") + (r.skipped ? '<span class="chip">未处理 ' + r.skipped + "</span>" : "") + (r.muted ? '<span class="chip skip">已跳过 ' + r.muted + "</span>" : "") + (r.exp ? '<span class="heat">' + svgi(IC.bolt, 13) + "经验 +" + r.exp + "</span>" : "") + "</div></section>" :
    '<section class="panel s4"><div class="notice"><h2>还没有签到记录</h2><p>点上面的「立即签到」试一次</p></div></section>';
  let week = '<h2 class="sec s5">近 7 天</h2><section class="panel week s5">';
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000), key = ymd(d.getTime()), h = st.hist[key];
    week += '<div class="' + (i === 0 ? "now" : "") + '"><i class="' + (h ? (h.fail ? "warn" : "ok") : "") + '" role="img" aria-label="' + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + (h ? "已签 " + h.signed + "/" + h.total + (h.fail ? "，" + h.fail + " 个未成功" : "") : "无记录") + '"></i>' + (i === 0 ? "今天" : "日一二三四五六"[d.getDay()]) + "</div>";
  }
  week += "</section>";
  const overview = '<div class="view" id="v-overview">' + acct + prog + runBox + stats + lastBox + week + "</div>";

  // ===== 超话管理 =====
  const tRows = topics.map((t, n) => {
    const ch = Array.from(String(t.name || "?"))[0];
    const meta = t.s0 === "fail" || t.s0 === "unknown" ? (friendly(t.m) || (t.s0 === "unknown" ? "结果无法确认" : "签到失败")) : t.at ? "最近签到 " + when(t.at) : "还没有签到记录";
    return '<li class="item' + (t.skip ? " off" : "") + '" data-n="' + esc(t.name) + '" data-st="' + t.s + '" data-st0="' + t.s0 + '" data-m="' + esc(meta) + '"><span class="av" style="--h:' + ((ch.codePointAt(0) * 47) % 360) + '">' + esc(ch) +
      (t.pic ? '<img src="' + esc(t.pic) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">' : "") + '</span><div class="it"><div class="rt">' + esc(t.name) + '</div><div class="rm">' + esc(t.skip ? "已跳过，不参与自动签到" : meta) +
      '</div></div><div class="rc"><span class="chip ' + t.s + '">' + STL[t.s] + '</span><button class="sw" type="button" role="switch" aria-checked="' + (t.skip ? "false" : "true") + '" aria-label="参与自动签到" data-id="' + esc(t.id) + '"></button></div></li>';
  }).join("");
  const fcb = (f, t, on) => '<button class="fc" type="button" data-f="' + f + '" aria-pressed="' + (on ? "true" : "false") + '">' + t + " <i>0</i></button>";
  const topicsView = '<div class="view" id="v-topics" hidden><section class="panel s1"><div class="lsrow"><div><div class="rt">' + (lsT[0] === "—" ? "" : '<span class="chip ' + (ls === "full" ? "ok" : "warn") + '" style="margin-right:6px;font-family:var(--mono)">' + lsT[0] + "</span>") + lsT[1] + '</div><div class="rm">' + lsT[2] + (tl.at ? " · " + ago(tl.at) + "获取" : "") + '</div></div><button class="btn btn-sm" type="button" data-refresh' + (loggedIn ? "" : " disabled") + ">刷新列表</button></div></section>" +
    (tRows ? '<div class="lbi s2" id="lbi" data-up="false" data-focus="false"><div class="lbi-box" id="lbib"><svg class="lbi-ring" id="lbir" aria-hidden="true"></svg><label class="lbi-label" id="lbil" for="q">搜索超话</label><input id="q" class="lbi-field" type="text" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"></div></div>' +
      '<div class="fchips s2">' + fcb("all", "全部", true) + fcb("pending", "待签到") + fcb("ok", "成功") + fcb("already", "已签到") + fcb("fail", "失败") + fcb("unknown", "未确认") + fcb("skip", "已跳过") + "</div>" +
      '<div class="bulk s2"><span id="ten"></span><div><button class="btn btn-sm" type="button" id="ball">全选</button><button class="btn btn-sm" type="button" id="bnone">取消全选</button></div></div>' +
      '<ul class="list s3" id="tl">' + tRows + '</ul><div class="panel" id="tempty" hidden><div class="notice"><h2>没有符合的超话</h2><p>换个关键词或筛选条件试试</p></div></div>' +
      '<p class="note" style="margin-top:12px">开关打开表示参与自动签到；关闭的超话会被跳过。全选 / 取消全选只作用于当前筛选出来的超话。</p>' :
      '<section class="panel s2"><div class="notice"><h2>还没有超话</h2><p>' + (loggedIn ? "点上面的「刷新列表」读取你关注的超话" : "先扫码登录，再读取关注的超话") + "</p></div></section>") + "</div>";

  // ===== 签到记录 =====
  const hfc = (f, t, on) => '<button class="fc" type="button" data-hf="' + f + '" aria-pressed="' + (on ? "true" : "false") + '">' + t + " <i>0</i></button>";
  const historyView = '<div class="view" id="v-history" hidden><div class="fchips s1" id="hdays"></div>' +
    '<div class="fchips s1">' + hfc("all", "全部", true) + hfc("ok", "成功") + hfc("already", "已签到") + hfc("fail", "失败") + hfc("unknown", "未确认") + hfc("skip", "已跳过") + "</div>" +
    '<div id="hist" class="s2"></div><p class="note">「失败」是微博明确返回了失败；「未确认」是请求超时、连接中断或无法判断是否已签到，不会被当成失败，也不会被当成已签到。' + (nick ? "账号：" + esc(nick) + "。" : "") + "</p>" +
    '<script type="application/json" id="logdata">' + JSON.stringify(lg).replace(/</g, "\\u003c") + "</script></div>";

  // ===== 设置 =====
  const tm2 = SCHED_TEXT;
  const accSet = '<h2 class="sec s1">账号</h2><section class="panel s1">' + rowHtml(lv.cls, "user", esc(nick || "微博网页登录"), lv.d, '<span class="chip ' + lv.cls + '">' + lv.t + "</span>") +
    '<div class="act">' + (web ? '<a class="btn" href="/login">重新扫码登录</a>' + confirmBtn("退出登录", "/logout?t=" + tk, "确认退出") : '<a class="btn btn-primary" href="/login">扫码登录</a>') + "</div></section>" +
    (web ? '<p class="note s1">退出登录会清除本机保存的网页登录，之后需要重新扫码才能签到。</p>' : "");
  const lastTrig = tick || st.open ? (tick ? "定时检查 " + ago(tick.at) : "") + (tick && st.open ? " · " : "") + (st.open ? "打开微博补签 " + ago(st.open.at) : "") : "还没有触发过";
  const autoSet = '<h2 class="sec s2">自动签到</h2><section class="panel ov s2">' + swRow("自动签到", "到点后自动签到；关闭后只能手动签到", "auto", prefs.auto) +
    '<div class="srow" id="trow"><div><div class="rt">签到时间</div><div class="rm">插件默认 ' + SCHED_DEFAULT_TEXT + (prefs.time ? "，当前已自定义" : "") + '</div></div><div class="pop" id="tpop" data-v="' + tm2 + '" data-def="' + SCHED_DEFAULT_TEXT + '" data-custom="' + (prefs.time ? "1" : "0") + '"><button class="pop-btn" type="button" id="tbtn" aria-haspopup="dialog" aria-expanded="false" aria-controls="tmenu"><span id="tval">' + tm2 + '</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg></button><div class="pop-menu" id="tmenu" role="dialog" aria-label="签到时间"><div class="pop-inner" id="tinner"></div></div></div></div>' +
    infoRow("最近一次触发", lastTrig) + infoRow("最近一次执行结果", r ? fmtDT(r.at) + " · " + rt[1] : "还没有签到记录", r ? '<span class="chip ' + rt[0] + '">' + (rt[0] === "ok" ? "正常" : rt[0] === "bad" ? "失败" : "需留意") + "</span>" : "") + "</section>" +
    '<p class="note s2">Cron 和「打开微博」两种触发共用同一把任务锁，不会重复签到。</p>';
  const topicSet = '<h2 class="sec s3">超话</h2><section class="panel s3">' + swRow("自动获取关注超话", "每次签到前重新读取关注列表；关闭后使用上次保存的列表", "fetch", prefs.fetch) +
    infoRow("跳过指定超话", "已跳过 " + c.skip + " 个", '<a class="btn btn-sm" href="#topics" data-gv="topics">管理</a>') +
    infoRow("刷新超话列表", "现在读取一次关注列表（不签到）", '<button class="btn btn-sm" type="button" data-refresh' + (loggedIn ? "" : " disabled") + ">刷新</button>") + "</section>";
  const notifySet = '<h2 class="sec s4">通知</h2><section class="panel s4">' + swRow("签到成功通知", "有新签到成功的超话时推送汇总", "n_ok", prefs.n.ok) + swRow("签到失败通知", "有失败、未确认或登录失效时推送", "n_fail", prefs.n.fail) + swRow("任务完成通知", "每次任务结束都推送一条汇总", "n_done", prefs.n.done) + "</section>" +
    '<p class="note s4">通知总开关在 Loon 插件设置的「签到通知」里（当前' + (notify ? "已开启" : "已关闭") + "）。</p>";
  const dataSet = '<h2 class="sec s5">数据</h2><section class="panel s5"><div class="act"><button class="btn" type="button" id="rl">刷新状态</button>' + confirmBtn("清理历史记录", "/reset?t=" + tk, "确认清理") + confirmBtn("重置模块配置", "/reset/config?t=" + tk, "确认重置") + "</div></section>" +
    '<p class="note s5">清理历史记录会删除签到记录和近 7 天统计；重置模块配置会恢复跳过列表、签到时间、通知开关的默认值。两者都不会退出登录。</p>';
  const diag = '<details class="diagbox"><summary>诊断信息</summary><p>' + (r && r.netFail ? "⚠️ 最近一次没有收到微博服务器的任何响应（网络或代理问题，不是登录问题）<br>" : "") + "登录方式：" + (web ? "网页（Cookie）" : "无，请扫码登录") +
    "<br>Loon 定时检查：" + (au && au.done ? "今日已签完，之后的检查直接跳过" : tick ? ago(tick.at) : "从未触发") + "<br>打开微博补签检查：" + (st.open ? ago(st.open.at) : "从未触发") + "</p></details>";
  const settingsView = '<div class="view" id="v-settings" hidden>' + accSet + autoSet + topicSet + notifySet + dataSet + "</div>";

  const toastTxt = r ? "签到完成 · 成功 " + r.ok + " · 已签 " + r.already + (r.fail ? " · 失败 " + r.fail : "") + (r.unknown ? " · 未确认 " + r.unknown : "") + (warnList ? " · 列表不完整" : "") : "完成";
  const seg = (v, t, on) => '<button type="button" data-v="' + v + '" aria-selected="' + (on ? "true" : "false") + '">' + t + "</button>";
  return shellOpen("微博超话签到", "home") + '<main class="shell">' +
    headHtml("超话签到", dateStr, '<button class="btn btn-icon" type="button" id="rl2" aria-label="刷新" onclick="location.reload()">' + svgi(IC.refresh) + "</button>") +
    '<i class="navs" id="navs" aria-hidden="true"></i><nav class="nav s1"><div class="nav-blur" aria-hidden="true">' + "<i></i>".repeat(3) + '</div><div class="seg" id="seg" role="tablist"><i class="seg-i" id="segi"></i>' + seg("overview", "总览", true) + seg("topics", "超话") + seg("history", "记录") + seg("settings", "设置") + "</div></nav>" +
    overview + topicsView + historyView + settingsView + '<div class="foot">数据仅保存在本机 Loon 中' + diag + '</div></main><div class="bblur" aria-hidden="true">' + "<i></i>".repeat(3) + "</div>" +
    '<div class="tst" id="tst" role="region" aria-label="通知" data-done="' + esc(toastTxt) + '"></div><script>' + PAGE_JS + "</script><script>" + PROG_JS + "</script></body></html>";
}

// ---------- 路由 ----------
function serve() {
  const path = ($request.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]) || "/";
  const H = { "Cache-Control": "no-store" };
  const html = (b) => $done({ response: { status: 200, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, H), body: b } });
  const json = (o) => $done({ response: { status: 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, H), body: JSON.stringify(o) } });
  const go = (h, p) => $done({ response: { status: 302, headers: Object.assign({ Location: PAGE + (p || "") + (h || "") }, H), body: "" } });
  const q = $request.url.split("?")[1] || "";
  const qp = (k) => { const m = new RegExp("(?:^|&)" + k + "=([^&]*)").exec(q); try { return m ? decodeURIComponent(m[1]) : ""; } catch (e) { return ""; } };
  const fail = (m) => html(msgPage("出错了", m, '<a href="/login">重试</a> · <a href="/">返回</a>'));
  // 会删除数据的操作要带页面里的一次性口令，避免被别的网页在后台悄悄触发
  const guarded = () => {
    if (qp("t") && qp("t") === $persistentStore.read(CSRF_KEY)) return true;
    html(msgPage("页面已过期", "请返回状态页刷新后再操作", '<a href="/">返回状态页</a>'));
    return false;
  };
  const prefsOut = (fn) => { const p = readPrefs(); fn(p); writeJ(PREF_KEY, p); return p; };

  if (path === "/run/go") {
    const job = qp("src") === "open" ? auto("open") : run("manual");
    job.catch((e) => log("run error " + e)).then((r) => json({ ok: true, r: r === "busy" ? "busy" : "" }));
  } else if (path === "/run/progress") {
    const pg = readJ(PROG_KEY);
    if (pg && pg.phase !== "done" && Date.now() - pg.upd > 120000) pg.phase = "done"; // 脚本中途被杀：别让页面一直转
    json(pg || { phase: "" });
  } else if (path === "/run") run("manual").catch((e) => log("run error " + e)).then(() => go("#overview", "?m=done"));
  else if (path === "/api/state") json(apiState());
  else if (path === "/api/topics") { const st = readState(); json(topicList(st, readPrefs(), readJ(TL_KEY) || {}).map((t) => ({ id: t.id, name: t.name, status: t.s, skip: t.skip, lastAt: t.at, reason: t.m }))); }
  else if (path === "/api/history") json((readJ(LOG_KEY) || []).map((r) => ({ at: r.at, trigger: r.tr, total: r.total, items: (r.it || []).map((i) => ({ name: i[0], status: i[1], reason: i[2] })) })));
  else if (path === "/api/refresh") refreshTopics().then(json).catch((e) => json({ ok: false, msg: String((e && e.message) || e) }));
  else if (path === "/login") loginStart().then(html).catch((e) => fail(String((e && e.message) || e)));
  else if (path === "/login/check") loginCheck().then(json).catch((e) => json({ s: "fail", msg: String((e && e.message) || e) }));
  else if (path === "/settings") go("#settings");
  else if (path === "/logout") { // 退出登录：清掉本机保存的网页登录
    if (!guarded()) return;
    del(WEB_KEY); del(AUTH_KEY);
    const st = readState(); st.login = { state: "none" }; st.qr = null; writeJ(STATE_KEY, st);
    go("#overview", "?m=out");
  } else if (path === "/reset") { // 清理历史记录：不影响登录和配置
    if (!guarded()) return;
    const st = readState(); st.run = null; st.hist = {}; st.last = {}; writeJ(STATE_KEY, st); del(LOG_KEY);
    go("#settings", "?m=cleared");
  } else if (path === "/reset/config") { // 重置模块配置：跳过列表、时间、通知开关恢复默认；不影响登录和历史
    if (!guarded()) return;
    del(PREF_KEY); const st = readState(); st.auto = null; writeJ(STATE_KEY, st);
    go("#settings", "?m=cfg");
  } else if (path === "/prefs/skip") {
    const ids = (qp("ids") || qp("id")).split(",").filter((x) => /^[0-9A-Za-z_-]{4,40}$/.test(x)).slice(0, 60);
    if (!ids.length) return json({ ok: false });
    const names = {}; topicList(readState(), readPrefs(), readJ(TL_KEY) || {}).forEach((t) => { names[t.id] = t.name; });
    const on = qp("on") === "1";
    const p = prefsOut((p) => ids.forEach((id) => { if (on) p.skip[id] = names[id] || p.skip[id] || label(id); else delete p.skip[id]; }));
    json({ ok: true, n: Object.keys(p.skip).length });
  } else if (path === "/prefs/set") {
    const k = qp("k"), on = qp("v") === "1";
    if (k === "auto") prefsOut((p) => { p.auto = on; });
    else if (k === "fetch") prefsOut((p) => { p.fetch = on; });
    else if (/^n_(ok|fail|done)$/.test(k)) prefsOut((p) => { p.n[k.slice(2)] = on; });
    else return json({ ok: false });
    json({ ok: true });
  } else if (path === "/prefs/time") {
    const v = qp("v"), m = /^(\d{2}):(\d{2})$/.exec(v);
    if (v && !(m && +m[1] <= 23 && +m[2] <= 59)) return json({ ok: false });
    prefsOut((p) => { p.time = v || ""; });
    json({ ok: true });
  } else html(renderConsole());
}

function statusNotify() {
  const st = readState(), lv = loginView(st), r = st.run;
  const sum = r ? "成功 " + r.ok + " · 已签 " + r.already + " · 失败 " + r.fail + (r.unknown ? " · 未确认 " + r.unknown : "") + "（" + ago(r.at) + "）" : "还没有签到记录";
  $notification.post(TITLE, "登录：" + lv.t + "｜" + lv.d, sum, { openUrl: PAGE, url: PAGE });
  $done({ title: TITLE, content: "登录：" + lv.t + "\n" + sum, icon: lv.cls === "ok" ? "checkmark.seal.fill" : "exclamationmark.triangle.fill", "icon-color": lv.cls === "ok" ? "#34C759" : "#FF9F0A" });
}

// 打开微博时的补签：不让微博的请求等着签到做完。
// 做法：先向状态页域名发一个「后台补签」请求（由另一个脚本实例去执行，持有任务锁），看到锁已被拿走就立刻放行微博的请求；
// 如果这条路走不通（2.5 秒内没人拿锁），才退回到原来的做法：在本次请求里直接补签。
function kickOpen() {
  let fin = false;
  const out = () => { if (!fin) { fin = true; $done({}); } };
  const inline = () => auto("open").catch((e) => log("open error " + e)).then(out);
  if (typeof setTimeout !== "function") return inline();
  try { $httpClient.get({ url: PAGE + "run/go?src=open", timeout: 2500 }, () => {}); } catch (e) { log("kickOpen error " + e); return inline(); }
  const t0 = Date.now();
  const tick = () => {
    if (fin) return;
    if (lockFresh()) { log("补签已在后台启动（" + (Date.now() - t0) + " 毫秒），放行微博请求"); return out(); }
    if (Date.now() - t0 > 2500) { log("后台补签没有启动，改为在本次请求里直接补签"); return inline(); }
    setTimeout(tick, 200);
  };
  setTimeout(tick, 150);
}

// ---------- 入口 ----------
try { if ($persistentStore.read(AUTH_KEY)) del(AUTH_KEY); } catch (e) {} // 旧版保存过的 App 登录信息：不再使用，顺手清掉
applySched();
const S = (typeof $script !== "undefined" && $script) || {};
if (!enabled) {
  if (typeof $request !== "undefined" && $request && $request.url.indexOf(HOST) !== -1) {
    $done({ response: { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: msgPage("超话签到已关闭", "超话签到已在插件设置中关闭。在插件设置里重新打开「超话签到」开关后即可使用。") } });
  } else if (typeof $request !== "undefined" && $request) $done({});
  else $done();
} else if (typeof $request !== "undefined" && $request) {
  if ($request.url.indexOf(HOST) !== -1) serve();
  else if (arg.TIME != null && /\/2\/remind\/(unread_count|hometab_dot)/i.test($request.url)) {
    // 只挂在后台轮询接口上（不影响首页加载）；没到点 / 今天已签完时什么都不做，立刻放行
    let due = false;
    try { due = openDue(); } catch (e) { log("openDue error " + e); }
    if (due) kickOpen(); else $done({});
  } else $done({});
} else if (S.type === "generic" || /立即|状态/.test(S.name || "")) {
  if (/状态/.test(S.name || "")) statusNotify();
  else run("manual").catch((e) => push("脚本出错", String((e && e.message) || e))).then(() => $done());
} else {
  auto().catch((e) => log("auto error " + e)).then(() => $done()); // 定时任务（含无法识别类型的调用）：一天最多签一次，不会重复打扰
}
