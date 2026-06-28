/// <reference types="@cloudflare/workers-types" />
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { handleList } from "../src/handlers/list";
import { fullKey, makeId } from "../src/ids";
import { Env } from "../src/responses";

declare global {
  interface ProvidedEnv extends Env {}
}

async function seed(epochMs: number, hasThumb: string) {
  const id = makeId(epochMs, "aaaaaa".slice(0, 5) + (epochMs % 10));
  await (env as Env).BUCKET.put(fullKey(id, "png"), new Uint8Array([1]), {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { hasThumb, source: "mac", uploadedAt: "x", origName: "" },
  });
  return id;
}

function listReq(qs = "", token = "test-token"): Request {
  return new Request(`https://x/api/list${qs}`, { headers: { authorization: `Bearer ${token}` } });
}

describe("handleList", () => {
  beforeEach(async () => {
    // vitest-pool-workers isolates storage per test, no manual cleanup needed
  });

  it("401 without token", async () => {
    const res = await handleList(new Request("https://x/api/list"), env as any);
    expect(res.status).toBe(401);
  });

  it("returns items newest-first with metadata", async () => {
    await seed(1000, "false");
    await seed(3000, "true");
    await seed(2000, "false");
    const res = await handleList(listReq(), env as any);
    const body = await res.json<{ items: any[]; cursor: string | null }>();
    const times = body.items.map((i) => i.time);
    expect(times).toEqual([3000, 2000, 1000]); // reversed order
    const newest = body.items[0];
    expect(newest.hasThumb).toBe(true);
    expect(newest.contentType).toBe("image/png");
    expect(newest.source).toBe("mac");
  });

  it("respects limit and returns cursor", async () => {
    await seed(1000, "false");
    await seed(2000, "false");
    await seed(3000, "false");
    const res = await handleList(listReq("?limit=2"), env as any);
    const body = await res.json<{ items: any[]; cursor: string | null }>();
    expect(body.items.length).toBe(2);
    expect(body.cursor).toBeTruthy();
  });
});
