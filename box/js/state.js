/* 应用状态管理、插件数据标准化、多维排序与搜索匹配逻辑 */

import { CONFIG, FAV, SORT_KEY, FAV_KEY, FAV_META_KEY, LOGIN_HINT_KEY, DEFAULTS, safeIcon } from "./config.js";
import { lsGet, lsSet } from "./dom.js";

/* ---------- 排序与日期解析 ---------- */

export const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });

// 手动解析日期，不依赖 Date.parse（Safari 对 2026-9-5 这类非补零格式会返回无效）
export const dateValue = (p) => {
  if (p._ts === undefined) {
    const m = p.date.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    p._ts = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }
  return p._ts;
};

// 插件日期（#!date）在最近 CONFIG.recentDays 天内 → 「近期更新」
export const isRecent = (p) => {
  const age = Date.now() - dateValue(p);
  return age >= -864e5 && age <= CONFIG.recentDays * 864e5;
};

export const SORTS = {
  date: {
    label: "时间",
    defaultDir: "desc",
    hint: { desc: "新到旧", asc: "旧到新" },
    short: { desc: "最新", asc: "最早" },
    compare: (a, b) => dateValue(a) - dateValue(b),
  },
  name: {
    label: "名称",
    defaultDir: "asc",
    hint: { asc: "A 到 Z", desc: "Z 到 A" },
    short: { asc: "A-Z", desc: "Z-A" },
    compare: (a, b) => collator.compare(a.name, b.name),
  },
};

export const SORT_OPTIONS = Object.entries(SORTS).flatMap(([key, s]) =>
  ["desc", "asc"].sort((a) => (a === s.defaultDir ? -1 : 1)).map((dir) => ({ key, dir, label: `${s.label} · ${s.hint[dir]}` }))
);

export function readSort() {
  const [key, dir] = (lsGet(SORT_KEY) || "").split(":");
  if (SORTS[key] && (dir === "asc" || dir === "desc")) return { key, dir };
  return { key: "date", dir: SORTS.date.defaultDir };
}

/* ---------- 收藏与登录提示持久化 ---------- */

export function readFavs() {
  try {
    const a = JSON.parse(lsGet(FAV_KEY) || "[]");
    return new Set(Array.isArray(a) ? a.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function readFavMeta() {
  try {
    const o = JSON.parse(lsGet(FAV_META_KEY) || "{}");
    const out = {};
    for (const [id, v] of Object.entries(o || {})) {
      if (Array.isArray(v) && Number.isFinite(v[0]) && (v[1] === 0 || v[1] === 1)) out[id] = [v[0], v[1]];
    }
    return out;
  } catch {
    return {};
  }
}

export const loggedHint = () => lsGet(LOGIN_HINT_KEY) === "1";

/* ---------- 中心状态与设置接口桥接 ---------- */

export const state = {
  plugins: [],
  generatedAt: "",
  category: CONFIG.all,
  query: "",
  keywords: [],
  sort: readSort(),
  favorites: readFavs(),
  favMeta: readFavMeta(),
};

export const saveFavMeta = () => lsSet(FAV_META_KEY, JSON.stringify(state.favMeta));

export function saveFavs() {
  lsSet(FAV_KEY, JSON.stringify([...state.favorites]));
  document.dispatchEvent(new Event("favs:change"));
}

let settingsAPI = {
  get: () => ({ ...DEFAULTS }),
  set: () => {},
};

export function registerSettingsAPI(api) {
  settingsAPI = api;
  window.MLB_settings = api;
}

export const getSettings = () => settingsAPI.get();
export const setSettings = (next) => settingsAPI.set(next);

/* ---------- 文本拆分与插件数据标准化 ---------- */

/* 按语义拆分描述：在带圈序号（①②…）前、句末标点（。！？；）后断开，每段单独成行 */
export function splitDescription(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/([。！？；])(?=[^\s」』）)”’])/g, "$1\n")
    .replace(/\s*([①-⑳])/g, "\n$1")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalize(raw) {
  const category = String(raw.category || "其他");
  const tags = Array.isArray(raw.tags) ? raw.tags.map(String) : [];
  return {
    id: String(raw.id || raw.file),
    name: String(raw.name || raw.file || "未命名插件"),
    file: String(raw.file || ""),
    version: raw.version ? String(raw.version) : "",
    author: String(raw.author || ""),
    category,
    tags: tags.filter((t) => t && t !== category),
    allTags: [...new Set(tags.filter(Boolean))],
    icon: safeIcon(raw.icon || ""),
    description: String(raw.description || ""),
    date: raw.date ? String(raw.date).trim() : "",
    mitm: raw.mitm === true,
    script: raw.script === true,
    args: raw.args === true,
    rule: raw.rule === true,
    proxy: typeof raw.proxy === "boolean" ? raw.proxy : null,
  };
}

/* ---------- 搜索匹配与排序 ---------- */

export const termsHit = (terms, text) =>
  getSettings().searchMode === "or" ? terms.some((t) => text.includes(t)) : terms.every((t) => text.includes(t));

export const searchTerms = () => {
  const draft = state.query.trim().toLowerCase();
  return [...state.keywords.map((k) => k.toLowerCase()), ...(draft ? [draft] : [])];
};

export function matches(p, terms = searchTerms()) {
  if (state.category === FAV) {
    if (!state.favorites.has(p.id)) return false;
  } else if (state.category !== CONFIG.all && p.category !== state.category) {
    return false;
  }
  if (!terms.length) return true;
  const hay = (p.name + " " + p.description).toLowerCase();
  return termsHit(terms, hay);
}

/* 排序优先级：1. 名称命中优先 → 2. 收藏置顶 → 3. 所选排序方式与方向（同值按名称兜底） */
export function sortPlugins(list, terms = searchTerms()) {
  const { key, dir } = state.sort;
  const sign = dir === "asc" ? 1 : -1;
  const pin = !!getSettings().pinFavs;
  const nameHit = (p) => (terms.length && termsHit(terms, p.name.toLowerCase()) ? 0 : 1);
  const pinned = (p) => (pin && state.favorites.has(p.id) ? 0 : 1);
  return [...list].sort((a, b) => {
    const tier = nameHit(a) - nameHit(b) || pinned(a) - pinned(b);
    if (tier) return tier;
    if (key === "date") {
      const missA = Number.isNaN(dateValue(a)), missB = Number.isNaN(dateValue(b));
      if (missA !== missB) return missA ? 1 : -1;
    }
    const d = SORTS[key].compare(a, b);
    return (Number.isNaN(d) ? 0 : sign * d) || collator.compare(a.name, b.name);
  });
}
