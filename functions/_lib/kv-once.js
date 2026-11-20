// KV 不提供原子比较并交换，不能安全地实现严格的一次性消费。
// 目前只用于账号冲突的待确认令牌（accounts.js），只能收窄并发窗口，不能完全消除；
// 存储异常一律拒绝放行。通行密钥挑战不再使用它。
export async function claimOnce(kv, id) {
  const used = "used:" + id;
  try {
    if (await kv.get(used)) return false;
    const marker = crypto.randomUUID();
    await kv.put(used, marker, { expirationTtl: 120 });
    return (await kv.get(used)) === marker;
  } catch {
    return false;
  }
}
