// KV 没有比较并交换。读到一次性令牌后先写 used:<id>，再读回来核对是不是自己写的。
// 两个请求交错时，后写的那个会盖掉标记，先读到自己标记的仍可能放行，所以这只是把窗口收窄。
// 有 D1 的 DELETE … RETURNING 才是原子的。标记写失败时照旧继续，避免把登录挡死。
export async function claimOnce(kv, id) {
  const used = "used:" + id;
  try {
    if (await kv.get(used)) return false;
    const marker = crypto.randomUUID();
    await kv.put(used, marker, { expirationTtl: 120 });
    return (await kv.get(used)) === marker;
  } catch {
    return true;
  }
}
