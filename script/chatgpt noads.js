// ChatGPT 去广告：递归删除响应 JSON 中疑似广告的节点
// 若有命中，会在 Loon 脚本日志里打印 URL，方便后续精确调整
const body = $response.body;

if (typeof body !== "string" || !/^\s*[\[{]/.test(body)) {
  $done({});
} else {
  try {
    let removed = 0;
    const adKey = k => /^(ads?|sponsored(_.*)?|ad_.*|.*_ads?)$/i.test(k);
    const isAd = n =>
      n && typeof n === "object" && !Array.isArray(n) &&
      (n.is_ad === true ||
        /^(ads?|sponsored)([_-]|$)/i.test(String(n.type || n.kind || n.content_type || "")));

    const clean = n => {
      if (Array.isArray(n)) {
        const kept = n.filter(x => !isAd(x));
        removed += n.length - kept.length;
        return kept.map(clean);
      }
      if (n && typeof n === "object") {
        for (const k of Object.keys(n)) {
          if (adKey(k) && n[k] != null && n[k] !== false) {
            delete n[k];
            removed++;
          } else {
            n[k] = clean(n[k]);
          }
        }
      }
      return n;
    };

    const obj = clean(JSON.parse(body));
    if (removed > 0) {
      console.log(`[ChatGPT去广告] removed ${removed} node(s) from ${$request.url}`);
      $done({ body: JSON.stringify(obj) });
    } else {
      $done({});
    }
  } catch (e) {
    $done({});
  }
}
