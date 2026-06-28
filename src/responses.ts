/// <reference types="@cloudflare/workers-types" />

export interface Env {
  BUCKET: R2Bucket;
  AUTH_TOKEN: string;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function err(status: number, message: string): Response {
  return json({ error: message }, status);
}
