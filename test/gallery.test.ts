/// <reference types="@cloudflare/workers-types" />
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { Env } from "../src/responses";

declare global {
  interface ProvidedEnv extends Env {}
}

async function galleryHTML(e: Env): Promise<string> {
  const res = await worker.fetch(new Request("https://x/"), e);
  return res.text();
}

describe("gallery settings panel", () => {
  it("normal mode ships a settings button, a token panel, and a logout control", async () => {
    const html = await galleryHTML(env as Env);
    expect(html).toContain('id="settingsBtn"');
    expect(html).toContain('id="settings"');
    expect(html).toContain('id="tokenReveal"');
    expect(html).toContain('id="tokenCopy"');
    expect(html).toContain('id="logoutBtn"');
  });

  it("inlines the same maskToken the unit tests cover, not a hand-copied variant", async () => {
    const html = await galleryHTML(env as Env);
    expect(html).toContain("const maskToken = function");
  });

  it("demo mode hides the settings button along with the other write controls", async () => {
    const html = await galleryHTML({ ...(env as Env), DEMO_MODE: "1" });
    // The hide list is an array literal followed by .forEach(...); the settings
    // button must be in that list, not merely referenced elsewhere in the page.
    expect(html).toMatch(/\[[^\]]*"#settingsBtn"[^\]]*\]\.forEach/);
  });
});
