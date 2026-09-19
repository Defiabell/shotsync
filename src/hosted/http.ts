export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}
export function error(status: number, message: string): Response { return json({ error: message }, status); }
export async function readBody(request: Request, max: number): Promise<ArrayBuffer> {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new HttpError(413, '请求内容过大');
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + 30_000;
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(408, '上传超时')), Math.max(1, deadline - Date.now())); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) throw new HttpError(413, '请求内容过大');
      chunks.push(part.value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { result.set(c, offset); offset += c.length; }
  return result.buffer;
}
export async function readJson<T = Record<string, unknown>>(request: Request, max = 16384): Promise<T> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, '需要 JSON 请求');
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(await readBody(request, max)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '需要 JSON 对象');
    return value as T;
  }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, '无效的 JSON'); }
}
