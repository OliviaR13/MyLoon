/* Cloudflare Turnstile 人机验证与插件清单加载流程 */

import { CONFIG, FAV, VERIFIED_KEY, VERIFIED_TTL } from "./config.js";
import { els } from "./dom.js";
import { state, normalize, loggedHint } from "./state.js";
import { toast } from "./toast.js";
import { notice, render, renderFilters, renderLoading, setPhase, passSettled, setVerifying } from "./render.js";
import { tour, splash } from "./tour-splash.js";

/* ---------- Turnstile 人机验证 ---------- */

let tsWidget = null;
let tsTimer = 0;

const TS_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/* 等组件脚本就绪。网络慢 / 第一次请求失败时，不是直接判失败：超时后把脚本标签换成新的再等一轮（只重试一次） */
function whenTurnstileReady() {
  const wait = () =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      (function check() {
        if (window.turnstile && typeof window.turnstile.render === "function") return resolve();
        if (Date.now() - start > CONFIG.turnstile.loadTimeout) return reject(new Error("script"));
        setTimeout(check, 100);
      })();
    });
  return wait().catch(() => {
    document.querySelectorAll('script[src^="https://challenges.cloudflare.com/turnstile/"]').forEach((s) => s.remove());
    const s = document.createElement("script");
    s.src = TS_SRC;
    s.async = true;
    document.head.append(s);
    return wait();
  });
}

/* 这几类错误码（站点密钥 / 域名 / action / 浏览器不受支持）重试没有用，直接报；其余（网络抖动、内部错误）交给组件自己重试 */
const FATAL = /^(1101|1102|1104|1105|4000)/;

const verifyPanel = () => els.list.querySelector(".verify");
function setInteractive(on) {
  const p = verifyPanel();
  if (p) p.dataset.interactive = String(on);
}

function removeTurnstile() {
  if (tsWidget !== null && window.turnstile && typeof window.turnstile.remove === "function") {
    window.turnstile.remove(tsWidget);
  }
  tsWidget = null;
  setInteractive(false);
}

function armTimer(ms, reject) {
  clearTimeout(tsTimer);
  tsTimer = setTimeout(() => {
    removeTurnstile();
    reject(new Error("turnstile timeout"));
  }, ms);
}

async function getToken() {
  await whenTurnstileReady();
  removeTurnstile();
  let errors = 0;
  return new Promise((resolve, reject) => {
    armTimer(CONFIG.turnstile.totalTimeout, reject);
    tsWidget = window.turnstile.render("#tsBox", {
      sitekey: CONFIG.turnstile.siteKey,
      action: CONFIG.turnstile.action,
      theme: "auto",
      language: "zh-cn",
      appearance: "interaction-only",
      size: "flexible",
      retry: "auto",
      "retry-interval": 3000,
      "refresh-expired": "auto",
      "refresh-timeout": "auto",
      callback: (token) => {
        clearTimeout(tsTimer);
        removeTurnstile();
        resolve(token);
      },
      "before-interactive-callback": () => {
        splash.hide(true);
        /* 验证需要点一下时，人得看得到复选框：设置面板开着的话先关掉 */
        document.getElementById("settings")?.open && document.getElementById("settings").close();
        armTimer(CONFIG.turnstile.interactiveTimeout, reject);
        setInteractive(true);
        setPhase("请点击下方的复选框完成验证");
      },
      "after-interactive-callback": () => {
        armTimer(CONFIG.turnstile.totalTimeout, reject);
        setInteractive(false);
        setPhase("正在验证…");
      },
      "expired-callback": () => window.turnstile.reset(tsWidget),
      "timeout-callback": () => window.turnstile.reset(tsWidget),
      "error-callback": (code) => {
        const c = String(code || "");
        errors += 1;
        if (FATAL.test(c) || errors > 2) {
          clearTimeout(tsTimer);
          removeTurnstile();
          reject(new Error("turnstile " + c));
          return true;
        }
        setPhase("验证遇到点问题，正在重试…");
        return true; // 已处理；组件会按 retry:"auto" 自己再来一次
      },
    });
  });
}

/* ---------- 清单加载与免验证期会话管理 ---------- */

function recentlyVerified() {
  try { return Date.now() - Number(sessionStorage.getItem(VERIFIED_KEY)) < VERIFIED_TTL; } catch { return false; }
}

function markVerified() {
  try { sessionStorage.setItem(VERIFIED_KEY, String(Date.now())); } catch {}
}

const postJson = (url, payload) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

export async function load(announce = false) {
  els.list.setAttribute("aria-busy", "true");
  els.refresh.disabled = true;
  els.count.textContent = "加载中";
  els.updated.textContent = "";
  const needVerify = CONFIG.turnstile.siteKey && !recentlyVerified() && !loggedHint();
  renderLoading(needVerify ? "正在进行人机验证…" : "正在加载清单…");

  let waitingToken = false;
  const slowTimer = setTimeout(() => { if (waitingToken) setPhase("验证时间较长，请稍候…"); }, 4000);

  try {
    let res;
    if (!CONFIG.turnstile.siteKey) {
      res = await fetch(CONFIG.staticManifest, { cache: "no-store" });
    } else {
      if (recentlyVerified() || loggedHint()) {
        res = await postJson(CONFIG.manifest, {});
        if (!res.ok) res = null;
      }
      if (!res) {
        waitingToken = true;
        const token = await getToken();
        waitingToken = false;
        clearTimeout(slowTimer);
        setPhase("验证通过，正在加载清单…", true);
        res = await postJson(CONFIG.manifest, { token });
        if (res.ok) markVerified();
        /* 让验证格子融合成「已通过」胶囊的那一下走完再换成清单（清单请求通常更快，所以这里多等的只是差额） */
        await passSettled();
      }
    }
    if (!res.ok) {
      let reason = "";
      try { reason = (await res.json()).reason || ""; } catch {}
      throw new Error(res.status === 403 ? "verify:" + reason : "HTTP " + res.status);
    }
    const data = await res.json();
    state.plugins = (data.plugins || []).map(normalize);
    state.generatedAt = data.generatedAt || "";
    /* 分类只在它已经不存在时才回到「全部」：验证期间用户可能已经点了 Dock 的「收藏」，不能一加载完又被拉回主页 */
    const known = new Set(state.plugins.map((p) => p.category));
    if (state.category !== FAV && state.category !== CONFIG.all && !known.has(state.category)) state.category = CONFIG.all;
    setVerifying(false);
    renderFilters();
    render({ animate: true });
    if (data.generatedAt) {
      els.updated.textContent = "清单更新于 " + new Date(data.generatedAt).toLocaleDateString("zh-CN");
    }
    if (announce) toast("清单已刷新");
    tour.maybeShow();
  } catch (err) {
    console.error(err);
    const msg = String(err.message);
    const verify = msg.startsWith("verify") || msg === "script" || msg.startsWith("turnstile");
    els.count.textContent = verify ? "人机验证未通过" : "清单加载失败";
    els.list.replaceChildren(
      notice(
        verify ? "人机验证未通过" : "暂时拿不到插件清单",
        verify
          ? "请检查网络后重试。如果当前网络访问不到 Cloudflare，验证组件无法加载。错误信息：" + msg
          : "可能是网络问题，或清单尚未生成。可以重试，也可以到 GitHub 的 plugin 目录手动获取。",
        "重试",
        () => load(true)
      )
    );
  } finally {
    setVerifying(false);
    clearTimeout(slowTimer);
    removeTurnstile();
    els.refresh.disabled = false;
    els.list.setAttribute("aria-busy", "false");
    splash.hide();
  }
}
