// 安装统计的公共部分：D1 建表、日期工具
// 需要 D1 绑定：MLB_DB（Pages 项目 → Settings → Bindings → D1 database）。没绑定时统计功能整体关闭，其余功能不受影响。

let ready = null;

// 第一次用到时自动建表（CREATE TABLE IF NOT EXISTS，重复执行无副作用）。失败时清掉缓存，下次请求再试
export function ensureSchema(DB) {
  if (!ready) {
    ready = DB.batch([
      DB.prepare("CREATE TABLE IF NOT EXISTS installs (id TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (id, day))"),
      DB.prepare("CREATE TABLE IF NOT EXISTS install_seen (h TEXT PRIMARY KEY, day TEXT NOT NULL)"),
      DB.prepare("CREATE INDEX IF NOT EXISTS install_seen_day ON install_seen (day)"),
    ]).catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

// UTC 日期 YYYY-MM-DD
export const today = (d = new Date()) => d.toISOString().slice(0, 10);
export const daysAgo = (n) => today(new Date(Date.now() - n * 864e5));
