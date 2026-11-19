// GET /api/account：当前账号已绑定的 GitHub、Google 和通行密钥。
import { getSessionOr503, json } from "../../_lib/auth.js";
import {
  ACCOUNT_STORE_MESSAGE,
  identitiesForClient,
  legacyIdentityFromSession,
  openAccountStore,
  sessionAccountId,
} from "../../_lib/accounts.js";
import { listCredentials } from "../../_lib/passkeys.js";

export async function onRequestGet({ request, env }) {
  const got = await getSessionOr503(request, env);
  if (got.response) return got.response;
  const user = got.user;
  if (!user) return json({ error: "unauthorized" }, 401);
  const accountId = sessionAccountId(user);
  const store = openAccountStore(env);
  let identities = [];
  try {
    if (store) {
      await store.ensureFromSession(user);
      identities = identitiesForClient(await store.list(accountId));
    } else {
      const legacy = legacyIdentityFromSession(user);
      identities = legacy ? identitiesForClient([legacy]) : [];
    }
  } catch {
    return json({ error: "storage_error" }, 500);
  }
  let passkeys = [];
  let passkeysEnabled = false;
  if (env.PASSKEYS) {
    passkeysEnabled = true;
    try {
      passkeys = await listCredentials(env.PASSKEYS, accountId);
    } catch {
      return json({ error: "storage_error" }, 500);
    }
  }
  return json({
    configured: !!store,
    accountId,
    identities,
    passkeys,
    passkeysEnabled,
    ...(store ? {} : { message: ACCOUNT_STORE_MESSAGE }),
  });
}
