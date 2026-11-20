# Account purge Worker

Pages Functions cannot run a cron. This Worker deletes accounts whose 14-day grace period has ended. The pull request does not deploy it and does not change Pages settings, secrets, or data.

## Deploy spec

| | |
| --- | --- |
| Worker name | `myloon-account-purge` |
| Script entry | `workers/account-purge/index.js` (`main = "index.js"` next to this file) |
| Compatibility date | `2026-11-20` |
| Compatibility flags | none |
| Cron | `15 * * * *` (every hour at minute 15) |
| Binding `MLB_DB` | existing Pages D1 database |
| Binding `MLB_KV` | existing Pages KV namespace |
| Binding `PASSKEYS` | existing Pages KV namespace |
| Secrets | none (`SESSION_SECRET` is not read) |

Replace the three placeholders in `wrangler.toml` with those existing ids. Do not create a new database or namespace.

```sh
npx wrangler deploy --config workers/account-purge/wrangler.toml
npx wrangler triggers list --config workers/account-purge/wrangler.toml
```

## Check after deploy

Local dry run, once the placeholders are real ids (or a non-production copy of the same schema):

```sh
npx wrangler dev --config workers/account-purge/wrangler.toml --test-scheduled
```

Wrangler prints a local URL for the scheduled handler. A finished run logs `account_purge_done` and the number of accounts purged. A missing binding logs `account_purge missing bindings: …` and the invocation fails. Those rows are not marked `completed`.

After the real deploy, watch one cron hour:

```sh
npx wrangler tail --config workers/account-purge/wrangler.toml
```

The same `account_purge_done` line is the success signal. Until this Worker is deployed, an expired account is still purged the next time that account signs in or opens the deletion status page.
