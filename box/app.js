/* OliviaR13's Loon Box — 前端应用主入口（ES Module）
   组装并初始化各功能模块，保持零构建依赖的原生 HTML/CSS/JS 架构：
   - js/config.js       全局配置、存储键名与 URL 构造
   - js/dom.js          DOM 工具、SVG 图标生成与通用交互动效
   - js/state.js        中心状态管理、插件数据标准化与搜索排序逻辑
   - js/toast.js        灵动岛提示条（Toast）组件
   - js/detail.js       插件详情全屏抽屉组件
   - js/render.js       插件列表、卡片构建、FLIP 重排与分类筛选渲染
   - js/search-sort.js  搜索框、变形排序菜单与吸顶栏控制
   - js/label-search.js 搜索框的浮动标签与缺口描边（Bencho Label input）
   - js/tour-splash.js  四步新手引导向导与启动页控制
   - js/step-player.js  引导的进度条：圆点 + 播放键（Bencho Step player）
   - js/seek-feel.js    搜索框的手感：靠近偏移、按下先让一下、打字时放大镜加粗（Bencho Search，不含展开收起）
   - js/watcher.js      会看着你的小方块：空状态和「关于」卡片（Bencho Eye tracker）
   - js/verify-cells.js 人机验证等待时的四个格子，通过后融合成胶囊（Bencho One-time code）
   - js/manifest.js     Cloudflare Turnstile 人机验证与清单加载
   - js/settings.js     设置面板：主题、卡片显示项、全屏与双列布局、恢复默认设置
   - js/account.js      GitHub 账号登录与收藏/偏好云端同步
   - js/pull.js         触屏下拉刷新 × 灵动岛动效 */

import { els } from "./js/dom.js";
import { initRender } from "./js/render.js";
import { initSearchAndSort } from "./js/search-sort.js";
import { initLabelSearch } from "./js/label-search.js";
import { initSeekFeel } from "./js/seek-feel.js";
import { createWatcher } from "./js/watcher.js";
import { initSettings } from "./js/settings.js";
import { initPullToRefresh } from "./js/pull.js";
import { initAccount } from "./js/account.js";
import { load } from "./js/manifest.js";

/* 每个初始化各自兜底：任何一个功能出错，只影响它自己，不会让后面的 load()（人机验证 + 清单）跟着不执行。
   之前正是一行 els.refresh.addEventListener 抛错，让整个页面停在「请完成人机验证…」。 */
const run = (name, fn) => {
  try { fn(); } catch (e) { console.error("[init:" + name + "]", e); }
};

run("render", initRender);
run("search", initSearchAndSort);
run("label-search", initLabelSearch);
run("seek-feel", () => initSeekFeel(els.searchBox, els.search));
/* 设置面板「关于」卡片右边的小方块：气泡朝左冒出，不会被卡片的圆角裁掉 */
run("watcher", () => {
  const aboutCard = document.querySelector(".about-card");
  if (aboutCard) createWatcher(aboutCard, { size: 52, say: "left" });
});
run("settings", initSettings);
run("pull", initPullToRefresh);
run("account", initAccount);

els.refresh?.addEventListener("click", () => load(true));
load();
