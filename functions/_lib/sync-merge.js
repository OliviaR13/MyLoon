// 云端同步的服务端合并：和 box/js/account.js 里的客户端合并是同一套规则（逐项时间戳，较新者胜）。
// KV 没有「比较后写入」，两台设备的 PUT 交错时，后到的整份快照会盖掉先到的改动。
// 服务端合并之后，旧快照不再能覆盖更新的数据，两边的改动都会保留。

// 设置分三组，各有各的「最后修改时间」。键必须和 box/js/account.js 的 GROUPS 保持一致。
export const SETTING_GROUPS = {
  lookAt: ["theme", "reduceMotion"],
  cardsAt: ["showDesc", "showVer", "showCat", "compact", "pinFavs", "sort"],
  panelAt: ["fullDefault"],
};

// favMeta：{ id: [时间戳, 1 已收藏 / 0 已取消] }。逐条取时间戳较大的；相同时以新提交的（next）为准。
// 超过 cap 条时，先丢最旧的「已取消」记录，再丢最旧的其余记录。
export function mergeFavMeta(prev, next, now, ttl, cap) {
  const out = {};
  for (const id of new Set([...Object.keys(prev || {}), ...Object.keys(next || {})])) {
    const a = next?.[id];
    const b = prev?.[id];
    const pick = !a ? b : !b ? a : b[0] > a[0] ? b : a;
    if (pick[1] === 0 && now - pick[0] > ttl) continue;
    out[id] = [pick[0], pick[1]];
  }
  const ids = Object.keys(out);
  if (ids.length > cap) {
    ids.sort((x, y) => out[x][1] - out[y][1] || out[x][0] - out[y][0]); // 已取消在前，同类里旧的在前
    for (const id of ids.slice(0, ids.length - cap)) delete out[id];
  }
  return out;
}

// prev：云端已有的整份数据；next：clean() 之后的新提交。返回合并后的 settings 和各组时间。
// 每一组：新提交的时间 >= 云端的时间才采用新值，否则保留云端的；新提交没带这一组就整组保留云端的。
export function mergeSettings(prev, next) {
  const prevSettings = prev?.settings || {};
  const nextSettings = next?.settings || {};
  const prevAtAll = Number(prev?.settingsAt) || 0;
  const settings = { ...prevSettings, ...Object.fromEntries(Object.entries(nextSettings).filter(([k]) => !groupOf(k))) };
  const ats = {};
  for (const [at, keys] of Object.entries(SETTING_GROUPS)) {
    // 设置页偏好（panelAt）是后加的，旧数据没有它：没记录就按 0，不用统一时间戳顶替
    const prevAt = Number(prev?.[at] ?? (at === "panelAt" ? 0 : prevAtAll)) || 0;
    const hasValues = keys.some((k) => k in nextSettings);
    // 带了值却没带时间的老客户端：当作最旧，云端有更新的就不覆盖它
    const nextAt = Number.isFinite(next?.[at]) ? next[at] : hasValues ? 0 : null;
    if (nextAt !== null && nextAt >= prevAt) {
      for (const k of keys) {
        if (k in nextSettings) settings[k] = nextSettings[k];
        else if (k in prevSettings) settings[k] = prevSettings[k];
      }
      ats[at] = nextAt;
    } else {
      for (const k of keys) if (k in prevSettings) settings[k] = prevSettings[k];
      ats[at] = prevAt;
    }
  }
  return { settings, ...ats };
}

const groupOf = (k) => Object.keys(SETTING_GROUPS).find((g) => SETTING_GROUPS[g].includes(k));
