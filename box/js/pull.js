/* 下拉刷新 × 灵动岛（思路借自 Bencho 的 Pull to refresh · Balance 和 Dynamic Island）：
   接管提示条药丸（#toast），使「下拉 → 刷新 → 结果」复用同一个容器。 */

import { els } from "./dom.js";
import { toastHold, toastPopover, toastSize, hideToast } from "./toast.js";
import { load } from "./manifest.js";

const NS = "http://www.w3.org/2000/svg";
const SIZE = 28, C = SIZE / 2;
const ORBS = 5, ORB_R = 1.9;
const RING = 8;
const R_START = 0.9;
const THRESHOLD = 64;
const RESISTANCE = 340;
const MAX_SHIFT = 80;
const HOLD = 56;
const PILL = { w0: 36, h0: 30, w1: 128, h1: 40 };
const WORK = { w: 124, h: 38 };
const RESULT_HOLD = 1300;
const TEXT = { idle: "下拉刷新", armed: "松手刷新", work: "正在刷新" };

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

const mk = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

export function initPullToRefresh() {
  const shell = document.querySelector(".shell");
  const box = els.toast;
  if (!box) return;

  const layer = document.createElement("div");
  layer.className = "toast-pull";
  layer.setAttribute("aria-hidden", "true");
  const svg = mk("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, width: SIZE, height: SIZE });
  const orbit = mk("g", { class: "pull-orbit" });
  const orbs = Array.from({ length: ORBS }, (_, i) => {
    const o = mk("g", { class: "orb", style: `--i:${i}` });
    const c = o.appendChild(mk("circle", { cx: C, cy: C, r: R_START }));
    orbit.append(o);
    return { o, c };
  });
  svg.append(orbit);
  const label = document.createElement("span");
  label.className = "toast-pull-label";
  label.textContent = TEXT.idle;
  layer.append(svg, label);
  box.append(layer);

  function draw(p, turn = 0) {
    const out = 1 - (1 - p) * (1 - p);
    orbs.forEach(({ o, c }, i) => {
      o.style.transform = `rotate(${(turn + i * (360 / ORBS)).toFixed(1)}deg)`;
      c.setAttribute("cy", (C - RING * out).toFixed(2));
      c.setAttribute("r", lerp(R_START, ORB_R, out).toFixed(2));
    });
  }

  function pill(p, drawn) {
    const e = 1 - (1 - p) * (1 - p);
    const h = lerp(PILL.h0, PILL.h1, e);
    toastSize(lerp(PILL.w0, PILL.w1, e), h, h / 2);
    box.style.setProperty("--lt", clamp((p - 0.45) / 0.4, 0, 1).toFixed(3));
    box.style.opacity = String(clamp((drawn - 8) / 22, 0, 1));
  }

  let settleTimer = 0;
  function shiftShell(y, { animate }) {
    if (!shell) return;
    clearTimeout(settleTimer);
    shell.classList.toggle("pull-drag", !animate);
    shell.classList.toggle("pull-anim", animate);
    shell.style.transform = `translateY(${y.toFixed(1)}px)`;
    if (animate && y === 0) {
      settleTimer = setTimeout(() => {
        shell.style.transform = "";
        shell.classList.remove("pull-anim");
      }, 520);
    }
  }

  let startX = 0, startY = 0, tracking = false, dragging = false, armed = false, busy = false, popTimer = 0, swallow = false, lockH = false;

  const atTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 2;
  const typing = () => {
    const a = document.activeElement;
    return !!a && a.matches("input, textarea");
  };
  const excluded = (e) => e.target.closest("dialog, .sort-menu") || document.querySelector("dialog[open]") || typing();
  const blocked = (e) => busy || !atTop() || !els.list || els.refresh.disabled || excluded(e);
  const shouldSwallow = (e) => (busy || els.refresh.disabled) && atTop() && els.list && !excluded(e);

  function begin() {
    dragging = true;
    toastHold();
    box.style.opacity = "0";
    box.classList.remove("open", "armed", "working", "pop", "leaving");
    box.classList.add("dragging", "pulling", "show");
    label.textContent = TEXT.idle;
    draw(0);
    pill(0, 0);
    toastPopover(true);
  }

  function pop() {
    clearTimeout(popTimer);
    box.classList.remove("pop");
    void box.offsetWidth;
    box.classList.add("pop");
    popTimer = setTimeout(() => box.classList.remove("pop"), 420);
  }

  document.addEventListener("touchstart", (e) => {
    swallow = false;
    if (tracking) release(false);
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    lockH = !!e.target.closest(".filters");
    if (shouldSwallow(e)) { swallow = true; return; }
    if (blocked(e)) return;
    tracking = true;
    armed = false;
    dragging = false;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (swallow) {
      if (e.cancelable && atTop() && e.touches[0].clientY - startY > 0) e.preventDefault();
      return;
    }
    if (!tracking) return;
    const t = e.touches[0];
    const raw = t.clientY - startY;
    if (!atTop()) { if (dragging) release(false); return; }
    if (!dragging) {
      if (raw <= 0) return;
      if (lockH && Math.abs(t.clientX - startX) > raw) { tracking = false; return; }
    }
    if (e.cancelable) e.preventDefault();
    if (!dragging) begin();
    const pull = Math.max(0, raw);
    const drawn = (RESISTANCE * pull) / (RESISTANCE + pull);
    const p = clamp(drawn / THRESHOLD, 0, 1);
    draw(p, pull * 0.6);
    pill(p, drawn);
    shiftShell(Math.min(drawn, MAX_SHIFT), { animate: false });
    const nowArmed = p >= 1;
    if (nowArmed !== armed) {
      armed = nowArmed;
      box.classList.toggle("armed", armed);
      label.textContent = armed ? TEXT.armed : TEXT.idle;
      if (armed) {
        pop();
        if (navigator.vibrate) navigator.vibrate(8);
      }
    }
  }, { passive: false });

  async function release(commit) {
    const go = commit && armed && dragging;
    tracking = false;
    dragging = false;
    box.classList.remove("dragging");
    if (go) {
      busy = true;
      box.style.opacity = "";
      box.style.setProperty("--lt", "1");
      label.textContent = TEXT.work;
      box.classList.remove("armed");
      box.classList.add("working");
      toastSize(WORK.w, WORK.h, WORK.h / 2);
      shiftShell(HOLD, { animate: true });
      try {
        await Promise.race([load(true), new Promise((r) => setTimeout(r, 15000))]);
      } catch {}
      if (box.classList.contains("pulling")) {
        hideToast();
      } else {
        await new Promise((r) => setTimeout(r, RESULT_HOLD));
        if (box.classList.contains("open")) hideToast();
      }
      busy = false;
    } else if (box.classList.contains("pulling")) {
      box.style.opacity = "0";
      hideToast();
      setTimeout(() => {
        if (!tracking && !busy && !box.classList.contains("show")) box.style.opacity = "";
      }, 460);
    }
    armed = false;
    shiftShell(0, { animate: true });
    setTimeout(() => { if (!tracking && !busy) draw(0); }, 450);
  }

  document.addEventListener("touchend", () => { swallow = false; if (tracking) release(true); }, { passive: true });
  document.addEventListener("touchcancel", () => { swallow = false; if (tracking) release(false); }, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden && tracking) release(false); });
  draw(0);
}
