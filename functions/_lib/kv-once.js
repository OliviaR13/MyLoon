// KV 不提供原子比较并交换，不能安全地实现严格的一次性消费。
// 保留此辅助函数仅供非安全关键场景；任何存储异常都必须拒绝放行。
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
