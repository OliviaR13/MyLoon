/* 插件详情全屏抽屉组件（<dialog id="detail">）：
   展示插件介绍、安装前须知、故障排查与插件元数据，复用列表的收藏与唤起安装逻辑。 */

import { sourceUrl } from "./config.js";
import { $, el, svgIcon, starIcon, confirmable, motionOff } from "./dom.js";
import { state, statOf, splitDescription } from "./state.js";
import { fmtCount } from "./stats.js";

const detailEls = {
  dlg: $("#detail"),
  body: $("#detailBody"),
  icon: $("#detailIcon"),
  name: $("#detailName"),
  title: $("#detailTitle"),
  letter: $("#detailLetter"),
  meta: $("#detailMeta"),
  fold: $("#detailFold"),
  sub: $("#detailSub"),
  chips: $("#detailChips"),
  intro: $("#detailIntro"),
  notes: $("#detailNotes"),
  trouble: $("#detailTrouble"),
  info: $("#detailInfo"),
  source: $("#detailSource"),
  install: $("#detailInstall"),
  close: $("#detailClose"),
  favSlot: $("#detailFav"),
};

let detailPlugin = null;
let detailEnd = null;
let detailStar = null;
let detailInstalling = null;
let detailPushed = false;
let lastFocus = null;
let handleToggleFav = null;
let handleOpenInLoon = null;

const POLICY_TAGS = new Set(["代理分流", "IP 属地"]);
const POLICY_STEP = /代理指向的策略|GEOIP,\s*CN,\s*DIRECT/;
const needsPolicy = (p) => (p.proxy !== null ? p.proxy : [p.category, ...p.tags].some((t) => POLICY_TAGS.has(t)));

function installNotes(p) {
  const notes = [];
  if (needsPolicy(p)) {
    notes.push(
      "安装后，在 Loon 的插件详情中选择代理策略组或节点。",
      "建议将插件放在 `GEOIP,CN,DIRECT` 等国内直连规则之前。",
      "未选择时，默认使用全局策略的第一个节点。"
    );
  }
  if (p.mitm) notes.push("需要在 Loon 中开启 MITM 并信任证书，否则相关功能不会生效。");
  if (p.script) notes.push("包含脚本，安装前可以先点「查看源码」确认内容。");
  if (p.args) notes.push("安装后可以在 Loon 的插件详情中调整参数。");
  if (!notes.length) notes.push("无需额外设置，安装后即可使用。");
  return notes;
}

function troubleNotes(p) {
  const notes = [];
  if (p.rule || needsPolicy(p)) notes.push("没生效：先确认插件排在 `GEOIP,CN,DIRECT` 等国内直连规则之前——规则自上而下匹配，先命中的生效。");
  if (p.mitm || p.script) notes.push("带脚本的插件：确认 MITM 已开启，证书已安装并信任。");
  if (needsPolicy(p)) notes.push("确认在插件详情里选的策略组或节点可用。建议选固定的单一节点，自动测速类的策略组切换节点时可能中断已建立的连接。");
  if (p.mitm || p.script) notes.push("同时启用了对相同域名做 MITM 解密或改写响应体的其他插件（如去广告类）时，各插件独立生效，出现异常需要分别排查。");
  if (needsPolicy(p)) notes.push("连接偶尔失败不一定是插件的问题：插件只决定走代理还是直连，连接被取消、重置或超时，原因可能在 App、节点、CDN 或链路。");
  return notes;
}

function introSegments(p, segs) {
  if (!needsPolicy(p)) return segs;
  const kept = segs.filter((s) => !POLICY_STEP.test(s));
  return kept.length ? kept : segs;
}

function noteItem(text) {
  const li = el("li");
  text.split("`").forEach((s, i) => { if (s) li.append(i % 2 ? el("code", "", s) : document.createTextNode(s)); });
  return li;
}

const shownVersion = (p) => (p.version ? (/^\d/.test(p.version) ? "v" + p.version : p.version) : "");

function metaCells(p) {
  return [["作者", p.author], ["版本", shownVersion(p)], ["更新", p.date]].filter(([, v]) => v);
}

function infoRows(p) {
  const rows = [];
  const add = (k, v) => { const r = el("div", "row"); r.append(el("span", "muted", k), v); rows.push(r); };
  add("配置参数", el("span", "d-val", p.args ? "可在 Loon 中调整" : "无"));
  if (state.stats.on) {
    const total = statOf(p, "total"), week = statOf(p, "week");
    add("安装次数", el("span", "d-val", total ? `共 ${fmtCount(total)} 次，本周 ${fmtCount(week)} 次` : "暂无记录"));
  }
  if (p.allTags.length) {
    const wrap = el("span", "d-val d-tagwrap");
    wrap.append(...p.allTags.map((t) => el("span", "chip", t)));
    add("标签", wrap);
  }
  return rows;
}

