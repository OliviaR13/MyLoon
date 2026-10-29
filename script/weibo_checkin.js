// 微博超话签到 for Loon（v2：按新版微博 App 抓包重写）
// 同一个脚本，按触发方式分工：
//   http-request（api.weibo.cn）  打开微博时保存登录状态；进入超话页时记录该超话
//   http-request（状态页域名）     visual 状态页：http://weibo-checkin.loon/
//   cron / generic               执行签到、推送汇总 / 推送当前状态
// 所有登录信息只保存在本机的 Loon 持久化存储里，不会出现在仓库或日志中。
// 参数：CHECKIN 签到总开关，NOTIFY 通知开关，DEBUG 调试日志（日志不输出任何登录信息）

const AUTH_KEY = "MyLoon_WeiboCH_auth";
const STATE_KEY = "MyLoon_WeiboCH_state";
const PREF_KEY = "MyLoon_WeiboCH_prefs"; // 状态页里的偏好（跳过哪些超话），只保存在本机
const PROG_KEY = "MyLoon_WeiboCH_prog"; // 签到进度（只保存在本机），状态页轮询它来显示「正在签哪个超话」
const WEB_KEY = "MyLoon_WeiboCH_web"; // 网页版登录（扫码获得的 Cookie），只保存在本机
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
const SCHED = tm ? Math.min(23, +tm[1]) * 60 + Math.min(59, +tm[2]) : 8 * 60 + 10; // 每天几点开始自动签到（分钟数）
const SCHED_TEXT = ("0" + Math.floor(SCHED / 60)).slice(-2) + ":" + ("0" + (SCHED % 60)).slice(-2);
const log = (...a) => { if (debug) console.log("[weibo_checkin] " + a.join(" ")); };
const push = (sub, body) => { if (notify) $notification.post(TITLE, sub, body || "", { openUrl: PAGE, url: PAGE }); };
const sleep = (ms) => new Promise((r) => (typeof setTimeout === "function" ? setTimeout(r, ms) : r()));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 存取 ----------
const readJ = (k) => { try { return JSON.parse($persistentStore.read(k) || "null"); } catch (e) { return null; } };
const writeJ = (k, o) => $persistentStore.write(JSON.stringify(o), k);
// 删除一个 Key：文档要求用 undefined；个别运行时不认就退回写空串（readJ 能处理空串）
const del = (k) => { $persistentStore.write(undefined, k); if ($persistentStore.read(k)) $persistentStore.write("", k); };
const readState = () => Object.assign({ topics: {}, signed: { day: "", ids: {} }, login: {}, run: null, running: 0, hist: {} }, readJ(STATE_KEY) || {});
const readPrefs = () => { const p = readJ(PREF_KEY) || {}; return { skip: (p.skip && typeof p.skip === "object") ? p.skip : {} }; };
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
      if (wasBad && !readJ(WEB_KEY)) push("登录状态已获取", "之后会按定时任务自动签到，点击查看状态页");
      log("已保存登录状态");
    }
  }
  if (dirty) writeJ(STATE_KEY, st);
}

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
      seen.add(id); topics.push({ id, name: it.title || label(id), done: false }); added++;
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
    writeJ(PREF_KEY, { skip: {} });
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

