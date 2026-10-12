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
      { href: "https://old.example.com/hero.png", as: "image", fetchPriority: "high" },
      { href: "https://old.example.com/f.woff2", as: "font", fetchPriority: null }
    ]);
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
