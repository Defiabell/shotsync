import { Env, err, json } from "../responses";
import { isAuthed } from "../auth";
import { signShare, verifyShare } from "../share";
import { getFull } from "./image";

const SHARE_TTL_MS = 7 * 24 * 3600 * 1000; // links live 7 days

// POST /api/share/<id> (authed) -> mint a public, signed, expiring URL for one item.
export async function handleShareCreate(request: Request, env: Env, id: string): Promise<Response> {
  if (!isAuthed(request, env)) return err(401, "unauthorized");
  const exp = Date.now() + SHARE_TTL_MS;
  // Signing key is AUTH_TOKEN: rotating it immediately invalidates ALL live share links.
  const sig = await signShare(id, exp, env.AUTH_TOKEN);
  const origin = new URL(request.url).origin;
  const url = `${origin}/s/${encodeURIComponent(id)}?exp=${exp}&sig=${sig}`;
  return json({ url, exp });
}

// GET /s/<id>?exp=&sig=  (public, no token) -> serve the one signed item.
export async function handleSharedItem(request: Request, env: Env, id: string): Promise<Response> {
  const q = new URL(request.url).searchParams;
  const exp = Number(q.get("exp"));
  const sig = q.get("sig") || "";
  if (!exp || Date.now() > exp) return err(410, "link expired");
  if (!env.AUTH_TOKEN || !(await verifyShare(id, exp, sig, env.AUTH_TOKEN))) {
    return err(403, "invalid signature");
  }
  const obj = await getFull(env, id);
  if (!obj) return err(404, "not found");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      // Browser-only cache (never shared/CDN caches), so an expired or revoked
      // link can't keep being served from an edge cache past its TTL.
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
