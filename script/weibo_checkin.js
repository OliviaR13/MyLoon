// 微博超话签到 for Loon（v2：按新版微博 App 抓包重写）
// 同一个脚本，按触发方式分工：
//   http-request（api.weibo.cn）  打开微博时保存登录状态；进入超话页时记录该超话
//   http-request（状态页域名）     visual 状态页：http://weibo-checkin.loon/
//   cron / generic               执行签到、推送汇总 / 推送当前状态
// 所有登录信息只保存在本机的 Loon 持久化存储里，不会出现在仓库或日志中。
// 参数：CHECKIN 签到总开关，NOTIFY 通知开关，DEBUG 调试日志（日志不输出任何登录信息）

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
const enabled = String(arg.CHECKIN) !== "false"; // 插件里的「超话签到」总开关
const notify = String(arg.NOTIFY) !== "false";
const debug = String(arg.DEBUG) === "true";
const log = (...a) => { if (debug) console.log("[weibo_checkin] " + a.join(" ")); };
const push = (sub, body) => { if (notify) $notification.post(TITLE, sub, body || "", { openUrl: PAGE, url: PAGE }); };
const sleep = (ms) => new Promise((r) => (typeof setTimeout === "function" ? setTimeout(r, ms) : r()));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- 存取 ----------
const readJ = (k) => { try { return JSON.parse($persistentStore.read(k) || "null"); } catch (e) { return null; } };
const writeJ = (k, o) => $persistentStore.write(JSON.stringify(o), k);
const readState = () => Object.assign({ topics: {}, signed: { day: "", ids: {} }, login: {}, run: null, running: 0, hist: {} }, readJ(STATE_KEY) || {});
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

  // 「我的超话」列表请求：记下来，之后用它翻页取关注列表（fid / flowId 等于列表页，而不是 lfid）
  const LIST_RE = /(?:^|[?&])(?:fid|containerid|flowId)=232478_-_mine_topic(?:&|$)/;
  const qsRaw = url.split("?")[1] || "";
  if (hd.authorization && (LIST_RE.test(body) || LIST_RE.test(qsRaw))) {
    const extra = qsRaw.split("&").filter((p) => p && KEEP_QS.indexOf(keyOf(p).toLowerCase()) === -1 && !/^(ul_|since_id=)/.test(p));
    const more = /(?:^|[?&])taskType=loadMore(?:&|$)/.test(body + "&" + qsRaw);
    st[more ? "listMore" : "listFirst"] = {
      method: String($request.method || "GET").toUpperCase(), path: url.split("?")[0],
      qs: extra.join("&"), body, ct: hd["content-type"] || "", at: Date.now(),
    };
    dirty = true;
    log("已记录「我的超话」" + (more ? "加载更多" : "首页") + "请求");
  }

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

// 「我的超话」列表：已关注 = card_type 8；「猜你喜欢」之后是推荐（card_type 1022），要排除
function extractMine(json) {
  const out = [];
  let reco = false;
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.category === "card" && n.data) {
      const d = n.data;
      if (d.itemid === "mine_topic_recommend_title" || Number(d.card_type) === 1022) { reco = true; return; }
      if (!reco && Number(d.card_type) === 8) {
        const id = (ID_RE.exec(String(d.scheme || "")) || [])[0];
        const b = (d.buttons || [])[0];
        const unfollowed = b && b.type === "follow" && !/已关注/.test(String(b.name || ""));
        if (id && !unfollowed) out.push({ id, name: d.title_sub || "", done: false });
      }
      return;
    }
    Object.keys(n).forEach((k) => walk(n[k]));
  };
  walk(json);
  return { out, reco };
}

function setP(s, k, v, add) {
  const re = new RegExp("(^|&)" + k + "=[^&]*");
  if (v === null) return s.replace(re, "").replace(/^&/, "");
  if (re.test(s)) return s.replace(re, "$1" + k + "=" + encodeURIComponent(v));
  return add ? (s ? s + "&" : "") + k + "=" + encodeURIComponent(v) : s;
}

