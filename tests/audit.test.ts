import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditPage } from "../packages/audit-core/src/audit.js";
import { comparePages } from "../packages/site-comparison/src/compare.js";
import type { NetworkPolicy, Transport } from "../packages/safe-fetch/src/index.js";

const policy: NetworkPolicy = { mode: "public", allowedHosts: [], privateHosts: [] };
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const serve = (html: string, headers: Record<string, string> = {}): Transport => async () => ({
  status: 200, headers: { "content-type": "text/html", ...headers }, destroy() {}, body: (async function* () { yield Buffer.from(html); })()
});
const audit = (html: string, url = "https://old.example.com/", headers?: Record<string, string>) => auditPage(url, { policy, resolve, transport: serve(html, headers) });
const rules = (a: { findings: Array<{ ruleId: string }> }) => a.findings.map((f) => f.ruleId);

describe("auditPage rules", () => {
  it("flags missing title, description, canonical and H1", async () => {
    const a = await audit("<html><head></head><body><p>x</p></body></html>");
    expect(a).toMatchObject({ title: null, metaDescription: null, canonical: null });
    expect(a.headings.h1).toEqual([]);
    expect(a.findings.length).toBeGreaterThanOrEqual(4);
  });
  it("extracts signals from the old fixture", async () => {
    const a = await audit(fx("old-page.html"));
    expect(a).toMatchObject({ title: "Old article", metaDescription: "Article description", schemaTypes: ["Article"], jsonLdBlocks: 1 });
    expect(a.images.missingAlt).toBe(0); expect(a.links.internal).toBe(1);
  });
  it("detects noindex from meta and from X-Robots-Tag", async () => {
    expect(rules(await audit(fx("new-page.html")))).toContain("seo.robots.noindex");
    const h = await audit("<html><title>t</title></html>", "https://old.example.com/", { "x-robots-tag": "noindex" });
    expect(rules(h)).toContain("seo.robots.noindex");
  });
  it("flags invalid JSON-LD", async () => {
    expect(rules(await audit('<html><script type="application/ld+json">{oops</script></html>'))).toContain("schema.jsonld.invalid-json");
  });
  it("records a redirect as a finding and resolves relative links against the final URL", async () => {
    let n = 0;
    const t: Transport = async ({ url }) => n++ === 0
      ? { status: 301, headers: { location: "https://other.example.com/new/" } as Record<string, string>, destroy() {}, body: (async function* () {})() }
      : { status: 200, headers: { "content-type": "text/html" } as Record<string, string>, destroy() {}, body: (async function* () { yield Buffer.from('<a href="/x">i</a><a href="https://elsewhere.com/">e</a><a href="mailto:a@b.c">m</a>'); })() };
    const a = await auditPage("https://old.example.com/", { policy, resolve, transport: t });
    expect(a.finalUrl).toBe("https://other.example.com/new/");
    expect(a.redirectChain).toEqual(["https://other.example.com/new/"]);
    expect(rules(a)).toContain("http.redirect");
    expect(a.links).toMatchObject({ internal: 1, external: 1 });
  });
});

describe("preload detection", () => {
  it("extracts preload links with resolved URLs, type and fetchpriority", async () => {
    const a = await audit('<html><head><link rel="preload" as="image" href="/hero.png" fetchpriority="HIGH"><link rel="preload" href="/f.woff2" as="font"><link rel="stylesheet" href="/s.css"></head></html>');
    expect(a.preloads).toEqual([
      { href: "https://old.example.com/hero.png", as: "image", fetchPriority: "high", srcsetUrls: [] },
      { href: "https://old.example.com/f.woff2", as: "font", fetchPriority: null, srcsetUrls: [] }
    ]);
  });
  it("reads a responsive preload's imagesrcset (the real-world WordPress pattern)", async () => {
    const a = await audit('<head><link rel="preload" as="image" href="https://old.example.com/u/hero-1.webp" fetchpriority="high" imagesrcset="https://old.example.com/u/hero-1.webp 1920w, https://old.example.com/u/hero-1-1536x682.webp 1536w, /u/hero-1-768x341.webp 768w" imagesizes="100vw" /></head>');
    expect(a.preloads![0]).toMatchObject({ href: "https://old.example.com/u/hero-1.webp", fetchPriority: "high", srcsetUrls: ["https://old.example.com/u/hero-1.webp", "https://old.example.com/u/hero-1-1536x682.webp", "https://old.example.com/u/hero-768x341.webp".replace("hero", "hero-1")] });
  });
  it("records <img> loading hints with resolved srcset URLs", async () => {
    const a = await audit('<body><img fetchpriority="HIGH" src="/h.webp" srcset="/h.webp 1920w, /h-768x341.webp 768w"><img loading="lazy" src="/b.png"><img alt="no src"></body>');
    expect(a.imgTags).toEqual([
      { src: "https://old.example.com/h.webp", srcsetUrls: ["https://old.example.com/h.webp", "https://old.example.com/h-768x341.webp"], fetchPriority: "high", loading: null },
      { src: "https://old.example.com/b.png", srcsetUrls: [], fetchPriority: null, loading: "lazy" }
    ]);
  });
  it("records how scripts, stylesheets and connections are loaded", async () => {
    const a = await audit(`<head>
      <script data-wp-strategy="defer" defer id="x" src="/p/splide.js?ver=1"></script><script async src="/p/a.js"></script><script type="module" src="/p/m.js"></script><script src="/p/blocking.js"></script>
      <link rel="stylesheet" href="/p/main.css"><link rel="preload" as="style" href="/p/pre.css"><link rel="stylesheet" href="/p/print.css" media="print" onload="this.media='all'">
      <link rel="preconnect" href="https://fonts.gstatic.com/x"><link rel="preconnect" href="https://fonts.gstatic.com"></head>`);
    expect(a.scripts).toEqual([
      { src: "https://old.example.com/p/splide.js?ver=1", defer: true, async: false, module: false }, { src: "https://old.example.com/p/a.js", defer: false, async: true, module: false },
      { src: "https://old.example.com/p/m.js", defer: false, async: false, module: true }, { src: "https://old.example.com/p/blocking.js", defer: false, async: false, module: false }
    ]);
    expect(a.stylesheets).toEqual([{ href: "https://old.example.com/p/main.css", async: false }, { href: "https://old.example.com/p/pre.css", async: true }, { href: "https://old.example.com/p/print.css", async: true }]);
    expect(a.preconnects).toEqual(["https://fonts.gstatic.com"]);
  });
});

describe("old vs new comparison from fixtures", () => {
  it("reports title, description, canonical, noindex, schema, H1 and alt regressions", async () => {
    const [o, n] = [await audit(fx("old-page.html")), await audit(fx("new-page.html"), "https://new.example.com/")];
    const titles = comparePages(o, n).differences.map((d) => d.title);
    expect(titles).toEqual(expect.arrayContaining([
      "Page title changed", "Meta description changed", "Canonical URL changed", "Robots directive changed",
      "Structured data types changed", "H1 content changed", "More images lack alt text", "JSON-LD block count decreased"
    ]));
  });
  it("reports nothing for identical pages", async () => {
    const a = await audit(fx("old-page.html")); expect(comparePages(a, a).differences).toEqual([]);
  });
});
