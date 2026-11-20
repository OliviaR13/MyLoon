// 每小时清掉已到期的注销申请。Pages Functions 没有 Cron，所以这是一个独立 Worker。
// 不在本次变更里部署。绑定必须和 Pages 使用同一套 MLB_DB、MLB_KV、PASSKEYS。
import { purgeDueAccounts } from "../../functions/_lib/account-deletion.js";

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purgeDueAccounts(env, Date.now()));
  },
};
