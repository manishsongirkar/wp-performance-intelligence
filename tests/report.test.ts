import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { renderHtmlReport, esc, type ReportInput } from "../packages/reports/src/html.js";
import { fixesForRule, fixesForDifference } from "../packages/reports/src/fixes.js";
import { reportFolderName } from "../apps/api/src/report-cli.js";
import type { PageAudit } from "../packages/contracts/src/types.js";

const XSS = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;
const audit = (): PageAudit => ({
  schemaVersion: "1.0.0", url: `https://site.test/?q=${XSS}`, fetchedAt: "2026-01-01T00:00:00Z", statusCode: 200, finalUrl: "https://site.test/", redirectChain: [],
  contentType: "text/html", title: XSS, metaDescription: null, canonical: null, robots: "noindex, nofollow", headings: { h1: [XSS], h2Count: 1, h3Count: 0 },
  images: { total: 2, missingAlt: 2, missingDimensions: 0 }, links: { total: 1, internal: 1, external: 0 }, schemaTypes: [], jsonLdBlocks: 0, limitations: ["x"],
  findings: [
    { id: "1", ruleId: "seo.robots.noindex", category: "seo", severity: "high", confidence: "high", title: "Page has a noindex directive", description: XSS, url: "https://site.test/", evidence: [{ type: "header", description: "Robots", value: XSS }], recommendation: "Fix it", status: "open" },
    { id: "2", ruleId: "seo.canonical.missing", category: "seo", severity: "medium", confidence: "high", title: "Missing canonical link", description: "d", url: "https://site.test/", evidence: [], recommendation: "r", status: "open" }
  ]
});
const input = (): ReportInput => ({ audits: [audit()], comparisons: [{ oldUrl: "https://a.test/", newUrl: "https://b.test/", comparedAt: "x", status: "compared", differences: [{ id: "1", category: "seo", severity: "critical", title: "Robots directive changed", oldValue: null, newValue: XSS, recommendation: "r" }] }], measurements: [], lighthouse: [], failures: [`audit ${XSS}: failed`] });

describe("report helpers", () => {
  it("escapes HTML", () => expect(esc(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;"));
  it("builds site + date-time folder names", () => {
    expect(reportFolderName("https://geokon.test/about-us/", new Date(2026, 9, 12, 14, 3, 5))).toBe("geokon.test_2026-10-12_14-03-05");
    expect(reportFolderName("not a url", new Date(2026, 0, 2, 3, 4, 5))).toBe("report_2026-01-02_03-04-05");
  });
  it("has fix examples for known rules and comparison titles, none for unknown", () => {
    expect(fixesForRule("seo.canonical.missing").length).toBeGreaterThan(0);
    expect(fixesForRule("modern-image-formats").length).toBeGreaterThan(0);
    expect(fixesForDifference("Canonical URL changed").length).toBeGreaterThan(0);
    expect(fixesForRule("nope")).toEqual([]);
  });
  it("never emits untrusted markup unescaped", () => {
    const html = renderHtmlReport(input());
    expect(html).not.toContain("<script>window.__pwned");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Content-Security-Policy");
  });
});

let hasBrowser = false;
try { hasBrowser = existsSync(chromium.executablePath()); } catch { /* not installed */ }
describe.skipIf(!hasBrowser)("report in headless Chromium", () => {
  let server: http.Server; let base: string;
  beforeAll(async () => {
    const html = renderHtmlReport(input());
    server = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(html); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => { server.closeAllConnections(); server.close(); });

  it("renders without script errors, runs no injected script, and every code block has a working copy button", async () => {
    const browser = await chromium.launch(); // headless
    try {
      const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base);
      expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
      expect(errors).toEqual([]);

      const blocks = await page.locator(".code").count();
      expect(blocks).toBeGreaterThan(3);
      expect(await page.locator(".code .copy").count()).toBe(blocks);

      await page.locator("details.fix >> nth=0").evaluate((d) => ((d as HTMLDetailsElement).open = true));
      const expected = await page.locator(".code code").first().textContent();
      await page.locator(".copy").first().click();
      await expect.poll(() => page.locator(".copy").first().textContent()).toBe("Copied!");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
      expect(expected).toContain("blog_public"); // the first fix under the first (high) finding
    } finally { await browser.close(); }
  }, 30_000);

  it("falls back to execCommand when the async clipboard API is unavailable", async () => {
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.addInitScript(() => { Object.defineProperty(navigator, "clipboard", { value: undefined }); (document as unknown as { execCommand: unknown }).execCommand = () => true; });
      await page.goto(base);
      await page.locator("details.fix").evaluateAll((all) => all.forEach((d) => ((d as HTMLDetailsElement).open = true)));
      await page.locator(".copy").first().click();
      await expect.poll(() => page.locator(".copy").first().textContent()).toBe("Copied!");
    } finally { await browser.close(); }
  }, 30_000);
});