// 按记录下来的请求模板翻页：每页返回的 moreInfo.params 就是下一页的 page / since_id / max_id
async function fetchMine(auth, T, fromMore) {
  const topics = [], seen = new Set();
  let note = "", qs = T.qs || "", body = T.body || "";
  const post = T.method === "POST"; // 参数放在请求体（POST）或查询串（GET）里
  const apply = (k, v) => { qs = setP(qs, k, v, !post); if (post) body = setP(body, k, v, true); };
  if (fromMore) { apply("page", 1); apply("since_id", null); apply("max_id", 0); } // 只有「加载更多」的记录时，尝试从第 1 页开始
  for (let n = 0; n < MAX_PAGES; n++) {
    const url = T.path + "?" + auth.pairs.concat(qs.split("&").filter(Boolean)).join("&");
    const headers = Object.assign({}, auth.headers);
    if (T.method === "POST") headers["content-type"] = T.ct || "application/x-www-form-urlencoded; charset=utf-8";
    const { status, body: resp } = await get(url, headers, { method: T.method, body: T.method === "POST" ? body : null, timeout: 15 });
    const j = parse(resp);
    if (isExpired(status, j)) throw Object.assign(new Error("expired"), { expired: true });
    if (!j) { note = "列表返回异常（HTTP " + status + "）"; break; }
    const { out, reco } = extractMine(j);
    let added = 0;
    for (const t of out) { if (!seen.has(t.id)) { seen.add(t.id); topics.push(t); added++; } }
    const mp = j.moreInfo && j.moreInfo.params;
    log("列表第 " + (n + 1) + " 页，新增 " + added + (reco ? "，已到推荐区" : ""));
    if (reco || !mp || (!added && n > 0)) break;
    for (const k of ["page", "since_id", "max_id"]) if (mp[k] !== undefined) apply(k, mp[k]);
    for (const kv of [["taskType", "loadMore"], ["manualType", "scroll"], ["invokeType", "manual"]]) { qs = setP(qs, kv[0], kv[1]); if (post) body = setP(body, kv[0], kv[1]); }
    await sleep(500);
  }
  if (!topics.length && !note) note = "没有读到关注的超话" + (fromMore ? "，请在微博里下拉刷新「我的超话」页以记录首页请求" : "");
  return { topics, note };
}

async function fetchList(auth, st) {
  const T = st.listFirst || st.listMore;
  if (T) {
    try {
      const r = await fetchMine(auth, T, !st.listFirst);
      return Object.assign(r, { src: "learned" });
    } catch (e) {
      if (e.expired) throw e;
      return { topics: [], src: "learned", note: "列表请求失败：" + String(e.message || e).slice(0, 80) };
    }
  }
  try {
    const r = await fetchLegacy(auth);
    return Object.assign(r, { src: "legacy" });
  } catch (e) {
    if (e.expired) throw e;
    return { topics: [], src: "legacy", note: "旧版列表接口失败：" + String(e.message || e).slice(0, 80) };
  }
}

async function fetchLegacy(auth) {
  const topics = [];
  const seen = new Set();
  let sinceId = "", note = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    let url = "https://api.weibo.cn/2/cardlist?" + auth.pairs.join("&") + "&containerid=100803_-_followsuper";
    if (sinceId) url += "&since_id=" + encodeURIComponent(sinceId);
    const { status, body } = await get(url, auth.headers, { timeout: 10 });
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
      const r = await fetchList(auth, st);
      listed = r.topics; rec.listNote = r.note; rec.listCount = listed.length; rec.listSrc = r.src;
    } catch (e) {
      if (e.expired) rec.expired = true; else rec.listNote = "列表接口：" + String(e.message || e).slice(0, 80);
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
    if (!rec.expired && gotResponse && rec.total) { // 近两周的每日结果，状态页画「近 7 天」
      const d = today(), prev = st.hist[d] || { signed: 0 };
      st.hist[d] = { signed: Math.max(prev.signed, rec.ok + rec.already), fail: rec.fail, total: rec.total };
      Object.keys(st.hist).sort().slice(0, -14).forEach((k) => delete st.hist[k]);
    }
    if (rec.expired) st.login = { state: "expired" };
    else if (gotResponse) st.login = { state: "ok", verified: Date.now() };
    else rec.netFail = true;
    writeJ(STATE_KEY, st);
  }

  if (rec.expired) { push("登录已失效", "请重新打开微博 App 刷新登录状态"); return; }
  if (!rec.total) { push("没有可签到的超话", "请打开微博 →「我的超话」页一次，之后会自动记录"); return; }
  if (rec.netFail) { push("网络请求全部失败", "没有收到微博服务器的任何响应，详情见状态页"); return; }
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
const friendly = (m) => {
  m = String(m || "");
  if (/Request timeout|无响应/.test(m)) return "请求超时";
  if (/HTTPClient|NSURL|Domain=/.test(m)) return "网络请求失败";
  return m.length > 36 ? m.slice(0, 36) + "…" : m;
};
const clock = (t) => { const d = new Date(t); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); };