// ---------- 执行签到 ----------
async function run(trigger, opt) {
  const auth = readJ(AUTH_KEY), web = readJ(WEB_KEY);
  const st = readState();
  if (!auth && !web) {
    st.login = { state: "none" };
    writeJ(STATE_KEY, st);
    if (!(opt && opt.silentExpired)) push("还没有登录", "打开状态页扫码登录（推荐），或打开一次微博 App");
    return null;
  }
  if (st.running && Date.now() - st.running < 300000) { log("上一次还在运行，跳过"); return "busy"; }
  st.running = Date.now();
  writeJ(STATE_KEY, st);
  const P = { id: Date.now(), phase: "list", total: 0, n: 0, cur: "", items: [], upd: 0 };
  const prog = () => { P.upd = Date.now(); writeJ(PROG_KEY, P); };
  prog();

  const rec = { at: Date.now(), trigger, route: web ? "web" : "app", items: [], ok: 0, already: 0, fail: 0, skipped: 0, muted: 0, unknown: 0, exp: 0, expired: false, listNote: "", listCount: 0, listErr: false, listState: "" };
  try {
    let listed = [], listFull = false;
    try {
      const r = web ? await fetchListWeb(web) : { topics: [], src: "none", complete: false, note: "需要先扫码登录网页版才能读取关注的超话" };
      listed = r.topics; rec.listNote = r.note; rec.listCount = listed.length; rec.listSrc = r.src;
      listFull = !!r.complete; rec.listErr = !r.complete && !!r.note;
    } catch (e) {
      if (e.expired) rec.expired = true; else { rec.listNote = "列表接口：" + String(e.message || e).slice(0, 80); rec.listErr = true; }
    }

    // 合并：列表里的 + 访问过的超话
    const all = new Map();
    for (const t of listed) all.set(t.id, { id: t.id, name: t.name || label(t.id), done: t.done });
    rec.visited = 0;
    for (const id of Object.keys(st.topics)) if ((!web || !listed.length) && !all.has(id)) { all.set(id, { id, name: label(id), done: false }); rec.visited++; }
    // 列表来源：full = 完整关注列表；partial = 只读到一部分；visited = 没读到列表，只有访问过的；none = 什么都没有
    rec.listState = listed.length ? (listFull ? "full" : "partial") : (rec.visited ? "visited" : "none");

    if (st.signed.day !== today()) st.signed = { day: today(), ids: {} };
    const start = Date.now(), prefs = readPrefs();
    P.total = Array.from(all.values()).filter((t) => !prefs.skip[t.id]).length; P.phase = "run"; prog();
    for (const t of all.values()) {
      if (rec.expired) break;
      if (prefs.skip[t.id]) { rec.muted++; continue; } // 在设置里关掉的超话
      if (t.done || st.signed.ids[t.id]) { rec.already++; rec.items.push({ id: t.id, name: t.name, st: "already", msg: "今日已签" }); st.signed.ids[t.id] = 1; P.n++; P.items.push({ n: t.name, s: "already" }); prog(); continue; }
      if (Date.now() - start > DEADLINE_MS) { rec.skipped++; continue; }
      P.cur = t.name; prog();
      const res = web ? await checkinWeb(web, t.id) : await checkin(auth, t.id);
      if (res.r === "expired") { rec.expired = true; break; }
      if (res.r === "ok") { rec.ok++; rec.exp += res.exp || 0; st.signed.ids[t.id] = 1; }
      else if (res.r === "already") { rec.already++; st.signed.ids[t.id] = 1; }
      else if (res.r === "unknown") rec.unknown++; // 状态未知：不算已签，也不记入「今日已签」
      else rec.fail++;
      rec.items.push({ id: t.id, name: t.name, st: res.r, msg: res.msg, streak: res.streak, exp: res.exp, rank: res.rank });
      P.n++; P.cur = ""; P.items.push({ n: t.name, s: ["ok", "already", "unknown"].indexOf(res.r) >= 0 ? res.r : "fail" }); prog();
      await sleep(1500 + Math.floor(Math.random() * 2000));
    }
  } finally {
    P.phase = "done"; P.cur = ""; prog();
    rec.total = rec.ok + rec.already + rec.fail + rec.unknown + rec.skipped;
    rec.ms = Date.now() - rec.at;
    st.run = rec; st.running = 0;
    if (!rec.expired && gotResponse && rec.total) { // 近两周的每日结果，状态页画「近 7 天」
      const d = today(), prev = st.hist[d] || { signed: 0 };
      st.hist[d] = { signed: Math.max(prev.signed, rec.ok + rec.already), fail: rec.fail + rec.unknown, total: rec.total };
      Object.keys(st.hist).sort().slice(0, -14).forEach((k) => delete st.hist[k]);
    }
    if (rec.expired) st.login = { state: "expired", route: rec.route };
    else if (gotResponse) st.login = { state: "ok", verified: Date.now(), route: rec.route };
    else rec.netFail = true;
    writeJ(STATE_KEY, st);
  }

  if (rec.expired) { if (!(opt && opt.silentExpired)) push("登录已失效", web ? "网页登录已过期，请打开状态页重新扫码" : "请重新打开微博 App 刷新登录状态"); return rec; }
  if (!rec.total && rec.muted) { push("没有需要签到的超话", "已在设置里跳过 " + rec.muted + " 个超话"); return rec; }
  if (!rec.total) { push("没有可签到的超话", web ? (rec.listNote || "网页登录读不到关注的超话") : "请先在状态页扫码登录网页版，才能读取关注的超话"); return rec; }
  if (rec.netFail) { if (!(opt && opt.silentNet)) push("网络请求全部失败", "没有收到微博服务器的任何响应，详情见状态页"); return rec; }
  const head = "共 " + rec.total + " 个：成功 " + rec.ok + " · 已签 " + rec.already + " · 失败 " + rec.fail + (rec.unknown ? " · 未知 " + rec.unknown : "");
  const lines = [];
  if (rec.ok) lines.push("✅ 新签到 " + rec.ok + " 个" + (rec.exp ? "，经验 +" + rec.exp : ""));
  const bad = rec.items.filter((i) => i.st === "fail").slice(0, 4).map((i) => i.name + "（" + i.msg + "）");
  if (bad.length) lines.push("❌ " + bad.join("；"));
  const unk = rec.items.filter((i) => i.st === "unknown").slice(0, 3).map((i) => i.name);
  if (rec.unknown) lines.push("❓ 状态未知 " + rec.unknown + " 个，不计入已签：" + unk.join("、") + (rec.unknown > unk.length ? " 等" : ""));
  if (rec.skipped) lines.push("⏱ 超时未处理 " + rec.skipped + " 个，" + (rec.listState === "full" ? "下次继续" : "稍后继续"));
  if (rec.listState === "partial") lines.push("⚠️ 只读到部分关注列表" + (rec.listNote ? "：" + friendly(rec.listNote) : ""));
  else if (rec.listState === "visited") lines.push("⚠️ 没读到关注列表，只签了进入过的 " + rec.visited + " 个" + (rec.listNote ? "：" + friendly(rec.listNote) : ""));
  push(head, lines.join("\n"));
  return rec;
}

// ---------- 定时入口 ----------
// Loon 每 5 分钟调用一次；到了设定的时间才真正签到，错过的会补签，失败的会隔一会儿重试。
// 每次调用都记录一下，状态页就能看出 Loon 到底有没有触发过定时任务。
async function auto(src) {
  const day = today();
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  const st = readState();
  const a = st.auto && st.auto.day === day ? st.auto : { day, tries: 0, done: false, last: 0 };
  const open = src === "open"; // 打开微博时的补签：微博会频繁请求，不满足条件就什么都不做、也不写状态
  if (open && (a.done || mins < SCHED || a.tries >= 6 || (a.last && Date.now() - a.last < 10 * 60000) || !(readJ(WEB_KEY) || readJ(AUTH_KEY)))) return;
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
function loginView(auth, st) {
  const web = readJ(WEB_KEY);
  if (web) {
    const who = web.nick ? web.nick + " · " : "";
    if (st.login.state === "expired" && st.login.route === "web") return { cls: "warn", t: "疑似失效", d: "网页登录已过期，请重新扫码" };
    return { cls: "ok", t: "有效", d: who + "网页登录 · " + ago(web.at) + "登录" + (st.login.verified && st.login.route === "web" ? " · " + ago(st.login.verified) + "验证通过" : "") };
  }
  if (!auth) return { cls: "bad", t: "未登录", d: "扫码登录网页版，或打开微博 App" };
  if (st.login.state === "expired") return { cls: "warn", t: "疑似失效", d: "请重新打开微博 App 刷新" };
  if (Date.now() - auth.at > 7 * 86400000) return { cls: "warn", t: "较久未刷新", d: "App 登录 · " + ago(auth.at) + "获取，建议打开一次微博" };
  return { cls: "ok", t: "有效", d: "App 登录 · " + ago(auth.at) + "获取" + (st.login.verified ? " · " + ago(st.login.verified) + "验证通过" : "") };
}
const friendly = (m) => {
  m = String(m || "");
  if (/Request timeout|无响应/.test(m)) return "请求超时";
  if (/HTTPClient|NSURL|Domain=/.test(m)) return "网络请求失败";
  return m.length > 36 ? m.slice(0, 36) + "…" : m;
};
const clock = (t) => { const d = new Date(t); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); };

