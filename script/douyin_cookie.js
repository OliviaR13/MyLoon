/*
 * 抖音网页版 Cookie 抓取 (配合 DouYinSparkFlow 使用)
 * 在手机浏览器登录 https://www.douyin.com/chat 后自动保存 Cookie,
 * 仅保存在 Loon 本地 ($persistentStore),不会上传、不写进通知正文。
 */
const KEY = "dy_cookie";
const KEY_TIME = "dy_cookie_time";
const KEY_NOTIFY = "dy_cookie_notify";

(function () {
  try {
    const h = $request.headers || {};
    const ck = h["Cookie"] || h["cookie"] || "";
    // 没有 sessionid 说明没登录,忽略
    if (!/(^|;\s*)sessionid=/.test(ck)) return $done({});

    const old = $persistentStore.read(KEY) || "";
    const now = Date.now();
    const lastNotify = Number($persistentStore.read(KEY_NOTIFY) || 0);

    if (ck !== old) {
      $persistentStore.write(ck, KEY);
      $persistentStore.write(String(now), KEY_TIME);
      // 6 小时内不重复通知
      if (now - lastNotify > 6 * 3600 * 1000) {
        $persistentStore.write(String(now), KEY_NOTIFY);
        $notification.post(
          "抖音 Cookie 已更新",
          "已保存到 Loon 本地",
          "点击复制,粘贴到 GitHub 仓库 Secret",
          { clipboard: ck }
        );
      }
    }
  } catch (e) {
    console.log("douyin_cookie error: " + e);
  }
  $done({});
})();
