/// <reference types="@cloudflare/workers-types" />
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { handleImage } from "../src/handlers/image";
import { fullKey, thumbKey } from "../src/ids";
import { Env } from "../src/responses";

declare global {
  interface ProvidedEnv extends Env {}
}

async function put(key: string, type: string, bytes: number[]) {
  await (env as any).BUCKET.put(key, new Uint8Array(bytes), { httpMetadata: { contentType: type } });
}
function req(size?: string, token = "test-token"): Request {
  const qs = size ? `?size=${size}` : "";
  return new Request(`https://x/i/ID${qs}`, { headers: { authorization: `Bearer ${token}` } });
}

describe("handleImage", () => {
  it("401 without token", async () => {
    const res = await handleImage(new Request("https://x/i/ID"), env as any, "ID");
    expect(res.status).toBe(401);
  });

  it("404 when nothing stored", async () => {
    const res = await handleImage(req(), env as any, "ID");
    expect(res.status).toBe(404);
  });

  it("serves full with content-type + cache header", async () => {
    await put(fullKey("ID", "png"), "image/png", [1, 2, 3]);
    const res = await handleImage(req(), env as any, "ID");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("max-age=31536000");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("serves thumb when size=thumb and thumb exists", async () => {
    await put(fullKey("ID", "png"), "image/png", [1, 2, 3]);
    await put(thumbKey("ID"), "image/jpeg", [9, 9]);
    const res = await handleImage(req("thumb"), env as any, "ID");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([9, 9]));
  });

  it("falls back to full when size=thumb but no thumb", async () => {
    await put(fullKey("ID", "jpg"), "image/jpeg", [7]);
    const res = await handleImage(req("thumb"), env as any, "ID");
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7]));
  });
});