export function syncDetailFav() {
  if (!detailPlugin || !detailStar) return;
  const on = state.favorites.has(detailPlugin.id);
  detailStar.setAttribute("aria-pressed", String(on));
  detailStar.setAttribute("aria-label", (on ? "取消收藏 " : "收藏 ") + detailPlugin.name);
}

function fillDetail(p) {
  const d = detailEls;
  const letterIcon = () => { d.icon.hidden = true; d.icon.removeAttribute("src"); d.letter.hidden = false; };
  d.letter.textContent = ([...p.name.trim()][0] || "?").toUpperCase();
  d.icon.onerror = letterIcon;
  if (p.icon) { d.icon.src = p.icon; d.icon.hidden = false; d.letter.hidden = true; }
  else letterIcon();
  d.name.textContent = p.name;
  d.title.textContent = p.name;
  const cells = metaCells(p);
  d.meta.hidden = !cells.length;
  d.meta.style.setProperty("--n", cells.length);
  d.meta.replaceChildren(...cells.map(([k, v]) => { const c = el("div", "d-cell"); c.append(el("span", "d-k", k), el("span", "d-v", v)); return c; }));
  const sub = [shownVersion(p), p.category].filter(Boolean).join(" · ");
  d.sub.textContent = sub;
  d.sub.hidden = !sub;

  const chip = (text, need) => { const c = el("span", "chip", text); if (need) c.dataset.need = ""; return c; };
  d.chips.replaceChildren(
    chip(p.mitm ? "需 MITM" : "无需 MITM", p.mitm),
    chip(p.script ? "含脚本" : "无需脚本", p.script),
    ...(p.args ? [chip("可配置", false)] : [])
  );
  const segs = introSegments(p, splitDescription(p.description));
  d.intro.replaceChildren(...(segs.length ? segs.map((s) => el("span", "seg", s)) : [el("span", "seg d-empty", "这个插件还没有填写介绍。")]));
  d.notes.replaceChildren(...installNotes(p).map(noteItem));
  const trouble = troubleNotes(p);
  d.fold.hidden = !trouble.length;
  d.fold.open = false;
  d.trouble.replaceChildren(...trouble.map(noteItem));
  d.info.replaceChildren(...infoRows(p));
  [...d.body.children].forEach((c, i) => c.style.setProperty("--i", i));
  d.source.href = sourceUrl(p);
  detailInstalling?.off();
  syncDetailFav();
}

function cancelDetailClose() {
  if (detailEnd) {
    detailEls.dlg.removeEventListener("transitionend", detailEnd.fn);
    clearTimeout(detailEnd.timer);
    detailEnd = null;
  }
  detailEls.dlg.classList.remove("closing");
}

/* ---------- 共享元素转场：卡片 ⇄ 详情页 ----------
   用 View Transitions 给「卡片整体 / 图标 / 标题」各起一个名字（plugin-card / plugin-icon / plugin-title），
   两边同名的元素浏览器会自动配对：卡片扩展成详情页，图标和标题从卡片里的位置平滑移到详情页的位置。
   名字只在转场期间挂上（卡片上是 .vt-src，详情上是 [data-vt]），同一时刻每个名字只能有一个元素，所以新旧两侧要错开挂。
   样式见 detail.css 末尾。不支持、开了「减少动画」、或找不到卡片（被筛选掉、滚出屏幕）时，退回原来的抽屉滑入滑出。 */

let morphing = null; // 转场进行中时是一个 Promise，结束后置空

const canMorph = () => typeof document.startViewTransition === "function" && !motionOff();

function cardOf(id) {
  if (!window.CSS || !CSS.escape) return null;
  return document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
}

function cardOnScreen(card) {
  if (!card || !card.isConnected) return false;
  const r = card.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
}

function trackMorph(vt, cleanup) {
  vt.ready.catch(() => {});
  morphing = vt.finished.catch(() => {}).then(() => {
    cleanup();
    morphing = null;
  });
  return morphing;
}

function showDialog(dlg, instant) {
  dlg.showModal();
  detailEls.body.scrollTop = 0;
  dlg.classList.remove("scrolled", "enter");
  if (instant) dlg.classList.add("open", "vt-in");
  void dlg.offsetWidth;
  dlg.classList.add("enter");
  if (!instant) requestAnimationFrame(() => dlg.classList.add("open"));
}

function openMorph(dlg, card) {
  const icon = detailEls.icon;
  card.classList.add("vt-src");
  dlg.dataset.vt = "all";
  const vt = document.startViewTransition(async () => {
    // 新状态里名字归详情页，卡片要先让出来；同时把卡片藏起来，不然原位还留着一张，会和正在展开的那份叠成两层
    card.classList.replace("vt-src", "vt-hide");
    showDialog(dlg, true);
    // 图标换了个 <img>，等它解码完再让浏览器截新状态，免得转场开头是个空白方块
    if (!icon.hidden && icon.src) await Promise.race([icon.decode().catch(() => {}), new Promise((r) => setTimeout(r, 160))]);
  });
  trackMorph(vt, () => { card.classList.remove("vt-src", "vt-hide"); delete dlg.dataset.vt; });
}

