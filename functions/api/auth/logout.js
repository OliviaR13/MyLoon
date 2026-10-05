import { cookie, json, sameOrigin } from "../../_lib/auth.js";

export async function onRequestPost({ request }) {
  if (!sameOrigin(request)) return json({ error: "forbidden" }, 403);
  return json({ ok: true }, 200, {
    "Set-Cookie": cookie("mlb_session", "", { maxAge: 0, path: "/" }),
  });
}