const PAGE_CSS = ':root{--bg:#f2f2f7;--card:#fff;--tx:#1c1c1e;--sub:#8a8a8e;--ln:#ececf0;--ok:#30b350;--bad:#ff453a;--warn:#ff9f0a;--mute:#d1d1d6;--okbg:#e6f6ea;--badbg:#ffe9e7;--mutebg:#f0f0f3;--warnbg:#fff3df}' +
  '@media(prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--tx:#f5f5f7;--sub:#98989d;--ln:#2c2c2e;--ok:#32d74b;--mute:#48484a;--okbg:#10301a;--badbg:#3a1614;--mutebg:#2c2c2e;--warnbg:#3a2a0a}}' +
  '*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}html{-webkit-text-size-adjust:100%}' +
  'body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif;padding:max(18px,env(safe-area-inset-top)) 16px calc(112px + env(safe-area-inset-bottom))}' +
  'main{max-width:560px;margin:0 auto}header{display:flex;align-items:baseline;justify-content:space-between;margin:6px 4px 14px}h1{font-size:28px;line-height:1.1;margin:0;letter-spacing:-.5px}header span{color:var(--sub);font-size:13px}' +
  '.card{background:var(--card);border-radius:20px;padding:18px;margin-bottom:12px}h2{font-size:12px;letter-spacing:.4px;color:var(--sub);font-weight:600;margin:0 0 12px}' +
  '.hero{display:flex;align-items:center;gap:18px}.ring{position:relative;width:104px;height:104px;flex:none}.ring svg{transform:rotate(-90deg)}.ring circle{fill:none;stroke-width:9;stroke-linecap:round}.ring .bg{stroke:var(--ln)}' +
  '.ring .fg{stroke:var(--ok);animation:fill .9s cubic-bezier(.2,.8,.2,1)}@keyframes fill{from{stroke-dasharray:0 var(--c)}}' +
  '.ring div{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}.ring b{font-size:26px;line-height:1;font-variant-numeric:tabular-nums}.ring small{color:var(--sub);font-size:11px;margin-top:3px}' +
  '.side{min-width:0;flex:1}.pill{display:inline-flex;align-items:center;gap:6px;padding:3px 12px 3px 9px;border-radius:99px;font-weight:600;font-size:14px}.pill:before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}' +
  '.pill.ok{background:var(--okbg);color:var(--ok)}.pill.bad{background:var(--badbg);color:var(--bad)}.pill.warn{background:var(--warnbg);color:var(--warn)}.sub{color:var(--sub);font-size:13px;margin:6px 0 0}' +
  '.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.chip{font-size:12px;padding:2px 9px;border-radius:99px;background:var(--mutebg);color:var(--sub);white-space:nowrap}.chip.ok{background:var(--okbg);color:var(--ok)}.chip.fail{background:var(--badbg);color:var(--bad)}.chip.already{background:var(--mutebg);color:var(--sub)}' +
  '.step{display:flex;gap:12px;align-items:flex-start;padding:9px 0}.step+.step{border-top:1px solid var(--ln)}.dot{flex:none;width:22px;height:22px;border-radius:50%;border:2px solid var(--mute);display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;margin-top:1px}' +
  '.dot.ok{background:var(--ok);border-color:var(--ok)}.dot.part{border-color:var(--warn)}.step b{display:block;font-size:15px}.step span{color:var(--sub);font-size:13px}' +
  '.week{display:flex;justify-content:space-between}.week div{text-align:center;color:var(--sub);font-size:11px}.week i{display:block;width:34px;height:34px;border-radius:11px;margin:0 auto 5px;background:var(--mutebg)}.week i.ok{background:var(--ok)}.week i.warn{background:var(--warn)}.week .now{color:var(--tx);font-weight:600}' +
  '.seg{margin-bottom:6px}.seg span{display:inline-block;margin:0 6px 6px 0;font-size:13px;line-height:1.3;padding:6px 14px;border-radius:99px;background:var(--mutebg);color:var(--sub);white-space:nowrap;cursor:pointer}.seg span.on{background:var(--tx);color:var(--card);font-weight:600}' +
  'ul{list-style:none;margin:0;padding:0}li{display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--ln)}li:first-child{border-top:0}li[hidden]{display:none}' +
  '.av{flex:none;width:40px;height:40px;border-radius:13px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:17px;color:#fff;background:hsl(var(--h),52%,56%)}.tx{flex:1;min-width:0}.tx b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tx small{display:block;color:var(--sub);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  '.empty{color:var(--sub);text-align:center;padding:18px 0 8px;font-size:14px}details summary{cursor:pointer;color:var(--sub);font-size:13px;list-style:none}details summary:after{content:" ›"}details[open] summary:after{content:" ⌄"}details p{margin:10px 0 0;color:var(--sub);font-size:12px;word-break:break-all}' +
  '.bar{position:fixed;left:0;right:0;bottom:0;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:var(--bg);background:color-mix(in srgb,var(--bg) 82%,transparent);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}.bar div{max-width:560px;margin:0 auto;display:flex;gap:10px}' +
  '.bar a{flex:1;text-align:center;text-decoration:none;font-weight:600;padding:14px;border-radius:15px;background:var(--card);color:var(--tx)}.bar a.p{flex:2;background:var(--ok);color:#fff}.bar a.busy{opacity:.65;pointer-events:none}' +
  '.hint{text-align:center;color:var(--sub);font-size:12px;margin-top:14px}';

