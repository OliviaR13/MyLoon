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

-- ============================================================================
-- 云端同步（同一个 D1 数据库）。函数首次访问时同样会自动建表，这里仅供参考。
-- 每个收藏、每组设置各占一行，写入用「较新者胜」的 upsert，两台设备同时提交也不会互相覆盖。
-- ============================================================================

-- 收藏：一个插件一行。at 是最后修改时间（毫秒），fav：1 已收藏 / 0 已取消（取消记录保留 90 天）
CREATE TABLE IF NOT EXISTS user_favs (
  uid TEXT    NOT NULL,
  id  TEXT    NOT NULL,
  at  INTEGER NOT NULL,
  fav INTEGER NOT NULL,
  PRIMARY KEY (uid, id)
);

-- 设置：外观（lookAt）/ 插件卡片（cardsAt）/ 设置页偏好（panelAt）三组，各一行；val 是该组的 JSON
CREATE TABLE IF NOT EXISTS user_settings (
  uid TEXT    NOT NULL,
  grp TEXT    NOT NULL,
  at  INTEGER NOT NULL,
  val TEXT    NOT NULL,
  PRIMARY KEY (uid, grp)
);

-- 有这一行 = 该用户已处理过「从 KV 迁移」；updated_at 为空 = 还没有任何云端数据
CREATE TABLE IF NOT EXISTS user_meta (
  uid        TEXT PRIMARY KEY,
  updated_at INTEGER
);

-- ============================================================================
-- 账号与登录方式（同一个 D1）。函数第一次用到时会自动建表，这里供手动执行。
-- 不需要搬迁收藏和设置：老用户的账号 ID 就是原来的会话 ID。
-- ============================================================================

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- kind：github / google。subject：GitHub 数字 ID，或 Google 的 sub。一个账号每种方式只保留一条。
CREATE TABLE IF NOT EXISTS identities (
  kind       TEXT    NOT NULL,
  subject    TEXT    NOT NULL,
  account_id TEXT    NOT NULL,
  label      TEXT    NOT NULL DEFAULT '',
  name       TEXT    NOT NULL DEFAULT '',
  email      TEXT    NOT NULL DEFAULT '',
  picture    TEXT    NOT NULL DEFAULT '',
  linked_at  INTEGER NOT NULL,
  PRIMARY KEY (kind, subject)
);
CREATE UNIQUE INDEX IF NOT EXISTS identities_one_kind ON identities (account_id, kind);

-- 绑定冲突时的一次性确认，大约 5 分钟。确认或过期之后就没有用了。
CREATE TABLE IF NOT EXISTS pending_conflicts (
  jti              TEXT PRIMARY KEY,
  account_id       TEXT    NOT NULL,
  other_account_id TEXT    NOT NULL,
  kind             TEXT    NOT NULL,
  subject          TEXT    NOT NULL,
  label            TEXT    NOT NULL DEFAULT '',
  name             TEXT    NOT NULL DEFAULT '',
  email            TEXT    NOT NULL DEFAULT '',
  picture          TEXT    NOT NULL DEFAULT '',
  exp              INTEGER NOT NULL
);

-- 确认注销过的账号。旧会话 Cookie 碰到这里就失效，避免继续读到已删除的数据。
CREATE TABLE IF NOT EXISTS deleted_accounts (
  id         TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
