/// <reference types="@cloudflare/workers-types" />
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { handleUpload } from "../src/handlers/upload";
import { Env } from "../src/responses";

declare global {
  interface ProvidedEnv extends Env {}
}

function uploadReq(opts: { token?: string; full?: Blob; thumb?: Blob; source?: string }): Request {
  const fd = new FormData();
  if (opts.full) fd.set("full", opts.full, "shot.png");
  if (opts.thumb) fd.set("thumb", opts.thumb, "shot.jpg");
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.source) headers["x-source"] = opts.source;
  return new Request("https://x/api/upload", { method: "POST", headers, body: fd });
}

const png = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
const jpg = () => new Blob([new Uint8Array([4, 5])], { type: "image/jpeg" });

describe("handleUpload", () => {
  it("401 without token", async () => {
    const res = await handleUpload(uploadReq({ full: png() }), env as Env);
    expect(res.status).toBe(401);
  });

  it("400 without full field", async () => {
    const res = await handleUpload(uploadReq({ token: "test-token" }), env as Env);
    expect(res.status).toBe(400);
  });

  it("415 for non-web-safe full type", async () => {
    const heic = new Blob([new Uint8Array([9])], { type: "image/heic" });
    const res = await handleUpload(uploadReq({ token: "test-token", full: heic }), env as Env);
    expect(res.status).toBe(415);
  });

  it("stores full, returns id, hasThumb=false when no thumb", async () => {
    const res = await handleUpload(uploadReq({ token: "test-token", full: png(), source: "pwa" }), env as Env);
    expect(res.status).toBe(200);
    const { id } = await res.json<{ id: string }>();
    expect(id).toMatch(/^\d{16}-[0-9a-z]{6}$/);
    const obj = await (env as Env).BUCKET.get(`full/${id}.png`);
    expect(obj).not.toBeNull();
    expect(obj!.customMetadata?.hasThumb).toBe("false");
    expect(obj!.customMetadata?.source).toBe("pwa");
    // Consume the stream to avoid cleanup issues
    await obj!.body?.cancel();
  });

  it("stores thumb too when provided", async () => {
    const res = await handleUpload(uploadReq({ token: "test-token", full: png(), thumb: jpg() }), env as Env);
    const { id } = await res.json<{ id: string }>();
    const thumb = await (env as Env).BUCKET.get(`thumb/${id}.jpg`);
    expect(thumb).not.toBeNull();
    await thumb!.body?.cancel();
    const full = await (env as Env).BUCKET.get(`full/${id}.png`);
    expect(full!.customMetadata?.hasThumb).toBe("true");
    // Consume the stream to avoid cleanup issues
    await full!.body?.cancel();
  });
});
