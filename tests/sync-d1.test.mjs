// D1 同步存储的测试（含真正并发的请求）：node --test tests/sync-d1.test.mjs
// 用 node:sqlite 模拟 D1：单条语句 / 一次 batch 是原子的，每次访问数据库前都让出事件循环，
// 这样同时发出的请求会在每一步交错执行，和线上两台设备同时提交的情形一致。
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { onRequestPut, onRequestGet } from "../functions/api/me.js";
import { seal } from "../functions/_lib/auth.js";
import { resetSyncCache } from "../functions/_lib/sync-store.js";

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...p) { return new Stmt(this.db, this.sql, p); }
  exec() {
    const st = this.db.prepare(this.sql);
    return /^\s*SELECT/i.test(this.sql)
      ? { results: st.all(...this.params).map((r) => ({ ...r })) }
      : (st.run(...this.params), { results: [] });
  }
  async first() { await tick(); return this.exec().results[0] ?? null; }
  async all() { await tick(); return this.exec(); }
  async run() { await tick(); return this.exec(); }
}
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  return {
    prepare: (sql) => new Stmt(db, sql),
    async batch(stmts) {
      await tick();
      db.exec("BEGIN");
      try { const out = stmts.map((s) => s.exec()); db.exec("COMMIT"); return out; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    raw: db,
  };
}
const fakeKV = (seed = {}) => {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return { get: async (k) => { await tick(); return m.has(k) ? JSON.parse(m.get(k)) : null; }, put: async (k, v) => { await tick(); m.set(k, v); } };
};

const SECRET = "test-secret";
async function req(method, body, uid = 1) {
  const session = await seal({ id: uid, login: "u" + uid, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return new Request("https://box.example/api/me", {
    method,
    headers: { Origin: "https://box.example", Cookie: `mlb_session=${session}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const put = async (env, body, uid) => onRequestPut({ request: await req("PUT", body, uid), env });
const get = async (env, uid) => (await (await onRequestGet({ request: await req("GET", null, uid), env })).json()).data;
const newEnv = (extra = {}) => { resetSyncCache(); return { SESSION_SECRET: SECRET, MLB_DB: fakeD1(), ...extra }; };
const shuffle = (a) => a.map((x) => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);

test("D1：新用户 GET 返回 null，PUT 之后能读回完整数据", async () => {
  const env = newEnv();
  assert.equal(await get(env), null);
  const t = Date.now();
  const res = await put(env, { favMeta: { a: [t, 1] }, settings: { theme: "dark", showDesc: true }, lookAt: 5, cardsAt: 6 });
  assert.equal(res.status, 200);
  const d = await get(env);
  assert.deepEqual(d.favorites, ["a"]);
  assert.deepEqual(d.favMeta.a, [t, 1]);
  assert.equal(d.settings.theme, "dark");
  assert.equal(d.settings.showDesc, true);
  assert.equal(d.lookAt, 5);
  assert.equal(d.cardsAt, 6);
  assert.equal(d.panelAt, 0);
  assert.equal(d.settingsAt, 6);
});

test("并发：8 台设备同时各收藏一个不同的插件，一个都不丢", async () => {
  const env = newEnv();
  const t = Date.now();
  const ids = Array.from({ length: 8 }, (_, i) => "p" + i);
  await Promise.all(ids.map((id, i) => put(env, { favMeta: { [id]: [t + i, 1] } })));
  const d = await get(env);
  assert.deepEqual(d.favorites.sort(), [...ids].sort());
});

test("并发：同一个插件一台收藏一台取消，不管谁先到，较新的那次胜出（50 轮随机顺序）", async () => {
  for (let round = 0; round < 50; round++) {
    const env = newEnv();
    const t = Date.now();
    const jobs = [
      async () => { await sleep(Math.random() * 3); await put(env, { favMeta: { x: [t + 100, 1] } }); },
      async () => { await sleep(Math.random() * 3); await put(env, { favMeta: { x: [t + 200, 0] } }); },
      async () => { await sleep(Math.random() * 3); await put(env, { favMeta: { x: [t + 50, 1], y: [t + 10, 1] } }); },
    ];
    await Promise.all(shuffle(jobs).map((j) => j()));
    const d = await get(env);
    assert.deepEqual(d.favMeta.x, [t + 200, 0], `第 ${round} 轮`);
    assert.deepEqual(d.favorites, ["y"], `第 ${round} 轮`);
  }
});

test("并发：同一组设置，时间较新的那次胜出（50 轮随机顺序）", async () => {
  for (let round = 0; round < 50; round++) {
    const env = newEnv();
    const jobs = [
      async () => { await sleep(Math.random() * 3); await put(env, { favMeta: {}, settings: { theme: "light" }, lookAt: 1000 }); },
      async () => { await sleep(Math.random() * 3); await put(env, { favMeta: {}, settings: { theme: "dark" }, lookAt: 3000 }); },
      async () => { await sleep(Math.random() * 3); await put(env, { favMeta: {}, settings: { theme: "system" }, lookAt: 2000 }); },
    ];
    await Promise.all(shuffle(jobs).map((j) => j()));
    const d = await get(env);
    assert.equal(d.settings.theme, "dark", `第 ${round} 轮`);
    assert.equal(d.lookAt, 3000);
  }
});

test("并发：两台设备分别改外观组和卡片组，两边都保留", async () => {
  const env = newEnv();
  await Promise.all([
    put(env, { favMeta: {}, settings: { theme: "dark" }, lookAt: 10 }),
    put(env, { favMeta: {}, settings: { compact: true, sort: "name:asc" }, cardsAt: 20 }),
  ]);
  const d = await get(env);
  assert.equal(d.settings.theme, "dark");
  assert.equal(d.settings.compact, true);
  assert.equal(d.settings.sort, "name:asc");
});

test("组内只覆盖新提交里带了的键", async () => {
  const env = newEnv();
  await put(env, { favMeta: {}, settings: { showDesc: true, showVer: true }, cardsAt: 10 });
  await put(env, { favMeta: {}, settings: { showVer: false }, cardsAt: 20 });
  const d = await get(env);
  assert.equal(d.settings.showDesc, true);
  assert.equal(d.settings.showVer, false);
});

test("设置：没带的那一组不会被清掉", async () => {
  const env = newEnv();
  await put(env, { favMeta: {}, settings: { theme: "dark" }, lookAt: 10 });
  await put(env, { favMeta: { a: [Date.now(), 1] } }); // 只同步收藏
  const d = await get(env);
  assert.equal(d.settings.theme, "dark");
  assert.equal(d.lookAt, 10);
});

test("旧客户端：只有 favorites 时整份替换，列表里没有的记为取消；空列表不清空云端", async () => {
  const env = newEnv();
  await put(env, { favorites: ["a", "b"] });
  await put(env, { favorites: ["a"] });
  assert.deepEqual((await get(env)).favorites, ["a"]);
  await put(env, { favorites: [] });
  assert.deepEqual((await get(env)).favorites, ["a"]);
});

test("用户之间互不影响", async () => {
  const env = newEnv();
  const t = Date.now();
  await Promise.all([put(env, { favMeta: { a: [t, 1] } }, 1), put(env, { favMeta: { b: [t, 1] } }, 2)]);
  assert.deepEqual((await get(env, 1)).favorites, ["a"]);
  assert.deepEqual((await get(env, 2)).favorites, ["b"]);
});

test("上限：超过 400 条时先丢已取消的、最旧的；太旧的已取消记录直接清掉", async () => {
  const env = newEnv();
  const t = Date.now();
  const meta = {};
  for (let i = 0; i < 390; i++) meta["f" + i] = [t - i, 1];
  for (let i = 0; i < 20; i++) meta["d" + i] = [t - 1000 - i, 0];
  await put(env, { favMeta: meta });
  // clean() 每次最多收 400 条，剩下的分批提交
  await put(env, { favMeta: { extra: [t, 1], old: [t - 100 * 24 * 3600 * 1000, 0] } });
  const d = await get(env);
  assert.ok(Object.keys(d.favMeta).length <= 400);
  assert.equal(d.favorites.length, 391); // 391 个收藏一个不丢
  assert.equal("old" in d.favMeta, false);
});

test("迁移：KV 里的旧数据在第一次访问时搬进 D1", async () => {
  const kv = fakeKV({ "u:7": { favorites: ["legacy"], favMeta: { m: [500, 1], z: [600, 0] }, settings: { theme: "dark", showDesc: false }, settingsAt: 900, updatedAt: 1234 } });
  const env = newEnv({ MLB_KV: kv });
  const d = await get(env, 7);
  assert.deepEqual(d.favorites.sort(), ["legacy", "m"]);
  assert.deepEqual(d.favMeta.z, [600, 0]);
  assert.equal(d.settings.theme, "dark");
  assert.equal(d.lookAt, 900);   // 旧数据只有统一的 settingsAt：外观、卡片沿用
  assert.equal(d.cardsAt, 900);
  assert.equal(d.panelAt, 0);    // 设置页偏好是后加的，没有就是 0
  assert.equal(d.updatedAt, 1234);
});

test("迁移：迁移和新的 PUT 同时到达，两边的数据都在（20 轮）", async () => {
  for (let round = 0; round < 20; round++) {
    const kv = fakeKV({ "u:9": { favMeta: { old: [100, 1] }, settings: { theme: "light" }, lookAt: 100 } });
    const env = newEnv({ MLB_KV: kv });
    await Promise.all(shuffle([
      () => put(env, { favMeta: { fresh: [Date.now(), 1] }, settings: { theme: "dark" }, lookAt: 5000 }, 9),
      () => get(env, 9),
      () => put(env, { favMeta: { fresh2: [Date.now(), 1] } }, 9),
    ]).map((j) => j()));
    const d = await get(env, 9);
    assert.deepEqual(d.favorites.sort(), ["fresh", "fresh2", "old"], `第 ${round} 轮`);
    assert.equal(d.settings.theme, "dark", `第 ${round} 轮`); // 新的外观比迁移来的旧值新
  }
});

test("迁移：KV 里没有数据的新用户不报错，之后照常读写", async () => {
  const env = newEnv({ MLB_KV: fakeKV() });
  assert.equal(await get(env, 11), null);
  await put(env, { favMeta: { a: [Date.now(), 1] } }, 11);
  assert.deepEqual((await get(env, 11)).favorites, ["a"]);
});

test("存储出错时返回 500，不泄露细节", async () => {
  resetSyncCache();
  const broken = { prepare() { throw new Error("boom"); }, batch: async () => { throw new Error("boom"); } };
  const env = { SESSION_SECRET: SECRET, MLB_DB: broken };
  const res = await put(env, { favMeta: { a: [1, 1] } });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "storage_error" });
  resetSyncCache();
});
