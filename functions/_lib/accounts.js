// 一个账号可以绑定多种登录方式。同步数据仍按账号 ID 存放，不搬迁。
//
// 老用户的账号 ID 就是原来的会话 ID：GitHub 用数字 ID 的字符串，Google 用 "google:<sub>"。
// 第一次登录时如果还没有账号行，就用这个老 ID 建账号，收藏和设置还在原来的键上。
// 解绑之后再用同一种方式登录，会另开一个新账号，不会悄悄并回去。
//
// 存储优先用已有的 D1（MLB_DB）。没绑 D1 时退回已有的 KV（MLB_KV）。两个都没有时，
// 登录仍按老的会话 ID 工作，只是不能绑定或解绑。
import { SESSION_TTL, getCookie, seal, unseal } from "./auth.js";
import { isAccountDeleted, markAccountDeleted } from "./account-tomb.js";

const KINDS = new Set(["github", "google"]);
const CONFLICT_TTL = 300;

export function legacyAccountId(kind, subject) {
  if (kind === "github") return String(subject);
  if (kind === "google") return "google:" + subject;
  return "";
}

export function sessionAccountId(user) {
  if (!user || user.id == null) return "";
  return String(user.id);
}

function clean(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "";
}

export function githubProfile(user) {
  const subject = String(user?.id ?? "");
  const label = clean(user?.login, 80);
  if (!/^\d{1,20}$/.test(subject) || !label) return null;
  return { kind: "github", subject, label, name: "", email: "", picture: "" };
}

export function googleProfile(profile) {
  const subject = String(profile?.sub || "");
  const email = clean(profile?.email, 254).toLowerCase();
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(subject) || !email) return null;
  return {
    kind: "google",
    subject,
    label: email,
    name: clean(profile?.name, 80),
    email,
    picture: clean(profile?.picture, 500),
  };
}

// 只有「会话 ID 本身就是这种登录方式的老 ID」时，才把它补写成一条身份。
// 用绑定上来的另一种方式登录时，会话 ID 是账号 ID，不能据此再造一条身份。
export function legacyIdentityFromSession(user) {
  const id = sessionAccountId(user);
  if (!id) return null;
  if ((user.provider === "google" || id.startsWith("google:")) && id.startsWith("google:")) {
    return googleProfile({
      sub: id.slice("google:".length),
      email: user.email || "",
      name: user.name || user.login || "",
      picture: user.picture || "",
    });
  }
  if (user.provider !== "google" && /^\d+$/.test(id)) return githubProfile({ id, login: user.login });
  return null;
}

export function sessionPayload(accountId, profile) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const id = /^\d+$/.test(String(accountId)) ? Number(accountId) : accountId;
  if (profile.kind === "google") {
    const name = profile.name || profile.email.split("@")[0] || "Google 用户";
    return { id, login: name, name, email: profile.email, picture: profile.picture || "", provider: "google", exp };
  }
  return { id, login: profile.label, exp };
}

export async function sealLinkIntent(accountId, secret) {
  return seal({ intent: "link", accountId: String(accountId), exp: Math.floor(Date.now() / 1000) + 600 }, secret, "link");
}

// present 表示浏览器带了绑定用的 Cookie。带了但验签失败时不能退回去当普通登录。
export async function readLinkIntent(request, env) {
  const raw = getCookie(request, "mlb_link");
  if (!raw) return { present: false, valid: false };
  const data = env?.SESSION_SECRET ? await unseal(raw, env.SESSION_SECRET, "link") : null;
  if (!data || data.intent !== "link" || typeof data.accountId !== "string" || !data.accountId) {
    return { present: true, valid: false };
  }
  return { present: true, valid: true, accountId: data.accountId };
}

function newAccountId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return "a:" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function publicIdentity(row) {
  if (row.kind === "github") return { kind: "github", login: row.label || "" };
  return { kind: "google", email: row.email || row.label || "", name: row.name || "" };
}

