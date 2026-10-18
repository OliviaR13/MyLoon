/* 全局配置、存储键名常量与 URL 构造函数 */

export const CONFIG = {
  manifest: "api/manifest",        // 服务端校验令牌后返回清单（Pages Function）
  staticManifest: "manifest.json", // 不启用人机验证时直接读取的静态清单
  rawBase: "https://raw.githubusercontent.com/OliviaR13/MyLoon/main/",
  sourceBase: "https://github.com/OliviaR13/MyLoon/blob/main/", // 详情面板「查看源码」的前缀
  recentDays: 7,                                              // 日期在这个天数以内的插件显示「近期更新」
  all: "全部",
  turnstile: {
    siteKey: "0x4AAAAAAFM6TQJfkewCeO_g", // 留空则不启用人机验证
    action: "load_manifest",             // 需与 functions/api/manifest.js 中的 ACTION 一致
    loadTimeout: 8000,                   // 验证组件加载超时
    totalTimeout: 30000,                 // 无需交互时，整个验证的总时限
    interactiveTimeout: 90000,           // 需要用户点击时，给更长的时限
  },
};

export const FAV = "收藏";
export const SORT_KEY = "myloon_box_sort";
export const FAV_KEY = "myloon_box_favs";
export const FAV_META_KEY = "myloon_box_favs_meta";
export const LOGIN_HINT_KEY = "myloon_box_login";

export const SETTINGS_KEY = "myloon_box_settings";
export const COLS_KEY = "myloon_box_full_cols";
export const SPLASH_KEY = "myloon_box_splash";
export const TOUR_KEY = "myloon_onboarding_completed";

export const VERIFIED_KEY = "myloon_box_verified_at";
export const VERIFIED_TTL = 25 * 60 * 1000; // 比服务端的 30 分钟略短，避免临界时请求失败

export const SYNC_KEYS = {
  master: "myloon_box_sync",
  look: "myloon_box_sync_look",
  cards: "myloon_box_sync_cards",
};
export const LEGACY_AT = "myloon_box_settings_at";
export const TOMBSTONE_TTL = 90 * 24 * 3600 * 1000;

export const DEFAULTS = {
  theme: "system",
  showDesc: true,
  showVer: true,
  showCat: true,
  pinFavs: false,
  compact: false,
  reduceMotion: false,
};
export const BOOL_KEYS = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === "boolean");

export function safeIcon(value) {
  try {
    const u = new URL(value, document.baseURI);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    return "";
  }
}

export const rawUrl = (p) => CONFIG.rawBase + p.file.replace(/^\/+/, "");
export const installUrl = (p) => "loon://import?plugin=" + encodeURIComponent(rawUrl(p));
export const sourceUrl = (p) => CONFIG.sourceBase + p.file.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