// ---------- 页面样式：与主站一致的设计变量（暖纸色 + 单一强调色、16/10/6 圆角、弹簧缓动、逐层入场） ----------
const PAGE_CSS = `
:root{--bg:#f6f4ef;--card:#fdfcf9;--hover:#faf8f3;--text:#1d1b17;--muted:#6a655a;--line:#e6e2d8;--chip:#efece4;--accent:#0f7f69;--accent-text:#0a6250;--accent-ink:#f7fbf9;--shadow:40 30 10;
--glow:color-mix(in srgb,var(--accent) 16%,transparent);--warn:#b45309;--bad:#b42318;--r-lg:16px;--r-md:10px;--r-sm:6px;--spring:cubic-bezier(.34,1.4,.64,1);--ease:cubic-bezier(.2,.8,.2,1);
--ap-bg:color-mix(in srgb,var(--card) 80%,transparent);--ap-filter:saturate(180%) blur(20px);--ap-line:rgb(0 0 0 / .1);
--font:"Geist Sans",-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Noto Sans SC","Segoe UI",sans-serif;--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#12110f;--card:#191815;--hover:#1e1d19;--text:#efece5;--muted:#a39e92;--line:#2b2924;--chip:#23211d;--accent:#3fcfa6;--accent-text:#3fcfa6;--accent-ink:#04140e;--shadow:0 0 0;
--glow:color-mix(in srgb,var(--accent) 14%,transparent);--warn:#fbbf24;--bad:#f87171;--ap-line:rgb(255 255 255 / .14)}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
body::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;background:linear-gradient(var(--bg) 0,transparent 18%,transparent 82%,var(--bg) 100%),radial-gradient(75% 46% at 50% 14%,var(--glow),transparent 72%),radial-gradient(65% 40% at 85% 96%,color-mix(in srgb,var(--glow) 55%,transparent),transparent 70%)}
body::before{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.05;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
.shell{position:relative;z-index:2;max-width:720px;margin:0 auto;padding:calc(24px + env(safe-area-inset-top)) 16px calc(112px + env(safe-area-inset-bottom))}
h1,h2,p{margin:0}a{color:var(--accent-text)}button,a{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
.head{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.head-text{flex:1;min-width:0}.head h1{font-size:24px;line-height:1.05;font-weight:700;letter-spacing:-.03em}
.head p{color:var(--muted);font-size:13px;font-weight:500;margin-top:5px;line-break:strict;text-wrap:balance}
.btn{font:inherit;font-size:14px;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--text);border-radius:var(--r-md);padding:8px 14px;cursor:pointer;text-decoration:none;white-space:nowrap;line-height:1.2;display:inline-flex;align-items:center;justify-content:center;transition:background-color .15s,border-color .15s,filter .15s,transform .35s var(--spring)}
.btn:active{transform:scale(.97)}.btn-ghost{background:transparent}.btn-primary{background:var(--accent);border-color:transparent;color:var(--accent-ink);box-shadow:0 6px 14px color-mix(in srgb,var(--accent) 26%,transparent)}
.btn-icon{display:grid;place-items:center;width:40px;height:40px;padding:0;flex:none}.head .btn{background:var(--ap-bg);border-color:var(--ap-line);-webkit-backdrop-filter:var(--ap-filter);backdrop-filter:var(--ap-filter);color:var(--text)}
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
.hero{display:flex;align-items:center;gap:18px;padding:18px}.ring{position:relative;width:96px;height:96px;flex:none}.ring svg{transform:rotate(-90deg)}.ring .bg{stroke:var(--line)}.ring .fg{stroke:var(--accent);animation:fill 1s var(--ease) .2s backwards}
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
.bblur{--f:104px;position:fixed;left:0;right:0;bottom:0;height:calc(var(--f) + env(safe-area-inset-bottom));z-index:5;pointer-events:none}
.bblur::before{content:"";position:absolute;inset:0;background:linear-gradient(to top,color-mix(in srgb,var(--bg) 78%,transparent) 0,color-mix(in srgb,var(--bg) 60%,transparent) 55%,color-mix(in srgb,var(--bg) 22%,transparent) 80%,transparent 100%)}
.bblur i{position:absolute;inset:0}
/*BLUR*/
.bdock{position:fixed;left:0;right:0;bottom:0;z-index:6;padding:0 16px calc(12px + env(safe-area-inset-bottom));pointer-events:none}
.bdock-in{pointer-events:auto;max-width:720px;margin:0 auto;display:flex;gap:8px;padding:7px;border-radius:22px;background:var(--ap-bg);border:1px solid var(--ap-line);-webkit-backdrop-filter:var(--ap-filter);backdrop-filter:var(--ap-filter);box-shadow:0 10px 30px rgb(var(--shadow) / .14)}
.bdock .btn{flex:1;padding:12px 14px;border-radius:16px}.bdock .btn-primary{flex:2}
.toast{position:fixed;left:0;right:0;margin:0 auto;width:max-content;max-width:calc(100vw - 32px);text-align:center;text-wrap:balance;overflow-wrap:anywhere;top:calc(10px + env(safe-area-inset-top));z-index:10;background:var(--text);color:var(--bg);font-size:13.5px;line-height:1.4;padding:9px 18px;border-radius:20px;box-shadow:0 8px 24px rgb(var(--shadow) / .22);opacity:0;visibility:hidden;transform:scale(.9);filter:blur(6px);pointer-events:none;transition:opacity .2s,visibility .2s,transform .5s var(--spring),filter .3s}
.toast.show{opacity:1;visibility:visible;transform:none;filter:none}.toast.show.leaving{opacity:0;transform:translateY(-4px);transition:opacity .25s,transform .3s}
.qr{padding:18px;text-align:center}.qr img{width:180px;height:180px;border-radius:var(--r-md);background:#fff;padding:8px;box-shadow:0 0 0 1px var(--line)}.qr .rm{margin-top:10px}
.wait{display:flex;align-items:center;justify-content:center;gap:10px;margin:6px 0 14px;font-weight:620;color:var(--text)}.wait svg{color:var(--accent)}.wait.done svg,.wait.fail svg{display:none}.wait.done{color:var(--accent-text)}.wait.fail{color:var(--bad)}
@keyframes intro-up{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@keyframes intro-glow{from{opacity:0}to{opacity:1}}
body::after{animation:intro-glow 1.3s ease-out backwards}.head-text{animation:intro-up .6s var(--ease) .08s backwards}.head .btn{animation:intro-up .6s var(--ease) .16s backwards}
.s1{animation:intro-up .6s var(--ease) .22s backwards}.s2{animation:intro-up .6s var(--ease) .28s backwards}.s3{animation:intro-up .6s var(--ease) .34s backwards}.s4{animation:intro-up .6s var(--ease) .4s backwards}.s5{animation:intro-up .6s var(--ease) .46s backwards}
.foot{animation:intro-glow .5s ease-out .6s backwards}.bdock{animation:intro-up .6s var(--ease) .5s backwards}
.sec{font-size:12.5px;font-weight:650;color:var(--muted);letter-spacing:.02em;margin:22px 4px 8px}
.note{color:var(--muted);font-size:12.5px;line-height:1.5;padding:0 4px;margin:-6px 0 14px}
.act{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:14px 16px}.row+.act{border-top:1px solid var(--line)}
.btn-danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}.btn-danger-fill{background:var(--bad);border-color:transparent;color:#fff}
.cfm{display:contents}.cfm [data-cf],.cfm [data-cn]{display:none}.cfm[data-ask] [data-go]{display:none}.cfm[data-ask] [data-cf],.cfm[data-ask] [data-cn]{display:inline-flex;animation:intro-up .25s var(--ease) both}
.sw{position:relative;flex:none;width:46px;height:28px;border:0;padding:0;border-radius:999px;background:var(--chip);box-shadow:inset 0 0 0 1px var(--line);cursor:pointer;transition:background-color .25s var(--ease)}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:var(--card);box-shadow:0 1px 3px rgb(0 0 0 / .25);transition:transform .4s var(--spring)}
.sw[aria-checked="true"]{background:var(--accent)}.sw[aria-checked="true"]::after{transform:translateX(18px)}.sw:disabled{opacity:.6}
.item.off .av,.item.off .it{opacity:.5}.item .it{transition:opacity .2s}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.spin circle{stroke-dasharray:60,150!important}}
`.replace("/*BLUR*/", `.bblur i:nth-child(1){-webkit-backdrop-filter:blur(0.7px);backdrop-filter:blur(0.7px);-webkit-mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 1 / 8),transparent 100%);mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 1 / 8),transparent 100%)}
.bblur i:nth-child(2){-webkit-backdrop-filter:blur(1.4px);backdrop-filter:blur(1.4px);-webkit-mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 2 / 8),transparent calc(100% - var(--f) * 1 / 8));mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 2 / 8),transparent calc(100% - var(--f) * 1 / 8))}
.bblur i:nth-child(3){-webkit-backdrop-filter:blur(2.2px);backdrop-filter:blur(2.2px);-webkit-mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 3 / 8),transparent calc(100% - var(--f) * 2 / 8));mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 3 / 8),transparent calc(100% - var(--f) * 2 / 8))}
.bblur i:nth-child(4){-webkit-backdrop-filter:blur(3.2px);backdrop-filter:blur(3.2px);-webkit-mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 4 / 8),transparent calc(100% - var(--f) * 3 / 8));mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 4 / 8),transparent calc(100% - var(--f) * 3 / 8))}
.bblur i:nth-child(5){-webkit-backdrop-filter:blur(4.5px);backdrop-filter:blur(4.5px);-webkit-mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 5 / 8),transparent calc(100% - var(--f) * 4 / 8));mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 5 / 8),transparent calc(100% - var(--f) * 4 / 8))}
.bblur i:nth-child(6){-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);-webkit-mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 6 / 8),transparent calc(100% - var(--f) * 5 / 8));mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 6 / 8),transparent calc(100% - var(--f) * 5 / 8))}
.bblur i:nth-child(7){-webkit-backdrop-filter:blur(7.8px);backdrop-filter:blur(7.8px);-webkit-mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 7 / 8),transparent calc(100% - var(--f) * 6 / 8));mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 7 / 8),transparent calc(100% - var(--f) * 6 / 8))}
.bblur i:nth-child(8){-webkit-backdrop-filter:blur(10px) saturate(1.5);backdrop-filter:blur(10px) saturate(1.5);-webkit-mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 8 / 8),transparent calc(100% - var(--f) * 7 / 8));mask-image:linear-gradient(to top,#000 calc(100% - var(--f) * 8 / 8),transparent calc(100% - var(--f) * 7 / 8))}`);

