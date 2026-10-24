/* 安装统计：读取各插件的安装次数，点「安装」时上报一次。
   后端是 Cloudflare D1（绑定名 MLB_DB）。没绑定、请求失败时 state.stats.on 保持 false，界面不显示任何统计。
   数据变化后派发 document 事件 "stats:change"（detail.optimistic 为 true 表示只是本机刚上报的 +1），由 render.js 刷新界面。 */

import { CONFIG, INSTALLED_KEY } from "./config.js";
import { lsGet, lsSet } from "./dom.js";
import { state } from "./state.js";

const changed = (optimistic = false) => document.dispatchEvent(new CustomEvent("stats:change", { detail: { optimistic } }));

/* 1 万以上写成「1.2 万」 */
export function fmtCount(n) {
  if (n < 1e4) return String(n);
  const w = n / 1e4;
  return (w >= 10 ? Math.round(w) : Math.round(w * 10) / 10) + " 万";
}

export async function loadStats({ fresh = false } = {}) {
  try {
    const res = await fetch(CONFIG.stats, fresh ? { cache: "no-store" } : undefined);
    if (!res.ok) return false;
    const d = await res.json();
    if (!d || d.enabled !== true) return false;
    state.stats = { on: true, total: d.total || {}, week: d.week || {} };
    changed();
    return true;
  } catch {
    return false;
  }
}

/* 点「安装」时调用。同一个插件同一天本机只报一次（服务端还会按 IP 再去重一次）。
   用 keepalive：页面马上要去唤起 Loon，请求不能被中途打断 */
export function reportInstall(p) {
  if (!state.stats.on) return;
  const day = new Date().toISOString().slice(0, 10);
  let seen = {};
  try { seen = JSON.parse(lsGet(INSTALLED_KEY) || "{}") || {}; } catch {}
  if (seen[p.id] === day) return;
  const keep = {};
  for (const [id, d] of Object.entries(seen)) if (d === day) keep[id] = d; // 只留今天的，不让它越存越多
  keep[p.id] = day;
  lsSet(INSTALLED_KEY, JSON.stringify(keep));

  fetch(CONFIG.installLog, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: p.id }),
    keepalive: true,
  }).catch(() => {});

  // 本机先 +1，不用等下一次拉取
  for (const k of ["total", "week"]) state.stats[k][p.id] = (state.stats[k][p.id] || 0) + 1;
  changed(true);
}
