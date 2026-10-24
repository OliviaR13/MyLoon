-- 安装统计（Cloudflare D1，绑定名 MLB_DB）。
-- 函数首次访问时会自动执行下面的建表语句，这个文件只是留作参考，也可以手动在 D1 控制台里执行。

-- 每个插件每天的安装次数
CREATE TABLE IF NOT EXISTS installs (
  id  TEXT    NOT NULL,
  day TEXT    NOT NULL,            -- UTC 日期，YYYY-MM-DD
  n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, day)
);

-- 去重用：同一个 IP 同一天对同一个插件只计一次。存的是加盐哈希，不存 IP 本身，隔天清理
CREATE TABLE IF NOT EXISTS install_seen (
  h   TEXT PRIMARY KEY,
  day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS install_seen_day ON install_seen (day);