const svgi = (d, z) => '<svg width="' + (z || 18) + '" height="' + (z || 18) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
const IC = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20v.01M20 20v.01M17 17v3"/>',
};
const SPIN = '<svg class="spin" viewBox="0 0 50 50" width="18" height="18" aria-hidden="true"><circle cx="25" cy="25" r="20" fill="none" stroke-width="4.5" stroke-linecap="round"/></svg>';
const BLUR_HTML = '<div class="bblur" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>';
const headHtml = (title, sub, right) => '<header class="head"><div class="head-text"><h1>' + title + "</h1><p>" + sub + "</p></div>" + (right || "") + "</header>";
const shellOpen = (title) => '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f6f4ef" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#12110f" media="(prefers-color-scheme: dark)"><title>' + title + "</title><style>" + PAGE_CSS + "</style></head><body>";

const PAGE_JS = "(function(){" +
  "var ns=document.querySelectorAll('.num');for(var n=0;n<ns.length;n++){(function(el){var s=el.getAttribute('data-n');el.setAttribute('aria-label',s);el.textContent='';" +
  "for(var i=0;i<s.length;i++){var c=s.charAt(i),w=document.createElement('span');if(c>='0'&&c<='9'){w.className='dg';var t=document.createElement('i');for(var d=0;d<10;d++){var b=document.createElement('b');b.textContent=d;t.appendChild(b)}" +
  "t.style.transitionDelay=(i*70+250)+'ms';w.appendChild(t);(function(t,c){requestAnimationFrame(function(){requestAnimationFrame(function(){t.style.transform='translateY(-'+(c*10)+'%)'})})})(t,+c)}else{w.textContent=c}el.appendChild(w)}})(ns[n])}" +
  "var tabs=document.getElementById('tabs'),ind=document.getElementById('ind'),cur=null;" +
  "function place(btn,anim){if(!tabs||!ind)return;var tr=tabs.getBoundingClientRect(),br=btn.getBoundingClientRect();if(!anim||!cur){ind.className='tab-ind no-anim'}else{ind.className='tab-ind';ind.setAttribute('data-dir',btn.offsetLeft>cur.offsetLeft?'fwd':'back')}ind.style.left=(br.left-tr.left+tabs.scrollLeft)+'px';ind.style.right=(tr.right-br.right-tabs.scrollLeft)+'px';cur=btn}" +
  "var EM={all:['还没有超话记录','点下面的「立即签到」试一次'],fail:['没有失败的超话','这次签到一切顺利'],unknown:['没有状态未知的超话','每个超话的结果都已确认'],ok:['这次没有新签到成功的超话','已经签过的会显示在「已签」里'],already:['还没有已签的超话','签到完成后会显示在这里']};" +
  "function filt(f){var ls=document.querySelectorAll('#items .item'),k=0;for(var i=0;i<ls.length;i++){var on=f==='all'||ls[i].getAttribute('data-st')===f;ls[i].hidden=!on;if(on){ls[i].style.setProperty('--i',k++);ls[i].style.animation='none';void ls[i].offsetWidth;ls[i].style.animation=''}}" +
  "var ul=document.getElementById('items'),em=document.getElementById('empty');if(ul)ul.hidden=!k;if(em){em.hidden=!!k;if(!k){var t=EM[f]||EM.all;document.getElementById('et').textContent=t[0];document.getElementById('ep').textContent=t[1]}}}" +
  "if(tabs){var bs=tabs.querySelectorAll('.tab');for(var j=0;j<bs.length;j++)bs[j].onclick=function(){for(var q=0;q<bs.length;q++)bs[q].setAttribute('aria-pressed',bs[q]===this?'true':'false');place(this,true);filt(this.getAttribute('data-f'))};" +
  "var first=tabs.querySelector('.tab');if(first)requestAnimationFrame(function(){place(first,false)})}" +
  "var rb=document.getElementById('run');if(rb)rb.onclick=function(e){if(rb.hasAttribute('data-done')){e.preventDefault();return}rb.setAttribute('data-done','')};" +
  "addEventListener('pageshow',function(e){if(e.persisted){location.reload();return}if(rb)rb.removeAttribute('data-done')});" +
  "var rz;addEventListener('resize',function(){clearTimeout(rz);rz=setTimeout(function(){var on=tabs&&tabs.querySelector('.tab[aria-pressed=\\'true\\']');if(on)place(on,false)},120)});" +
  "var tz=document.getElementById('toast'),tt;function toast(t){if(!tz)return;tz.textContent=t;tz.className='toast show';clearTimeout(tt);tt=setTimeout(function(){tz.className='toast show leaving'},2400)}" +
  "var hs=location.hash,msg={'#login':'登录成功','#out':'已退出登录','#cleared':'已清除签到记录'};if(tz&&(hs==='#done'||msg[hs])){if(msg[hs])tz.textContent=msg[hs];tz.className='toast show';history.replaceState(null,'',location.pathname);tt=setTimeout(function(){tz.className='toast show leaving'},2800)}" +
  "var cf=document.querySelectorAll('.cfm');for(var a=0;a<cf.length;a++)(function(b){var tm,go=b.querySelector('[data-go]'),cn=b.querySelector('[data-cn]');function rs(){b.removeAttribute('data-ask');clearTimeout(tm)}if(go)go.onclick=function(){b.setAttribute('data-ask','');clearTimeout(tm);tm=setTimeout(rs,4000)};if(cn)cn.onclick=rs})(cf[a]);" +
  "var sws=document.querySelectorAll('.sw');for(var q=0;q<sws.length;q++)sws[q].onclick=function(){var el=this,on=el.getAttribute('aria-checked')==='true',row=el.closest('.item'),rm=row&&row.querySelector('.rm');el.setAttribute('aria-checked',on?'false':'true');el.disabled=true;" +
  "fetch('/prefs/skip?id='+encodeURIComponent(el.getAttribute('data-id'))+'&on='+(on?1:0)).then(function(r){return r.json()}).then(function(j){if(!j.ok)throw 0;el.disabled=false;if(row)row.classList.toggle('off',on);if(rm)rm.textContent=on?'已跳过':'参与自动签到'})" +
  ".catch(function(){el.setAttribute('aria-checked',on?'true':'false');el.disabled=false;toast('保存失败，请重试')})};" +
  "})();";

