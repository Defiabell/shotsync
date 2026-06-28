import { Env, err, json } from "../responses";
import { isAuthed } from "../auth";
import { FULL_EXTS, thumbKey } from "../ids";

export async function handleDelete(request: Request, env: Env, id: string): Promise<Response> {
  if (!isAuthed(request, env)) return err(401, "unauthorized");

  const keys = FULL_EXTS.map((ext) => `full/${id}.${ext}`);
  keys.push(thumbKey(id));
  // R2 delete accepts an array of keys
  await env.BUCKET.delete(keys);

  return json({ deleted: true });
}