export function openDetail(p) {
  const dlg = detailEls.dlg;
  cancelDetailClose();
  detailPlugin = p;
  fillDetail(p);
  dlg.classList.remove("vt-in");
  if (!dlg.open) {
    lastFocus = document.activeElement;
    document.documentElement.style.setProperty("--page-sbw", window.innerWidth - document.documentElement.clientWidth + "px");
    // 压入一条历史记录：手机返回键 / 侧滑返回时关闭详情，而不是离开整个页面
    if (!detailPushed) { history.pushState({ mlbDetail: 1 }, ""); detailPushed = true; }
    const card = canMorph() && !morphing ? cardOf(p.id) : null;
    if (cardOnScreen(card)) { openMorph(dlg, card); return; }
    showDialog(dlg, false);
    return;
  }
  detailEls.body.scrollTop = 0;
  dlg.classList.remove("scrolled", "enter");
  void dlg.offsetWidth;
  dlg.classList.add("enter");
  requestAnimationFrame(() => dlg.classList.add("open"));
}

function finishClose() {
  const dlg = detailEls.dlg;
  cancelDetailClose();
  if (dlg.open) dlg.close();
  detailPlugin = null;
  if (lastFocus && lastFocus.isConnected && lastFocus !== document.body) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}

function closeMorph(dlg, card) {
  // 详情已经滚过头部时，图标和标题不在视野里，就只收卡片本体，不让它们从屏幕外飞回来
  dlg.dataset.vt = detailEls.body.scrollTop > 24 ? "card" : "all";
  const vt = document.startViewTransition(() => {
    finishClose();
    dlg.classList.remove("open", "enter", "vt-in");
    delete dlg.dataset.vt; // 新状态里名字归卡片
    card.classList.add("vt-src");
  });
  trackMorph(vt, () => { card.classList.remove("vt-src"); delete dlg.dataset.vt; });
}

function animateClose() {
  const dlg = detailEls.dlg;
  if (!dlg.open || detailEnd) return;
  if (morphing) { morphing.then(animateClose); return; } // 比如转场还没播完就按了返回键
  const card = canMorph() && detailPlugin ? cardOf(detailPlugin.id) : null;
  if (cardOnScreen(card)) { closeMorph(dlg, card); return; }
  dlg.classList.add("closing");
  dlg.classList.remove("open");
  const fn = (e) => { if (e.target === dlg && e.propertyName === "transform") finishClose(); };
  detailEnd = { fn, timer: setTimeout(finishClose, 600) };
  dlg.addEventListener("transitionend", fn);
}

export function closeDetail() {
  if (!detailEls.dlg.open || detailEnd || morphing) return;
  if (detailPushed) history.back();
  else animateClose();
}

export function initDetail({ onToggleFav, onOpenInLoon }) {
  handleToggleFav = onToggleFav;
  handleOpenInLoon = onOpenInLoon;

  detailStar = el("button", "star");
  detailStar.type = "button";
  detailStar.append(starIcon());
  detailStar.addEventListener("click", () => { if (detailPlugin && handleToggleFav) handleToggleFav(detailPlugin.id, detailStar); });
  detailEls.favSlot.replaceChildren(detailStar);

  detailInstalling = confirmable(detailEls.install, "唤起中…", false);
  detailEls.install.querySelector(".lbl:not(.lbl-alt)").prepend(svgIcon("M12 4v10M8 10.5l4 4 4-4M5 19h14"));
  detailEls.install.addEventListener("click", () => { if (detailPlugin && handleOpenInLoon) handleOpenInLoon(detailPlugin, detailInstalling); });

  detailEls.source.prepend(
    svgIcon(
      "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z",
      { viewBox: "0 0 16 16" }
    )
  );

  // 浮在滚动内容上的 4 个控件（返回、收藏、查看源码、安装）：Apple 官网式磨砂材质，样式见 detail.css 的 .lg
  [detailEls.close, detailStar, detailEls.source, detailEls.install].forEach((b) => b.classList.add("ap"));

  if (window.ResizeObserver) {
    new ResizeObserver(() => detailEls.dlg.style.setProperty("--sbw", detailEls.body.offsetWidth - detailEls.body.clientWidth + "px")).observe(detailEls.body);
  }
  window.addEventListener("popstate", () => {
    if (!detailPushed) return;
    detailPushed = false;
    animateClose();
  });
  // 滚过头部后，顶栏淡入插件名
  let scrolled = false;
  detailEls.body.addEventListener("scroll", () => {
    const now = detailEls.body.scrollTop > 64;
    if (now !== scrolled) { scrolled = now; detailEls.dlg.classList.toggle("scrolled", now); }
  }, { passive: true });
  detailEls.close.addEventListener("click", closeDetail);
  detailEls.dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeDetail(); });
  detailEls.dlg.addEventListener("click", (e) => { if (e.target === detailEls.dlg) closeDetail(); });
}
