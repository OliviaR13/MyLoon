// 每小时清掉已到期的注销申请。Pages Functions 没有 Cron，所以这是一个独立 Worker。
// 不在本次变更里部署。绑定必须和 Pages 使用同一套 MLB_DB、MLB_KV、PASSKEYS。
import { missingPurgeBindings, purgeDueAccounts } from "../../functions/_lib/account-deletion.js";

async function run(env) {
  const missing = missingPurgeBindings(env);
  if (missing.length) {
    const message = "account_purge missing bindings: " + missing.join(",");
    console.error(message);
    throw new Error(message);
  }
  const purged = await purgeDueAccounts(env, Date.now());
  console.log("account_purge_done", purged);
  return purged;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};