// 签到进度：点「立即签到」后页面不跳转，而是请求 /run/go（脚本在后台签到），同时每秒轮询 /run/progress 显示进度
const PROG_JS = `(function(){
var rb=document.getElementById('run'),box=document.getElementById('prog');if(!box)return;
var bar=document.getElementById('pbar'),tt=document.getElementById('pt'),cur=document.getElementById('pc'),ul=document.getElementById('pl');
var t0=0,shown=0,tm,fails=0,gone=0,seen=0,fin=0,LB={ok:'成功',already:'已签',fail:'失败',unknown:'未知'},CL={ok:'ok',already:'already',fail:'fail',unknown:'warn'};
function paint(p){
  var tot=p.total||0,n=p.n||0;box.hidden=false;
  bar.style.width=(p.phase==='done'?100:tot?Math.max(4,n/tot*100):6)+'%';
  if(p.phase==='list'){tt.textContent='正在读取关注的超话…';cur.textContent=''}
  else if(p.phase==='done'){tt.textContent='签到完成 · '+n+'/'+tot;cur.textContent='';box.className='panel prog fin'}
  else{tt.textContent='正在签到 · '+n+'/'+tot;cur.textContent=p.cur?'正在签到：'+p.cur:''}
  var it=p.items||[];
  for(;shown<it.length;shown++){var li=document.createElement('li'),a=document.createElement('span'),c=document.createElement('span');
    a.textContent=it[shown].n;c.className='chip '+(CL[it[shown].s]||'');c.textContent=LB[it[shown].s]||'';li.appendChild(a);li.appendChild(c);ul.insertBefore(li,ul.firstChild)}
}
function done(){if(fin)return;fin=1;clearTimeout(tm);setTimeout(function(){location.replace('/?r='+Date.now()+'#done')},1000)}
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
  fetch('/run/go').then(function(){gone=1}).catch(function(){gone=1});
  tm=setTimeout(poll,700)
}
if(rb)rb.onclick=start;
if(box.getAttribute('data-live')){if(rb)rb.setAttribute('data-done','');box.hidden=false;poll()}
})();`;

