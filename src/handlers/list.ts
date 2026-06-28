import { Env, err, json } from "../responses";
import { isAuthed } from "../auth";
import { epochMsFromId, idFromFullKey } from "../ids";

export async function handleList(request: Request, env: Env): Promise<Response> {
  if (!isAuthed(request, env)) return err(401, "unauthorized");

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);
  const cursor = url.searchParams.get("cursor") || undefined;

  // `include` is missing from R2ListOptions in @cloudflare/workers-types ^4.0.0,
  // so assert the options to an extended type. The arg stays assignable to
  // R2ListOptions, so the R2Objects return type is preserved (unlike `as any`).
  const res = await env.BUCKET.list({
    prefix: "full/",
    limit,
    cursor,
    include: ["customMetadata", "httpMetadata"],
  } as R2ListOptions & { include: ("httpMetadata" | "customMetadata")[] });

  const items = res.objects.map((o) => {
    const id = idFromFullKey(o.key);
    return {
      id,
      time: epochMsFromId(id),
      contentType: o.httpMetadata?.contentType || "application/octet-stream",
      hasThumb: o.customMetadata?.hasThumb === "true",
      source: o.customMetadata?.source || "unknown",
    };
  });

  return json({ items, cursor: res.truncated ? res.cursor : null });
}
