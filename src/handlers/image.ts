import { Env, err } from "../responses";
import { isAuthed } from "../auth";
import { FULL_EXTS, thumbKey } from "../ids";

// Try to find full image with one of the supported extensions
export async function getFull(env: Env, id: string): Promise<R2ObjectBody | null> {
  for (const ext of FULL_EXTS) {
    const obj = await env.BUCKET.get(`full/${id}.${ext}`);
    if (obj) return obj;
  }
  return null;
}

export async function handleImage(request: Request, env: Env, id: string): Promise<Response> {
  // Check authentication
  if (!isAuthed(request, env)) return err(401, "unauthorized");

  // Get size parameter from query string
  const size = new URL(request.url).searchParams.get("size");

  let obj: R2ObjectBody | null = null;

  // If size=thumb is requested, try to fetch thumb
  if (size === "thumb") obj = await env.BUCKET.get(thumbKey(id));

  // Fall back to full image if thumb not found or not requested
  if (!obj) obj = await getFull(env, id);

  // Return 404 if nothing found
  if (!obj) return err(404, "not found");

  // Return image with proper headers
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
