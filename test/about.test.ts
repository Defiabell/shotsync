import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { Env } from "../src/responses";

const demoEnv = { ...(env as Env), DEMO_MODE: "1" };
const origin = "https://shotsync-demo.defiabell.workers.dev";

describe("public product page", () => {
  it("serves useful content and metadata without executing JavaScript or providing a token", async () => {
    const res = await worker.fetch(new Request(`${origin}/about`), demoEnv);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBeNull();
    expect(html).toContain(`<link rel="canonical" href="${origin}/about">`);
    expect(html).toContain("共享 token");
    expect(html).toContain("30 天删除需要你配置 R2 生命周期规则");
    expect(html).toContain('href="https://github.com/Defiabell/shotsync"');
    expect(html).not.toContain("test-token");
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0][1]).toContain('type="application/ld+json"');
    expect(JSON.parse(scripts[0][2]).url).toBe(`${origin}/about`);
  });

  it("only lists the public product page in the demo sitemap", async () => {
    const res = await worker.fetch(new Request(`${origin}/sitemap.xml`), demoEnv);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect([...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1])).toEqual([`${origin}/about`]);
    const robots = await worker.fetch(new Request(`${origin}/robots.txt`), demoEnv);
    expect(robots.headers.get("content-type")).toContain("text/plain");
    const text = await robots.text();
    expect(text).toContain(`Sitemap: ${origin}/sitemap.xml`);
    for (const path of ["/api/", "/i/", "/s/"]) expect(text).toContain(`Disallow: ${path}`);
    expect(text).not.toContain("Disallow: /about");
  });

  it("keeps private instances out of the index and their sitemaps empty", async () => {
    const res = await worker.fetch(new Request("https://private.example/about"), env as Env);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, follow");
    await res.text();
    const sitemap = await worker.fetch(new Request("https://private.example/sitemap.xml"), env as Env);
    expect(await sitemap.text()).not.toContain("<loc>");
    const api = await worker.fetch(new Request("https://private.example/api/list"), env as Env);
    expect(api.status).toBe(401);
    await api.text();
  });

  it("preserves the gallery at / with a discoverable product link", async () => {
    for (const e of [env as Env, demoEnv]) {
      const res = await worker.fetch(new Request(`${origin}/`), e);
      const html = await res.text();
      expect(html).toContain('id="grid"');
      expect(html).toContain('href="/about"');
      expect(html).toContain('<meta name="robots" content="noindex, follow">');
    }
  });

  it("normalizes trailing slashes, supports HEAD, and rejects writes", async () => {
    const redirect = await worker.fetch(new Request(`${origin}/about/`), demoEnv);
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/about");
    for (const path of ["/about", "/robots.txt", "/sitemap.xml"]) {
      const head = await worker.fetch(new Request(`${origin}${path}`, { method: "HEAD" }), demoEnv);
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      const post = await worker.fetch(new Request(`${origin}${path}`, { method: "POST" }), demoEnv);
      expect(post.status).toBe(405);
      await post.text();
    }
  });
});
