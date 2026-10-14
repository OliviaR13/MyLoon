/* 插件详情全屏抽屉组件（<dialog id="detail">）：
   展示插件介绍、安装前须知、故障排查与插件元数据，复用列表的收藏与唤起安装逻辑。 */

import { sourceUrl } from "./config.js";
import { $, el, svgIcon, starIcon, confirmable } from "./dom.js";
import { state, splitDescription } from "./state.js";

const detailEls = {
  dlg: $("#detail"),
  body: $("#detailBody"),
  icon: $("#detailIcon"),
  name: $("#detailName"),
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
  if (!notes.length) notes.push("暂时没有针对这个插件的特别排查项。");
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

function infoRows(p) {
  return [
    ["作者", p.author],
    ["版本", p.version],
    ["最近更新", p.date],
    ["配置参数", p.args ? "可在 Loon 中调整" : "无"],
    ["标签", p.allTags.join("、")],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => {
      const r = el("div", "row");
      r.append(el("span", "muted", k), el("span", "d-val", v));
      return r;
    });
}

export function syncDetailFav() {
  if (!detailPlugin || !detailStar) return;
  const on = state.favorites.has(detailPlugin.id);
  detailStar.setAttribute("aria-pressed", String(on));
  detailStar.setAttribute("aria-label", (on ? "取消收藏 " : "收藏 ") + detailPlugin.name);
}

function fillDetail(p) {
  const d = detailEls;
  if (p.icon) { d.icon.src = p.icon; d.icon.hidden = false; }
  else { d.icon.removeAttribute("src"); d.icon.hidden = true; }
  d.name.textContent = p.name;
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
  d.trouble.replaceChildren(...troubleNotes(p).map(noteItem));
  d.info.replaceChildren(...infoRows(p));
  [...d.body.children].forEach((c, i) => c.style.setProperty("--i", Math.ceil(i / 2)));
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

export function openDetail(p) {
  const dlg = detailEls.dlg;
  cancelDetailClose();
  detailPlugin = p;
  fillDetail(p);
  if (!dlg.open) document.documentElement.style.setProperty("--page-sbw", window.innerWidth - document.documentElement.clientWidth + "px");
  if (!dlg.open) dlg.showModal();
  detailEls.body.scrollTop = 0;
  dlg.classList.remove("enter");
  void dlg.offsetWidth;
  dlg.classList.add("enter");
  requestAnimationFrame(() => dlg.classList.add("open"));
}

export function closeDetail() {
  const dlg = detailEls.dlg;
  if (!dlg.open || detailEnd) return;
  dlg.classList.add("closing");
  dlg.classList.remove("open");
  const finish = () => { cancelDetailClose(); if (dlg.open) dlg.close(); detailPlugin = null; };
  const fn = (e) => { if (e.target === dlg && e.propertyName === "transform") finish(); };
  detailEnd = { fn, timer: setTimeout(finish, 600) };
  dlg.addEventListener("transitionend", fn);
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

  if (window.ResizeObserver) {
    new ResizeObserver(() => detailEls.dlg.style.setProperty("--sbw", detailEls.body.offsetWidth - detailEls.body.clientWidth + "px")).observe(detailEls.body);
  }
  detailEls.close.addEventListener("click", closeDetail);
  detailEls.dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeDetail(); });
  detailEls.dlg.addEventListener("click", (e) => { if (e.target === detailEls.dlg) closeDetail(); });
}