function renderPage() {
  const auth = readJ(AUTH_KEY), web = readJ(WEB_KEY), st = readState(), lv = loginView(auth, st), r = st.run;
  const now = new Date(), mins = now.getHours() * 60 + now.getMinutes();
  const dateStr = now.getMonth() + 1 + "月" + now.getDate() + "日 周" + "日一二三四五六"[now.getDay()];
  const ymd = (t) => { const d = new Date(t); return d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2); };
  const stale = !!(r && r.at && ymd(r.at) !== today()); // 结果不是今天的：别写成「今日已签」
  const staleDay = stale ? (new Date(r.at).getMonth() + 1) + "/" + new Date(r.at).getDate() : "";
  const signed = r ? r.ok + r.already : 0;
  const C = 2 * Math.PI * 40, len = C * (r && r.total ? Math.min(1, signed / r.total) : 0);
  const nVisited = Object.keys(st.topics).length;
  const loggedIn = !!(web || auth) && st.login.state !== "expired";
  const ls = r && r.listState, partialList = ls === "partial" || ls === "visited"; // 关注列表不完整时，别让「已签」看起来像全部完成

  const pg = readJ(PROG_KEY), live = !!(pg && pg.phase !== "done" && Date.now() - pg.upd < 120000); // 正在签到（含定时任务）：打开页面直接显示进度
  const progBox = '<section class="panel prog s1" id="prog" ' + (live ? 'data-live="1"' : "hidden") + '><div class="prog-h">' + SPIN + '<span id="pt">正在签到…</span></div><div class="pbar"><i id="pbar"></i></div><div class="pc" id="pc"></div><ul class="pl" id="pl"></ul></section>';

  // 总览
  const chips = r ? '<div class="chips">' + (r.exp ? '<span class="heat">' + svgi(IC.bolt, 13) + "经验 +" + r.exp + "</span>" : "") +
    '<span class="chip">' + clock(r.at) + " · " + (r.trigger === "cron" ? "定时" : r.trigger === "open" ? "补签" : "手动") + '</span><span class="chip">用时 ' + Math.max(1, Math.round(r.ms / 1000)) + " 秒</span>" +
    (r.fail ? '<span class="chip fail">失败 ' + r.fail + "</span>" : "") + (r.unknown ? '<span class="chip warn">状态未知 ' + r.unknown + "</span>" : "") + (partialList ? '<span class="chip warn">' + (ls === "visited" ? "仅访问记录" : "部分列表") + "</span>" : "") + (r.skipped ? '<span class="chip">未处理 ' + r.skipped + "</span>" : "") + (r.muted ? '<span class="chip">已跳过 ' + r.muted + "</span>" : "") + "</div>" : "";
  const numTxt = r ? signed + "/" + r.total : "—"; // 位数越多字号越小，避免压到圆环上
  const hero = '<section class="panel hero s1' + (stale ? " stale" : "") + '"><div class="ring"><svg width="96" height="96" viewBox="0 0 96 96"><circle class="bg" cx="48" cy="48" r="40" fill="none" stroke="#e6e2d8" stroke-width="8"/>' +
    '<circle class="fg" cx="48" cy="48" r="40" fill="none" stroke="#0f7f69" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + len.toFixed(1) + " " + C.toFixed(1) + '" stroke-opacity="' + (len > 0.5 ? 1 : 0) + '" style="--c:' + C.toFixed(1) + '"/></svg>' +
    '<div><span class="num' + (numTxt.length >= 6 ? " n6" : numTxt.length === 5 ? " n5" : numTxt.length === 4 ? " n4" : "") + '" data-n="' + numTxt + '">' + numTxt + "</span><small>" + (stale ? staleDay + " 的结果" : partialList ? "部分列表" : "今日已签") + "</small></div></div>" +
    '<div class="side"><div class="rt">' + (stale ? "上次的超话签到" : "今天的超话签到") + '</div><span class="chip ' + lv.cls + '">' + (/^未/.test(lv.t) ? lv.t : "登录" + lv.t) + "</span>" + chips + "</div></section>";

  // 状态行：登录 / 定时 / 来源
  const au = st.auto && st.auto.day === today() ? st.auto : null, tick = st.tick;
  const fin = au && au.final;
  let cc = "", ct = "待签到";
  if (!tick) { cc = "warn"; ct = "未触发"; }
  else if (au && au.done) { // 今日不再重试：区分「全部完成」和「完成但有问题」
    cc = !fin || fin === "ok" ? "ok" : "warn";
    ct = { partial: "部分失败", list: "列表不完整", timeout: "未全部处理", net: "网络失败" }[fin] || "今日已完成";
  }
  else if (Date.now() - tick.at > 2 * 3600000) { cc = "warn"; ct = "较久未检查"; }
  else if (fin === "expired") { cc = "bad"; ct = "等待重新登录"; }
  else if (fin === "net") { cc = "warn"; ct = "网络失败，待重试"; }
  else if (fin === "timeout") { cc = "warn"; ct = "超时，待继续"; }
  else if (mins < SCHED) { cc = ""; ct = "等待中"; }
  else if (au && au.tries) { cc = "warn"; ct = "重试中"; }
  const cronMeta = tick ? "Loon 上次检查：" + ago(tick.at) + (au && au.tries ? " · 今日已尝试 " + au.tries + " 次" : "") : "Loon 还没有触发过定时任务：请更新插件并保持 Loon 开启";
  const srcMeta = (() => {
    if (!r) return web ? "网页登录后自动读取全部关注的超话" : nVisited ? "已记录 " + nVisited + " 个进入过的超话" : "扫码登录后自动读取";
    const note = r.listNote ? " · " + friendly(r.listNote) : "", vis = r.visited ? " · 另有进入过的 " + r.visited + " 个" : "";
    if (ls === "full") return "完整关注列表 " + r.listCount + " 个" + vis + note;
    if (ls === "partial") return "部分列表：只读到 " + r.listCount + " 个" + vis + note;
    if (ls === "visited") return "没读到关注列表，只有进入过的 " + r.visited + " 个" + note;
    if (ls === "none") return "没有读到超话" + note;
    return "关注列表 " + r.listCount + " 个" + (r.visited ? " · 进入过 " + r.visited + " 个" : "") + note; // 旧版本留下的记录
  })();
  const srcCls = ls === "full" ? "ok" : ls ? "warn" : web ? "ok" : "", srcTxt = ls === "full" ? "完整" : ls === "partial" ? "部分" : ls === "visited" ? "仅记录" : ls === "none" ? "无" : web ? "网页" : "App";
  const loginRight = web || auth ? '<span class="chip ' + (lv.cls === "bad" ? "bad" : lv.cls) + '">' + lv.t + "</span>" : '<a class="btn btn-primary" href="/login">扫码登录</a>';
  const status = '<section class="panel s2">' +
    rowHtml(loggedIn ? "ok" : lv.cls, "user", web ? "微博网页登录" : auth ? "微博 App 登录" : "微博登录", lv.d, loginRight) +
    rowHtml(cc === "ok" ? "ok" : cc, "clock", "每天 " + SCHED_TEXT + " 自动签到", cronMeta, '<span class="chip ' + cc + '">' + ct + "</span>") +
    rowHtml(ls && ls !== "full" ? "warn" : r && r.total ? "ok" : "", "list", "关注的超话 · 网页", srcMeta, '<span class="chip ' + srcCls + '">' + srcTxt + "</span>") + "</section>";

  // 近 7 天
  let week = '<section class="panel week s3">';
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2);
    const h = st.hist[key];
    week += '<div class="' + (i === 0 ? "now" : "") + '"><i class="' + (h ? (h.fail ? "warn" : "ok") : "") + '" role="img" aria-label="' + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + (h ? "已签 " + h.signed + "/" + h.total + (h.fail ? "，" + h.fail + " 个未成功" : "") : "无记录") + '"></i>' + (i === 0 ? "今天" : "日一二三四五六"[d.getDay()]) + "</div>";
  }
  week += "</section>";

  // 超话列表（失败优先）+ 页签筛选
  const order = { fail: 0, unknown: 0, ok: 1, already: 2 };
  const items = (r ? r.items : []).slice().sort((a, b) => (order[a.st] || 0) - (order[b.st] || 0));
  const count = (k) => items.filter((i) => i.st === k).length;
  const lbl = { ok: "成功", already: "已签", fail: "失败", unknown: "未知" };
  const rows = items.map((i, n) => {
    const ch = Array.from(String(i.name || "?"))[0];
    const sub = i.st === "ok" ? (i.streak ? "连签 " + i.streak + " 天" : "签到成功") + (i.rank ? " · 今日第 " + i.rank + " 名" : "") + (i.exp ? " · 经验 +" + i.exp : "") : i.st === "already" ? "今日已签" : friendly(i.msg);
    return '<li class="item" data-st="' + esc(i.st) + '" style="--i:' + Math.min(n, 14) + '"><span class="av" style="--h:' + ((ch.codePointAt(0) * 47) % 360) + '">' + esc(ch) + '</span><div class="it"><div class="rt">' + esc(i.name) +
      '</div><div class="rm">' + esc(sub) + '</div></div><span class="chip ' + (i.st === "unknown" ? "warn" : esc(i.st)) + '">' + (lbl[i.st] || "未知") + "</span></li>";
  }).join("");
  const tab = (f, t, n, on) => '<button class="tab" type="button" data-f="' + f + '" aria-pressed="' + (on ? "true" : "false") + '">' + t + "<small>" + n + "</small></button>";
  const list = '<div class="tabs s4" id="tabs">' + tab("all", "全部", items.length, true) + tab("fail", "失败", count("fail")) + (count("unknown") ? tab("unknown", "未知", count("unknown")) : "") + tab("ok", "成功", count("ok")) + tab("already", "已签", count("already")) + '<span class="tab-ind no-anim" id="ind"></span></div>' +
    (items.length ? '<ul class="list enter s5" id="items">' + rows + "</ul>" + '<div class="panel s5" id="empty" hidden><div class="notice"><h2 id="et"></h2><p id="ep"></p></div></div>' : '<div class="panel s5"><div class="notice"><h2>' + (r ? "这次没有处理任何超话" : "还没有签到记录") + "</h2><p>" + (r ? "请看上面的「关注的超话」一行" : "点下面的「立即签到」试一次") + "</p></div></div>");

  const diag = '<details><summary>诊断信息</summary><p>' + (r && r.netFail ? "⚠️ 本次没有收到微博服务器的任何响应（网络或代理问题，不是登录问题）<br>" : "") +
    "登录方式：" + (web ? "网页（Cookie）" : auth ? "App" : "无") + (web ? "" : "<br>⚠️ 没有扫码登录：到点自动签到只能靠打开微博时抓到的登录信息，容易过期，建议点「设置」重新扫码") +
    "<br>Loon 定时检查：" + (st.tick ? ago(st.tick.at) : "从未触发") + "<br>打开微博补签检查：" + (st.open ? ago(st.open.at) : "从未触发") + "</p></details>";
  const toastTxt = r ? "签到完成 · 成功 " + r.ok + " · 已签 " + r.already + (r.fail ? " · 失败 " + r.fail : "") + (r.unknown ? " · 未知 " + r.unknown : "") + (partialList ? " · 列表不完整" : "") : "完成";

  const dock = '<div class="bdock"><div class="bdock-in"><a class="btn btn-ghost" href="/">刷新</a>' +
    (loggedIn ? '<a class="btn btn-primary swap" id="run" href="/run"><span class="lbl">立即签到</span><span class="lbl lbl-alt">' + SPIN + "签到中…</span></a>" : '<a class="btn btn-primary" href="/login">扫码登录</a>') + "</div></div>";

  return shellOpen("微博超话签到") + '<main class="shell">' +
    headHtml("超话签到", dateStr + (web && web.nick ? " · " + esc(web.nick) : ""), '<a class="btn btn-icon" href="/settings" aria-label="设置">' + svgi(IC.gear) + "</a>") +
    progBox + hero + status + week + list + '<div class="foot">数据仅保存在本机 Loon 中' + diag + "</div></main>" + BLUR_HTML + dock +
    '<div class="toast" id="toast" role="status">' + esc(toastTxt) + "</div><script>" + PAGE_JS + "</script><script>" + PROG_JS + "</script></body></html>";
}

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
    "if(j.s==='ok'){dead=1;mark(3);w.className='wait done';setTimeout(function(){location.replace('/#login')},700);return}",
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
    '<div class="wait s4" id="w" style="margin-top:14px">' + SPIN + '<span id="m">等待确认…</span></div>' +
    '<a id="re" class="btn btn-lg" style="display:none" href="/login">重新获取二维码</a>' +
    '<div class="foot"><a href="/">返回状态页</a></div></main><script>' + js + "</script></body></html>";
}

