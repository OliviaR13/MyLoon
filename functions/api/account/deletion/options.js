// POST /api/account/deletion/options：有通行密钥时发一次性挑战；否则告诉页面要不要先重新登录。
import { getSessionOr503, json, sameOrigin } from "../../../_lib/auth.js";
import { sessionAccountId } from "../../../_lib/accounts.js";
import { reauthFresh } from "../../../_lib/account-deletion.js";
import { challengeCookie, listCredentials, newChallenge, saveChallenge } from "../../../_lib/passkeys.js";
import { rateLimit } from "../../../_lib/rate-limit.js";
import { deletionDbError } from "../../../_lib/deletion-http.js";
import { requestRp } from "../../../_lib/webauthn.js";

export async function onRequestPost({ request, env }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  const unavailable = deletionDbError(env);
  if (unavailable) return unavailable;
  const limited = await rateLimit(request, env, "account-delete");
  if (limited) return limited;
  const got = await getSessionOr503(request, env);
  if (got.response) return got.response;
  const user = got.user;
  const accountId = sessionAccountId(user);
  if (!accountId) return json({ error: "unauthorized" }, 401);
  const creds = env.PASSKEYS ? await listCredentials(env.PASSKEYS, accountId) : [];
  if (!creds.length) return json({ mode: "oauth", reauthFresh: reauthFresh(user) });
  const rp = requestRp(request);
  if (!rp) return json({ error: "rp_id" }, 400);
  const challenge = newChallenge();
  try {
    await saveChallenge(env, challenge, "deletion", { userId: accountId });
  } catch {
    return json({ error: "storage_error" }, 500);
  }
  return json({
    mode: "passkey",
    challenge,
    timeout: 60000,
    rpId: rp.rpId,
    userVerification: "required",
    allowCredentials: creds.map((row) => ({ type: "public-key", id: row.id })),
  }, 200, { "Set-Cookie": await challengeCookie(env, challenge, "deletion") });
}
