import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const T = { authorization: "Bearer test-token" };

describe("text items in the pool", () => {
  it("upload text -> list as text/plain -> serve text -> delete", async () => {
    const fd = new FormData();
    fd.set("full", new Blob(["hello cross-device"], { type: "text/plain" }), "note.txt");
    const up = await SELF.fetch("https://x/api/upload", {
      method: "POST",
      headers: { ...T, "x-source": "pwa" },
      body: fd,
    });
    expect(up.status).toBe(200);
    const { id } = await up.json<{ id: string }>();

    const list = await SELF.fetch("https://x/api/list", { headers: T });
    const body = await list.json<{ items: any[] }>();
    const item = body.items.find((i) => i.id === id);
    expect(item).toBeDefined();
    expect(item.contentType).toBe("text/plain");
    expect(item.hasThumb).toBe(false);

    const got = await SELF.fetch(`https://x/i/${id}`, { headers: T });
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toContain("text/plain");
    expect(await got.text()).toBe("hello cross-device");

    const del = await SELF.fetch(`https://x/api/img/${id}`, { method: "DELETE", headers: T });
    expect(del.status).toBe(200);
    await del.json();

    const after = await SELF.fetch(`https://x/i/${id}`, { headers: T });
    expect(after.status).toBe(404);
    await after.json();
  });

  it("accepts text/plain with a charset parameter (non-PWA clients)", async () => {
    const fd = new FormData();
    fd.set("full", new Blob(["with charset"], { type: "text/plain;charset=utf-8" }), "n.txt");
    const up = await SELF.fetch("https://x/api/upload", { method: "POST", headers: T, body: fd });
    expect(up.status).toBe(200);
    const { id } = await up.json<{ id: string }>();
    const got = await SELF.fetch(`https://x/i/${id}`, { headers: T });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("with charset");
    await SELF.fetch(`https://x/api/img/${id}`, { method: "DELETE", headers: T }).then((r) => r.json());
  });

  it("still rejects a genuinely unsupported type with 415", async () => {
    const fd = new FormData();
    fd.set("full", new Blob(["x"], { type: "application/octet-stream" }), "x.bin");
    const res = await SELF.fetch("https://x/api/upload", { method: "POST", headers: T, body: fd });
    expect(res.status).toBe(415);
  });
});