// ---------- 设置页：账号（重新扫码 / 退出登录）+ 签到偏好（跳过某些超话）+ 清除记录 ----------
const rowHtml = (cls, ico, title, meta, right) => '<div class="row"><span class="ico ' + cls + '">' + svgi(IC[ico]) + '</span><div><div class="rt">' + title + '</div><div class="rm">' + esc(meta) + "</div></div>" + (right || "") + "</div>";
const confirmBtn = (label, href, okLabel) => '<span class="cfm"><button class="btn btn-danger" type="button" data-go>' + label + '</button><a class="btn btn-danger-fill" href="' + href + '" data-cf>' + okLabel + '</a><button class="btn btn-ghost" type="button" data-cn>取消</button></span>';

function renderSettings() {
  const auth = readJ(AUTH_KEY), web = readJ(WEB_KEY), st = readState(), prefs = readPrefs(), lv = loginView(auth, st);
  const has = !!(web || auth);

  const acct = '<h2 class="sec s1">账号</h2><section class="panel s1">' +
    rowHtml(lv.cls, "user", web ? "微博网页登录" : auth ? "微博 App 登录" : "微博登录", lv.d, '<span class="chip ' + lv.cls + '">' + lv.t + "</span>") +
    '<div class="act">' + (has ? '<a class="btn" href="/login">重新扫码登录</a>' + confirmBtn("退出登录", "/logout", "确认退出") : '<a class="btn btn-primary" href="/login">扫码登录</a>') + "</div></section>" +
    (has ? '<p class="note s1">退出登录会同时清除网页登录和 App 登录状态；之后再打开微博 App，脚本会重新记录 App 登录。</p>' : "");

  const plan = '<h2 class="sec s2">自动签到</h2><section class="panel s2">' +
    rowHtml("", "clock", "签到时间", "在 Loon 插件设置中修改", '<span class="chip">' + SCHED_TEXT + "</span>") +
    rowHtml("", "bolt", "签到通知", "在 Loon 插件设置中修改", '<span class="chip ' + (notify ? "ok" : "") + '">' + (notify ? "开启" : "关闭") + "</span>") + "</section>";

  // 超话：来自上次签到结果 + 已跳过的；开关打开 = 参与签到
  const topics = new Map();
  ((st.run && st.run.items) || []).forEach((i) => { if (i.id) topics.set(i.id, i.name); });
  Object.keys(prefs.skip).forEach((id) => topics.set(id, prefs.skip[id] || topics.get(id) || label(id)));
  const rows = Array.from(topics, ([id, name]) => {
    const ch = Array.from(String(name || "?"))[0], on = !prefs.skip[id];
    return '<li class="item' + (on ? "" : " off") + '"><span class="av" style="--h:' + ((ch.codePointAt(0) * 47) % 360) + '">' + esc(ch) + '</span><div class="it"><div class="rt">' + esc(name) + '</div><div class="rm">' + (on ? "参与自动签到" : "已跳过") +
      '</div></div><button class="sw" type="button" role="switch" aria-checked="' + (on ? "true" : "false") + '" aria-label="参与签到" data-id="' + esc(id) + '"></button></li>';
  }).join("");
  const skipSec = '<h2 class="sec s3">要签到的超话</h2>' + (rows ? '<ul class="list s3">' + rows + "</ul>" : '<div class="panel s3"><div class="notice"><h2>还没有超话记录</h2><p>签到一次后，这里会列出你的超话，可以单独关掉不想签到的</p></div></div>');

  const data = '<h2 class="sec s4">数据</h2><section class="panel s4"><div class="act">' + confirmBtn("清除签到记录", "/reset", "确认清除") + "</div></section>" +
    '<p class="note s4">只清除状态页上的今日结果和近 7 天记录，不影响登录和上面的跳过设置。</p>';

  const dock = '<div class="bdock"><div class="bdock-in"><a class="btn btn-primary" href="/">返回状态页</a></div></div>';
  return shellOpen("设置") + '<main class="shell">' + headHtml("设置", "账号与签到偏好") + acct + plan + skipSec + data +
    '<div class="foot">数据仅保存在本机 Loon 中</div></main>' + BLUR_HTML + dock + '<div class="toast" id="toast" role="status"></div><script>' + PAGE_JS + "</script></body></html>";
}

