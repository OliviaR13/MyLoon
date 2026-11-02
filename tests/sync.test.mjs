// 云端同步合并的测试：node --test tests/sync.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mergeFavMeta, mergeSettings } from "../functions/_lib/sync-merge.js";
import { onRequestPut, onRequestGet } from "../functions/api/me.js";
import { seal } from "../functions/_lib/auth.js";

const DAY = 24 * 3600 * 1000;
const TTL = 90 * DAY;
const now = Date.now();

// ---------- 纯函数 ----------
test("favMeta：较新的取消不会被旧设备的收藏盖掉", () => {
  const out = mergeFavMeta({ a: [now - 1000, 0] }, { a: [now - 5000, 1] }, now, TTL, 400);
  assert.deepEqual(out.a, [now - 1000, 0]);
});

test("favMeta：两台设备各自的新收藏都保留", () => {
  const out = mergeFavMeta({ x: [now - 2000, 1] }, { y: [now - 1000, 1] }, now, TTL, 400);
  assert.deepEqual(Object.keys(out).sort(), ["x", "y"]);
});

test("favMeta：时间戳相同时以新提交的为准", () => {
  const out = mergeFavMeta({ a: [now, 1] }, { a: [now, 0] }, now, TTL, 400);
  assert.equal(out.a[1], 0);
});

test("favMeta：过期的取消记录被清掉，过期的收藏记录保留", () => {
  const old = now - TTL - DAY;
  const out = mergeFavMeta({ gone: [old, 0], kept: [old, 1] }, {}, now, TTL, 400);
  assert.equal("gone" in out, false);
  assert.equal("kept" in out, true);
});

test("favMeta：超出上限时先丢最旧的已取消记录", () => {
  const next = { fav1: [1000, 1], fav2: [2000, 1], dead1: [500, 0], dead2: [900, 0] };
  const out = mergeFavMeta({}, next, 3000, TTL, 3);
  assert.deepEqual(Object.keys(out).sort(), ["dead2", "fav1", "fav2"]);
});

test("设置：旧时间戳的那组不覆盖云端较新的值", () => {
  const prev = { settings: { theme: "dark", showDesc: true }, lookAt: 200, cardsAt: 100 };
  const next = { settings: { theme: "light", showDesc: false }, lookAt: 100, cardsAt: 300 };
  const m = mergeSettings(prev, next);
  assert.equal(m.settings.theme, "dark");   // look 组：云端 200 > 100，保留云端
  assert.equal(m.settings.showDesc, false); // cards 组：300 > 100，采用新值
  assert.equal(m.lookAt, 200);
  assert.equal(m.cardsAt, 300);
});

test("设置：没带的那一组保留云端原值和时间", () => {
  const prev = { settings: { theme: "dark", compact: true }, lookAt: 50, cardsAt: 60, panelAt: 70 };
  const next = { settings: { theme: "light" }, lookAt: 80, cardsAt: null, panelAt: null };
  const m = mergeSettings(prev, next);
  assert.equal(m.settings.theme, "light");
  assert.equal(m.settings.compact, true);
  assert.equal(m.cardsAt, 60);
  assert.equal(m.panelAt, 70);
});

test("设置：没有组时间戳的老客户端算最旧，不覆盖较新的云端数据", () => {
  const prev = { settings: { theme: "dark" }, lookAt: 500 };
  const m = mergeSettings(prev, { settings: { theme: "light" } });
  assert.equal(m.settings.theme, "dark");
});

test("设置：云端什么都没有时，老客户端的设置照常写入", () => {
  const m = mergeSettings(null, { settings: { theme: "light" } });
  assert.equal(m.settings.theme, "light");
});

// ---------- PUT /api/me：用假 KV 模拟两台设备交错提交 ----------
const SECRET = "test-secret";
async function req(method, body) {
  const session = await seal({ id: 42, login: "tester", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  return new Request("https://box.example/api/me", {
    method,
    headers: { Origin: "https://box.example", Cookie: `mlb_session=${session}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const fakeKV = () => {
  const m = new Map();
  return { get: async (k) => (m.has(k) ? JSON.parse(m.get(k)) : null), put: async (k, v) => void m.set(k, v) };
};

test("PUT：设备 B 的旧快照不会抹掉设备 A 刚做的收藏和取消", async () => {
  const env = { SESSION_SECRET: SECRET, MLB_KV: fakeKV() };
  const t = Date.now();
  // A：收藏 x，取消 y（y 之前在云端是收藏）
  await onRequestPut({ request: await req("PUT", { favMeta: { y: [t - 9000, 1] } }), env });
  await onRequestPut({ request: await req("PUT", { favMeta: { x: [t - 1000, 1], y: [t - 1000, 0] } }), env });
  // B：还不知道 A 的改动，带着旧的 y 收藏和自己新收藏的 z 提交
  await onRequestPut({ request: await req("PUT", { favMeta: { y: [t - 9000, 1], z: [t - 500, 1] } }), env });
  const { data } = await (await onRequestGet({ request: await req("GET"), env })).json();
  assert.deepEqual(data.favorites.sort(), ["x", "z"]);
  assert.deepEqual(data.favMeta.y, [t - 1000, 0]);
});

test("PUT：旧设备的外观设置不会盖掉新设备的", async () => {
  const env = { SESSION_SECRET: SECRET, MLB_KV: fakeKV() };
  await onRequestPut({ request: await req("PUT", { favMeta: {}, settings: { theme: "dark" }, lookAt: 2000 }), env });
  await onRequestPut({ request: await req("PUT", { favMeta: {}, settings: { theme: "light" }, lookAt: 1000 }), env });
  const { data } = await (await onRequestGet({ request: await req("GET"), env })).json();
  assert.equal(data.settings.theme, "dark");
  assert.equal(data.lookAt, 2000);
});

test("PUT：旧客户端（只有 favorites）仍能取消收藏", async () => {
  const env = { SESSION_SECRET: SECRET, MLB_KV: fakeKV() };
  await onRequestPut({ request: await req("PUT", { favorites: ["a", "b"] }), env });
  await onRequestPut({ request: await req("PUT", { favorites: ["a"] }), env });
  const { data } = await (await onRequestGet({ request: await req("GET"), env })).json();
  assert.deepEqual(data.favorites, ["a"]);
});
