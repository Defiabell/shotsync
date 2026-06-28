import { Env, err, json } from "../responses";
import { isAuthed } from "../auth";
import { EXT_BY_TYPE, fullKey, makeId, randSuffix, thumbKey } from "../ids";

const MAX_FULL_BYTES = 25 * 1024 * 1024;

export async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (!isAuthed(request, env)) return err(401, "unauthorized");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return err(400, "expected multipart/form-data");
  }

  // Duck-type the File: `form.get()` returns `string | File | null`, and TS strict
  // rejects `instanceof File` on that union (TS2358), so narrow by shape instead.
  const fullEntry = form.get("full");
  if (!fullEntry || typeof fullEntry !== "object" || !("stream" in fullEntry) || !("name" in fullEntry)) {
    return err(400, "missing full");
  }
  const full = fullEntry as File;

  // Normalize the MIME: strip any parameters like "; charset=utf-8" so a
  // non-PWA client (curl, Shortcut) isn't silently 415'd on text uploads.
  const mimeType = full.type.split(";")[0].trim().toLowerCase();
  const ext = EXT_BY_TYPE[mimeType];
  if (!ext) return err(415, `unsupported type: ${full.type}`);
  if (full.size > MAX_FULL_BYTES) return err(413, "full too large");

  const thumbEntry = form.get("thumb");
  const hasThumb = !!(thumbEntry && typeof thumbEntry === "object" && "stream" in thumbEntry && "name" in thumbEntry);

  const id = makeId(Date.now(), randSuffix());
  const meta = {
    source: request.headers.get("x-source") || "unknown",
    origName: request.headers.get("x-filename") || full.name || "",
    uploadedAt: new Date().toISOString(),
    hasThumb: String(hasThumb),
  };

  await env.BUCKET.put(fullKey(id, ext), full.stream(), {
    httpMetadata: { contentType: full.type },
    customMetadata: meta,
  });

  if (hasThumb) {
    const thumb = thumbEntry as Blob;
    await env.BUCKET.put(thumbKey(id), thumb.stream(), {
      httpMetadata: { contentType: "image/jpeg" },
    });
  }

  return json({ id });
}