const PAGE_JS = "var r=document.getElementById('run');if(r)r.onclick=function(){r.className='p busy';r.textContent='签到中… 约需 1 分钟，请勿关闭';};" +
  "addEventListener('pageshow',function(){if(r){r.className='p';r.textContent='立即签到';}});" +
  "var bs=document.querySelectorAll('.seg span');for(var i=0;i<bs.length;i++)bs[i].onclick=function(){var f=this.getAttribute('data-f');" +
  "for(var j=0;j<bs.length;j++)bs[j].className=bs[j]===this?'on':'';var ls=document.querySelectorAll('li[data-st]');" +
  "for(var k=0;k<ls.length;k++)ls[k].hidden=f!=='all'&&ls[k].getAttribute('data-st')!==f;};";

function renderPage() {
  const auth = readJ(AUTH_KEY), st = readState(), lv = loginView(auth, st), r = st.run;
  const now = new Date();
  const dateStr = now.getMonth() + 1 + "月" + now.getDate() + "日 周" + "日一二三四五六"[now.getDay()];
  const signed = r ? r.ok + r.already : 0;
  const total = r ? Math.max(r.total, 1) : 1;
  const C = 2 * Math.PI * 42, len = C * (r ? Math.min(1, signed / total) : 0);
  const nVisited = Object.keys(st.topics).length;

  // 顶部：进度环 + 登录状态
  const chips = r ? '<div class="chips">' + (r.exp ? '<span class="chip ok">经验 +' + r.exp + "</span>" : "") +
    '<span class="chip">' + clock(r.at) + " · " + (r.trigger === "cron" ? "定时" : "手动") + '</span><span class="chip">用时 ' + Math.max(1, Math.round(r.ms / 1000)) + " 秒</span>" +
    (r.fail ? '<span class="chip fail">失败 ' + r.fail + "</span>" : "") + (r.skipped ? '<span class="chip">未处理 ' + r.skipped + "</span>" : "") + "</div>" : "";
  const hero = '<div class="card hero"><div class="ring"><svg width="104" height="104" viewBox="0 0 104 104"><circle class="bg" cx="52" cy="52" r="42" fill="none" stroke="#ececf0" stroke-width="9"/><circle class="fg" cx="52" cy="52" r="42" fill="none" stroke="#30b350" stroke-width="9" stroke-linecap="round" stroke-dasharray="' + len.toFixed(1) + " " + C.toFixed(1) + '" stroke-opacity="' + (len > 0.5 ? 1 : 0) + '" style="--c:' + C.toFixed(1) + '"/></svg>' +
    "<div><b>" + (r ? signed + "/" + r.total : "—") + "</b><small>今日已签</small></div></div>" +
    '<div class="side"><span class="pill ' + lv.cls + '">登录' + lv.t + '</span><p class="sub">' + esc(lv.d) + "</p>" + chips + "</div></div>";

  // 设置进度（全部完成后自动隐藏）
  const steps = [
    { ok: !!auth && st.login.state !== "expired", t: "登录状态", d: auth ? lv.d : "打开微博 App 即可自动获取" },
    { ok: !!st.listFirst, part: !st.listFirst && (!!st.listMore || nVisited > 0), t: "关注的超话",
      d: st.listFirst ? "已记录「我的超话」" : st.listMore ? "请在「我的超话」页下拉刷新一次" : nVisited ? "已记录 " + nVisited + " 个进入过的超话；进入「我的超话」页可读取全部" : "打开微博 →「我的超话」，下拉刷新" },
    { ok: !!(r && r.total && !r.netFail), t: "首次签到", d: r ? (r.netFail ? "没有收到微博的响应，请检查代理 / 网络" : r.total ? "已完成" : "没有可签的超话") : "点下方「立即签到」试一次" },
  ];
  const setup = steps.every((x) => x.ok) ? "" : '<div class="card"><h2>开始使用</h2>' + steps.map((x) =>
    '<div class="step"><span class="dot ' + (x.ok ? "ok" : x.part ? "part" : "") + '">' + (x.ok ? "✓" : "") + "</span><div><b>" + x.t + "</b><span>" + esc(x.d) + "</span></div></div>").join("") + "</div>";

  // 近 7 天
  let week = '<div class="card"><h2>近 7 天</h2><div class="week">';
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2);
    const h = st.hist[key];
    week += '<div class="' + (i === 0 ? "now" : "") + '"><i class="' + (h ? (h.fail ? "warn" : "ok") : "") + '"></i>' + (i === 0 ? "今天" : "日一二三四五六"[d.getDay()]) + "</div>";
  }
  week += "</div></div>";

  // 列表（失败优先）+ 筛选
  const order = { fail: 0, ok: 1, already: 2 };
  const items = (r ? r.items : []).slice().sort((a, b) => (order[a.st] || 0) - (order[b.st] || 0));
  const count = (k) => items.filter((i) => i.st === k).length;
  const lbl = { ok: "成功", already: "已签", fail: "失败" };
  const rows = items.map((i) => {
    const ch = Array.from(String(i.name || "?"))[0];
    const sub = i.st === "ok" ? (i.streak ? "连签 " + i.streak + " 天" : "签到成功") + (i.exp ? " · 经验 +" + i.exp : "") : i.st === "already" ? "今日已签" : friendly(i.msg);
    return '<li data-st="' + esc(i.st) + '"><span class="av" style="--h:' + ((ch.codePointAt(0) * 47) % 360) + '">' + esc(ch) + '</span><div class="tx"><b>' + esc(i.name) + "</b><small>" + esc(sub) +
      '</small></div><span class="chip ' + esc(i.st) + '">' + (lbl[i.st] || "未知") + "</span></li>";
  }).join("");
  const list = '<div class="card"><h2>超话</h2>' + (items.length ?
    '<div class="seg"><span class="on" data-f="all">全部 ' + items.length + '</span><span data-f="fail">失败 ' + count("fail") + '</span><span data-f="ok">成功 ' + count("ok") + '</span><span data-f="already">已签 ' + count("already") + "</span></div><ul>" + rows + "</ul>" :
    '<p class="empty">' + (r ? "这次没有处理任何超话" : "还没有签到记录") + "</p>") + "</div>";

  // 诊断信息（折叠）
  const learned = st.listFirst ? "已记录「我的超话」首页请求" : st.listMore ? "只记录了「加载更多」，请在微博里下拉刷新「我的超话」页" : "还没有记录「我的超话」列表请求";
  const diag = '<div class="card"><details><summary>诊断信息</summary><p>' + (r ? "关注列表 " + r.listCount + " 个 · 进入过 " + (r.visited || 0) + " 个" + (r.listNote ? "<br>" + esc(r.listNote) : "") : "进入过的超话 " + nVisited + " 个") +
    (r && r.netFail ? "<br>⚠️ 本次没有收到微博服务器的任何响应（网络或代理问题，不是登录问题）" : "") + "<br>" + learned + "<br>数据仅保存在本机 Loon 中</p></details></div>";

  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>微博超话签到</title><style>' + PAGE_CSS + "</style></head><body><main>" +
    "<header><h1>超话签到</h1><span>" + dateStr + "</span></header>" + hero + setup + week + list + diag +
    '</main><div class="bar"><div><a href="/">刷新</a><a class="p" id="run" href="/run">立即签到</a></div></div><script>' + PAGE_JS + "</script></body></html>";
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
if (!enabled) {
  if (typeof $request !== "undefined" && $request && $request.url.indexOf(HOST) !== -1) {
    $done({ response: { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><p style="font:16px -apple-system,sans-serif;padding:24px">超话签到已在插件设置中关闭。</p>' } });
  } else if (typeof $request !== "undefined" && $request) $done({});
  else $done();
} else if (typeof $request !== "undefined" && $request) {
  if ($request.url.indexOf(HOST) !== -1) serve();
  else { try { capture(); } catch (e) { log("capture error: " + e); } $done({}); }
} else if (S.type === "generic" && /状态/.test(S.name || "")) {
  statusNotify();
} else {
  run(S.type === "cron" ? "cron" : "manual")
    .catch((e) => push("脚本出错", String((e && e.message) || e)))
    .then(() => $done());
}
