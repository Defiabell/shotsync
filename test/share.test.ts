import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { signShare, verifyShare } from "../src/share";

const T = { authorization: "Bearer test-token" };

describe("share signing (HMAC)", () => {
  it("sign/verify roundtrip", async () => {
    const sig = await signShare("id1", 12345, "secret");
    expect(await verifyShare("id1", 12345, sig, "secret")).toBe(true);
  });
  it("rejects tampered sig", async () => {
    const sig = await signShare("id1", 12345, "secret");
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === "0" ? "1" : "0");
    expect(await verifyShare("id1", 12345, flipped, "secret")).toBe(false);
  });
  it("rejects wrong exp", async () => {
    const sig = await signShare("id1", 12345, "secret");
    expect(await verifyShare("id1", 99999, sig, "secret")).toBe(false);
  });
  it("rejects wrong secret", async () => {
    const sig = await signShare("id1", 12345, "secretA");
    expect(await verifyShare("id1", 12345, sig, "secretB")).toBe(false);
  });
  it("rejects length mismatch without throwing", async () => {
    expect(await verifyShare("id1", 12345, "short", "secret")).toBe(false);
  });
});

describe("share endpoints", () => {
  async function uploadImage(): Promise<string> {
    const fd = new FormData();
    fd.set("full", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "s.png");
    const up = await SELF.fetch("https://x/api/upload", { method: "POST", headers: T, body: fd });
    return (await up.json<{ id: string }>()).id;
  }

  it("mint requires auth (401 without token)", async () => {
    const res = await SELF.fetch("https://x/api/share/whatever", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("mint -> public fetch works WITHOUT token", async () => {
    const id = await uploadImage();
    const sh = await SELF.fetch(`https://x/api/share/${id}`, { method: "POST", headers: T });
    expect(sh.status).toBe(200);
    const { url } = await sh.json<{ url: string }>();
    expect(url).toContain(`/s/${id}?exp=`);

    const pub = await SELF.fetch(url); // no auth header
    expect(pub.status).toBe(200);
    expect(pub.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await pub.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("tampered signature -> 403", async () => {
    const id = await uploadImage();
    const exp = Date.now() + 100000;
    const res = await SELF.fetch(`https://x/s/${id}?exp=${exp}&sig=deadbeef`);
    expect(res.status).toBe(403);
  });

  it("expired link -> 410 (even with a valid signature)", async () => {
    const id = await uploadImage();
    const pastExp = 1000;
    const sig = await signShare(id, pastExp, "test-token");
    const res = await SELF.fetch(`https://x/s/${id}?exp=${pastExp}&sig=${sig}`);
    expect(res.status).toBe(410);
  });

  it("valid signature for a missing item -> 404", async () => {
    const exp = Date.now() + 100000;
    const sig = await signShare("GHOSTID", exp, "test-token");
    const res = await SELF.fetch(`https://x/s/GHOSTID?exp=${exp}&sig=${sig}`);
    expect(res.status).toBe(404);
  });
});