function httpError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

export function openAccountStore(env) {
  if (env?.MLB_DB) return d1Store(env.MLB_DB);
  if (env?.MLB_KV) return kvStore(env.MLB_KV);
  return null;
}

const schemaReady = new WeakMap();

function ensureSchema(DB) {
  let pending = schemaReady.get(DB);
  if (!pending) {
    pending = DB.batch([
      DB.prepare("CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)"),
      DB.prepare(`CREATE TABLE IF NOT EXISTS identities (
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        account_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        picture TEXT NOT NULL DEFAULT '',
        linked_at INTEGER NOT NULL,
        PRIMARY KEY (kind, subject)
      )`),
      DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS identities_one_kind ON identities (account_id, kind)"),
      DB.prepare(`CREATE TABLE IF NOT EXISTS pending_conflicts (
        jti TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        other_account_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        picture TEXT NOT NULL DEFAULT '',
        exp INTEGER NOT NULL
      )`),
    ]).catch((err) => {
      schemaReady.delete(DB);
      throw err;
    });
    schemaReady.set(DB, pending);
  }
  return pending;
}

function d1Store(DB) {
  const rowToIdentity = (row) => row && ({
    kind: row.kind,
    subject: row.subject,
    accountId: row.account_id,
    label: row.label || "",
    name: row.name || "",
    email: row.email || "",
    picture: row.picture || "",
    linkedAt: row.linked_at || 0,
  });

  return {
    async find(kind, subject) {
      await ensureSchema(DB);
      const row = await DB.prepare(
        "SELECT kind, subject, account_id, label, name, email, picture, linked_at FROM identities WHERE kind = ?1 AND subject = ?2",
      ).bind(kind, subject).first();
      return rowToIdentity(row);
    },
    async list(accountId) {
      await ensureSchema(DB);
      const out = await DB.prepare(
        "SELECT kind, subject, account_id, label, name, email, picture, linked_at FROM identities WHERE account_id = ?1 ORDER BY kind",
      ).bind(accountId).all();
      return (out.results || []).map(rowToIdentity);
    },
    async getAccount(accountId) {
      await ensureSchema(DB);
      const row = await DB.prepare("SELECT id, created_at FROM accounts WHERE id = ?1").bind(accountId).first();
      return row ? { id: row.id, createdAt: row.created_at } : null;
    },
    async adoptLogin(profile, blocked = new Set()) {
      const found = await this.find(profile.kind, profile.subject);
      if (found) {
        await updateIdentity(DB, found.accountId, profile);
        return found.accountId;
      }
      const legacyId = legacyAccountId(profile.kind, profile.subject);
      const legacy = await this.getAccount(legacyId);
      const accountId = legacy || blocked.has(legacyId) ? newAccountId() : legacyId;
      return insertIdentity(DB, accountId, profile);
    },
    async ensureFromSession(user) {
      const accountId = sessionAccountId(user);
      if (!accountId) return "";
      if (await this.getAccount(accountId)) return accountId;
      const legacy = legacyIdentityFromSession(user);
      if (!legacy) return accountId;
      const found = await this.find(legacy.kind, legacy.subject);
      if (found) return accountId;
      return insertIdentity(DB, accountId, legacy);
    },
    async link(accountId, profile) {
      const found = await this.find(profile.kind, profile.subject);
      if (found && found.accountId !== accountId) throw conflictError(found.accountId);
      if (found) {
        await updateIdentity(DB, accountId, profile);
        return;
      }
      const current = await this.list(accountId);
      if (current.some((row) => row.kind === profile.kind)) throw httpError("already_linked");
      try {
        const landed = await insertIdentity(DB, accountId, profile);
        if (landed !== accountId) throw conflictError(landed);
      } catch (err) {
        if (err.code) throw err;
        if (/UNIQUE/i.test(String(err.message || err))) throw httpError("already_linked");
        throw err;
      }
    },
    async unlink(accountId, kind, extraMethods) {
      if (!KINDS.has(kind)) throw httpError("not_linked");
      const rows = await this.list(accountId);
      const target = rows.find((row) => row.kind === kind);
      if (!target) throw httpError("not_linked");
      if (rows.length - 1 + extraMethods < 1) throw httpError("last_method");
      await ensureSchema(DB);
      await DB.prepare("DELETE FROM identities WHERE kind = ?1 AND subject = ?2 AND account_id = ?3")
        .bind(kind, target.subject, accountId).run();
    },
    async savePending(record) {
      await ensureSchema(DB);
      const jti = crypto.randomUUID();
      const exp = Math.floor(Date.now() / 1000) + CONFLICT_TTL;
      await DB.prepare(
        `INSERT INTO pending_conflicts (jti, account_id, other_account_id, kind, subject, label, name, email, picture, exp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(jti, record.accountId, record.otherAccountId, record.kind, record.subject, record.label, record.name, record.email, record.picture, exp).run();
      return { jti, exp };
    },
    async takePending(jti) {
      await ensureSchema(DB);
      const out = await DB.prepare(
        `DELETE FROM pending_conflicts WHERE jti = ?1
         RETURNING account_id, other_account_id, kind, subject, label, name, email, picture, exp`,
      ).bind(jti).all();
      const row = out.results?.[0];
      if (!row || row.exp < Math.floor(Date.now() / 1000)) return null;
      return {
        accountId: row.account_id,
        otherAccountId: row.other_account_id,
        kind: row.kind,
        subject: row.subject,
        label: row.label || "",
        name: row.name || "",
        email: row.email || "",
        picture: row.picture || "",
        exp: row.exp,
      };
    },
    async moveIdentity(accountId, otherAccountId, profile) {
      await ensureSchema(DB);
      await DB.prepare(
        `UPDATE identities SET account_id = ?1, label = ?2, name = ?3, email = ?4, picture = ?5
         WHERE kind = ?6 AND subject = ?7 AND account_id = ?8`,
      ).bind(accountId, profile.label, profile.name, profile.email, profile.picture, profile.kind, profile.subject, otherAccountId).run();
      const row = await DB.prepare("SELECT account_id FROM identities WHERE kind = ?1 AND subject = ?2")
        .bind(profile.kind, profile.subject).first();
      return row?.account_id === accountId;
    },
    async dropIdentity(kind, subject, accountId) {
      await ensureSchema(DB);
      await DB.prepare("DELETE FROM identities WHERE kind = ?1 AND subject = ?2 AND account_id = ?3")
        .bind(kind, subject, accountId).run();
    },
    async dropAccount(accountId) {
      await ensureSchema(DB);
      await DB.prepare("DELETE FROM accounts WHERE id = ?1").bind(accountId).run();
    },
  };
}

function conflictError(otherAccountId) {
  const err = httpError("conflict");
  err.otherAccountId = otherAccountId || "";
  return err;
}

async function updateIdentity(DB, accountId, profile) {
  await ensureSchema(DB);
  await DB.prepare(
    `UPDATE identities SET label = ?1, name = ?2, email = ?3, picture = ?4
     WHERE kind = ?5 AND subject = ?6 AND account_id = ?7`,
  ).bind(profile.label, profile.name, profile.email, profile.picture, profile.kind, profile.subject, accountId).run();
}

async function insertIdentity(DB, accountId, profile) {
  await ensureSchema(DB);
  const now = Date.now();
  await DB.batch([
    DB.prepare("INSERT OR IGNORE INTO accounts (id, created_at) VALUES (?1, ?2)").bind(accountId, now),
    DB.prepare(
      `INSERT INTO identities (kind, subject, account_id, label, name, email, picture, linked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(kind, subject) DO NOTHING`,
    ).bind(profile.kind, profile.subject, accountId, profile.label, profile.name, profile.email, profile.picture, now),
  ]);
  const row = await DB.prepare("SELECT account_id FROM identities WHERE kind = ?1 AND subject = ?2")
    .bind(profile.kind, profile.subject).first();
  if (row?.account_id !== accountId) {
    await DB.prepare("DELETE FROM accounts WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM identities WHERE account_id = ?1)")
      .bind(accountId).run();
  }
  return row?.account_id || accountId;
}

function kvStore(KV) {
  const pointerKey = (kind, subject) => `acct:id:${kind}:${subject}`;
  const accountKey = (accountId) => `acct:${accountId}`;

  const read = async (key) => {
    const raw = await KV.get(key);
    if (raw == null || raw === "") return null;
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const write = (key, value) => KV.put(key, JSON.stringify(value));

  const load = async (accountId) => {
    const data = await read(accountKey(accountId));
    if (!data || typeof data !== "object") return null;
    const identities = data.identities && typeof data.identities === "object" ? data.identities : {};
    return { id: accountId, createdAt: data.createdAt || 0, identities };
  };

  const identityOf = (kind, subject, accountId, profile, linkedAt) => ({
    kind,
    subject,
    accountId,
    label: profile.label || "",
    name: profile.name || "",
    email: profile.email || "",
    picture: profile.picture || "",
    linkedAt: linkedAt || 0,
  });

  return {
    async find(kind, subject) {
      const accountId = await read(pointerKey(kind, subject));
      if (typeof accountId !== "string" || !accountId) return null;
      const account = await load(accountId);
      const profile = account?.identities?.[kind];
      if (!profile || profile.subject !== subject) return null;
      return identityOf(kind, subject, accountId, profile, profile.linkedAt);
    },
    async list(accountId) {
      const account = await load(accountId);
      if (!account) return [];
      return ["github", "google"].filter((kind) => account.identities[kind]).map((kind) => {
        const profile = account.identities[kind];
        return identityOf(kind, profile.subject, accountId, profile, profile.linkedAt);
      });
    },
    async getAccount(accountId) {
      const account = await load(accountId);
      return account ? { id: account.id, createdAt: account.createdAt } : null;
    },
    async adoptLogin(profile, blocked = new Set()) {
      const found = await this.find(profile.kind, profile.subject);
      if (found) {
        await this.link(found.accountId, profile);
        return found.accountId;
      }
      const legacyId = legacyAccountId(profile.kind, profile.subject);
      const legacy = await this.getAccount(legacyId);
      const accountId = legacy || blocked.has(legacyId) ? newAccountId() : legacyId;
      await this.link(accountId, profile);
      const again = await this.find(profile.kind, profile.subject);
      return again?.accountId || accountId;
    },
    async ensureFromSession(user) {
      const accountId = sessionAccountId(user);
      if (!accountId) return "";
      if (await this.getAccount(accountId)) return accountId;
      const legacy = legacyIdentityFromSession(user);
      if (!legacy) return accountId;
      const found = await this.find(legacy.kind, legacy.subject);
      if (found) return accountId;
      await this.link(accountId, legacy);
      return accountId;
    },
    async link(accountId, profile) {
      const found = await this.find(profile.kind, profile.subject);
      if (found && found.accountId !== accountId) throw conflictError(found.accountId);
      const account = await load(accountId) || { id: accountId, createdAt: Date.now(), identities: {} };
      const current = account.identities[profile.kind];
      if (!found && current && current.subject !== profile.subject) throw httpError("already_linked");
      account.identities[profile.kind] = {
        subject: profile.subject,
        label: profile.label,
        name: profile.name,
        email: profile.email,
        picture: profile.picture,
        linkedAt: current?.linkedAt || Date.now(),
      };
      await write(accountKey(accountId), account);
      await write(pointerKey(profile.kind, profile.subject), accountId);
    },
    async unlink(accountId, kind, extraMethods) {
      if (!KINDS.has(kind)) throw httpError("not_linked");
      const rows = await this.list(accountId);
      const target = rows.find((row) => row.kind === kind);
      if (!target) throw httpError("not_linked");
      if (rows.length - 1 + extraMethods < 1) throw httpError("last_method");
      const account = await load(accountId);
      delete account.identities[kind];
      await write(accountKey(accountId), account);
      const pointer = await read(pointerKey(kind, target.subject));
      if (pointer === accountId && KV.delete) await KV.delete(pointerKey(kind, target.subject));
    },
    async savePending(record) {
      const jti = crypto.randomUUID();
      const exp = Math.floor(Date.now() / 1000) + CONFLICT_TTL;
      await KV.put("pend:" + jti, JSON.stringify({ ...record, exp }), { expirationTtl: CONFLICT_TTL });
      return { jti, exp };
    },
    async takePending(jti) {
      const key = "pend:" + jti;
      const row = await read(key);
      if (KV.delete) await KV.delete(key);
      if (!row || row.exp < Math.floor(Date.now() / 1000)) return null;
      return row;
    },
    async moveIdentity(accountId, otherAccountId, profile) {
      const pointer = await read(pointerKey(profile.kind, profile.subject));
      if (pointer !== otherAccountId) return false;
      const other = await load(otherAccountId);
      if (other?.identities?.[profile.kind]) {
        delete other.identities[profile.kind];
        await write(accountKey(otherAccountId), other);
      }
      const account = await load(accountId) || { id: accountId, createdAt: Date.now(), identities: {} };
      account.identities[profile.kind] = {
        subject: profile.subject,
        label: profile.label,
        name: profile.name,
        email: profile.email,
        picture: profile.picture,
        linkedAt: Date.now(),
      };
      await write(accountKey(accountId), account);
      await write(pointerKey(profile.kind, profile.subject), accountId);
      return true;
    },
    async dropIdentity(kind, subject, accountId) {
      const account = await load(accountId);
      if (account?.identities?.[kind]?.subject === subject) {
        delete account.identities[kind];
        await write(accountKey(accountId), account);
      }
      const pointer = await read(pointerKey(kind, subject));
      if (pointer === accountId && KV.delete) await KV.delete(pointerKey(kind, subject));
    },
    async dropAccount(accountId) {
      if (KV.delete) await KV.delete(accountKey(accountId));
    },
  };
}

export function identitiesForClient(rows) {
  return rows.map(publicIdentity);
}

export async function loginAccount(env, profile) {
  const store = openAccountStore(env);
  if (!store) return legacyAccountId(profile.kind, profile.subject);
  const blocked = new Set();
  const legacyId = legacyAccountId(profile.kind, profile.subject);
  if (legacyId && await isAccountDeleted(env, legacyId)) blocked.add(legacyId);
  return store.adoptLogin(profile, blocked);
}

export async function issueConflictToken(env, user, profile) {
  const store = openAccountStore(env);
  if (!store || !env?.SESSION_SECRET) return "";
  const accountId = sessionAccountId(user);
  const found = await store.find(profile.kind, profile.subject);
  if (!accountId || !found || found.accountId === accountId) return "";
  return stageConflictToken(env, accountId, found.accountId, profile);
}

export async function stageConflictToken(env, accountId, otherAccountId, profile) {
  const store = openAccountStore(env);
  if (!store || !env?.SESSION_SECRET) return "";
  const saved = await store.savePending({
    accountId,
    otherAccountId,
    kind: profile.kind,
    subject: profile.subject,
    label: profile.label,
    name: profile.name,
    email: profile.email,
    picture: profile.picture,
  });
  return seal({
    typ: "conflict",
    jti: saved.jti,
    accountId,
    otherAccountId,
    kind: profile.kind,
    subject: profile.subject,
    exp: saved.exp,
  }, env.SESSION_SECRET, "conflict");
}

export async function conflictMarker(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token || "")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function confirmConflict(env, user, token, marker = "") {
  if (!env?.SESSION_SECRET) throw httpError("pending");
  const data = await unseal(token, env.SESSION_SECRET, "conflict");
  if (!marker || marker !== await conflictMarker(token)) throw httpError("pending");
  if (!data || data.typ !== "conflict" || typeof data.jti !== "string") throw httpError("pending");
  const accountId = sessionAccountId(user);
  if (!accountId || data.accountId !== accountId) throw httpError("pending");
  const store = openAccountStore(env);
  if (!store) throw httpError("pending");
  const pending = await store.takePending(data.jti);
  if (!pending || pending.accountId !== data.accountId || pending.otherAccountId !== data.otherAccountId || pending.kind !== data.kind || pending.subject !== data.subject) {
    throw httpError("pending");
  }
  if (pending.otherAccountId === accountId) return;
  const mine = await store.list(accountId);
  if (mine.some((row) => row.kind === pending.kind && row.subject !== pending.subject)) throw httpError("already_linked");
  const profile = {
    kind: pending.kind,
    subject: pending.subject,
    label: pending.label,
    name: pending.name,
    email: pending.email,
    picture: pending.picture,
  };
  const moved = await store.moveIdentity(accountId, pending.otherAccountId, profile);
  if (!moved) throw httpError("pending");
  await markAccountDeleted(env, pending.otherAccountId);
  const rest = await store.list(pending.otherAccountId);
  for (const row of rest) await store.dropIdentity(row.kind, row.subject, pending.otherAccountId);
  await store.dropAccount(pending.otherAccountId);
  await deleteSyncedData(env, pending.otherAccountId);
  await deleteAccountPasskeys(env, pending.otherAccountId);
}

async function deleteSyncedData(env, accountId) {
  if (env?.MLB_DB) {
    const DB = env.MLB_DB;
    try {
      await DB.batch([
        DB.prepare("DELETE FROM user_favs WHERE uid = ?1").bind(accountId),
        DB.prepare("DELETE FROM user_settings WHERE uid = ?1").bind(accountId),
        DB.prepare("DELETE FROM user_meta WHERE uid = ?1").bind(accountId),
      ]);
    } catch {
      /* 这个账号可能还没有同步过 */
    }
  }
  if (env?.MLB_KV?.delete) {
    await env.MLB_KV.delete("u:" + accountId);
    await env.MLB_KV.delete("acct:" + accountId);
  }
}

async function deleteAccountPasskeys(env, accountId) {
  if (!env?.PASSKEYS) return;
  const { listCredentials, deleteCredential } = await import("./passkeys.js");
  const list = await listCredentials(env.PASSKEYS, accountId);
  for (const cred of list) await deleteCredential(env.PASSKEYS, accountId, cred.id);
}

export async function linkAccount(env, user, profile) {
  const store = openAccountStore(env);
  if (!store) throw httpError("accounts_not_configured");
  const accountId = sessionAccountId(user);
  if (!accountId) throw httpError("link_state");
  await store.ensureFromSession(user);
  await store.link(accountId, profile);
}

export async function assertPasskeyRemovable(env, user) {
  const store = openAccountStore(env);
  if (!store) return;
  await store.ensureFromSession(user);
  const identities = await store.list(sessionAccountId(user));
  const passkeys = await passkeyCount(env, sessionAccountId(user));
  if (identities.length + passkeys <= 1) throw httpError("last_method");
}

export async function passkeyCount(env, accountId) {
  if (!env?.PASSKEYS) return 0;
  const { listCredentials } = await import("./passkeys.js");
  const list = await listCredentials(env.PASSKEYS, accountId);
  return list.length;
}

export const ACCOUNT_STORE_MESSAGE = "需要绑定 D1（MLB_DB）或 KV（MLB_KV）才能管理登录方式";