function serve() {
  const path = ($request.url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]) || "/";
  const H = { "Cache-Control": "no-store" };
  const html = (b) => $done({ response: { status: 200, headers: Object.assign({ "Content-Type": "text/html; charset=utf-8" }, H), body: b } });
  const json = (o) => $done({ response: { status: 200, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, H), body: JSON.stringify(o) } });
  const go = (h, p) => $done({ response: { status: 302, headers: Object.assign({ Location: PAGE + (p || "") + (h || "") }, H), body: "" } });
  const q = $request.url.split("?")[1] || "";
  const qp = (k) => { const m = new RegExp("(?:^|&)" + k + "=([^&]*)").exec(q); try { return m ? decodeURIComponent(m[1]) : ""; } catch (e) { return ""; } };
  const fail = (m) => html('<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px -apple-system,sans-serif;padding:24px"><p>' + esc(m) + '</p><p><a href="/login">重试</a> · <a href="/">返回</a></p></body>');
  if (path === "/run/go") run("manual").catch((e) => log("run error " + e)).then((r) => json({ ok: true, r: r === "busy" ? "busy" : "" }));
  else if (path === "/run/progress") {
    const pg = readJ(PROG_KEY);
    if (pg && pg.phase !== "done" && Date.now() - pg.upd > 120000) pg.phase = "done"; // 脚本中途被杀：别让页面一直转
    json(pg || { phase: "" });
  }
  else if (path === "/run") run("manual").catch((e) => log("run error " + e)).then(() => go("#done"));
  else if (path === "/login") loginStart().then(html).catch((e) => fail(String((e && e.message) || e)));
  else if (path === "/login/check") loginCheck().then(json).catch((e) => json({ s: "fail", msg: String((e && e.message) || e) }));
  else if (path === "/settings") html(renderSettings());
  else if (path === "/logout") { // 退出登录：网页 + App 登录状态都清掉，否则会悄悄退回到 App 登录继续签
    del(WEB_KEY); del(AUTH_KEY);
    const st = readState(); st.login = { state: "none" }; st.qr = null; writeJ(STATE_KEY, st);
    go("#out");
  } else if (path === "/reset") { const st = readState(); st.run = null; st.hist = {}; writeJ(STATE_KEY, st); go("#cleared", "settings"); }
  else if (path === "/prefs/skip") {
    const id = qp("id"), prefs = readPrefs();
    if (!/^[0-9A-Za-z_-]{4,40}$/.test(id)) return json({ ok: false });
    if (qp("on") === "1") {
      const hit = ((readState().run || {}).items || []).find((i) => i.id === id);
      prefs.skip[id] = (hit && hit.name) || prefs.skip[id] || label(id);
    } else delete prefs.skip[id];
    writeJ(PREF_KEY, prefs);
    json({ ok: true });
  }
  else html(renderPage());
}

function statusNotify() {
  const auth = readJ(AUTH_KEY), st = readState(), lv = loginView(auth, st), r = st.run;
  const sum = r ? "成功 " + r.ok + " · 已签 " + r.already + " · 失败 " + r.fail + (r.unknown ? " · 未知 " + r.unknown : "") + "（" + ago(r.at) + "）" : "还没有签到记录";
  $notification.post(TITLE, "登录：" + lv.t + "｜" + lv.d, sum, { openUrl: PAGE, url: PAGE });
  $done({ title: TITLE, content: "登录：" + lv.t + "\n" + sum, icon: lv.cls === "ok" ? "checkmark.seal.fill" : "exclamationmark.triangle.fill", "icon-color": lv.cls === "ok" ? "#34C759" : "#FF9F0A" });
}

// ---------- 入口 ----------
const S = (typeof $script !== "undefined" && $script) || {};
if (!enabled) {
  if (typeof $request !== "undefined" && $request && $request.url.indexOf(HOST) !== -1) {
    $done({ response: { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:16px -apple-system,sans-serif;padding:24px">超话签到已在插件设置中关闭。</p>' } });
  } else if (typeof $request !== "undefined" && $request) $done({});
  else $done();
} else if (typeof $request !== "undefined" && $request) {
  if ($request.url.indexOf(HOST) !== -1) serve();
  else {
    try { capture(); } catch (e) { log("capture error: " + e); }
    // 打开微博时的补签：只挂在后台轮询接口上（不影响首页加载）；到点后今天还没签完，就在这次请求里把签到做完
    if (arg.TIME != null && /\/2\/remind\/(unread_count|hometab_dot)/i.test($request.url)) auto("open").catch((e) => log("open error " + e)).then(() => $done({}));
    else $done({});
  }
} else if (S.type === "generic" || /立即|状态/.test(S.name || "")) {
  if (/状态/.test(S.name || "")) statusNotify();
  else run("manual").catch((e) => push("脚本出错", String((e && e.message) || e))).then(() => $done());
} else {
  auto().catch((e) => log("auto error " + e)).then(() => $done()); // 定时任务（含无法识别类型的调用）：一天最多签一次，不会重复打扰
}
