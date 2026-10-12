import http from "node:http";
import zlib from "node:zlib";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPage } from "../packages/audit-core/src/audit.js";
import { parseSrcset } from "../packages/audit-core/src/srcset.js";
import { comparePages } from "../packages/site-comparison/src/compare.js";
import { isNoindex } from "../packages/contracts/src/robots.js";
import { parseUrlCsv } from "../packages/url-import/src/csv.js";
import { classifyIp, safeFetch, SafeFetchError, type NetworkPolicy, type Resolver, type Transport } from "../packages/safe-fetch/src/index.js";
import { competingImages, toEvidence } from "../packages/browser-audit/src/lighthouse.js";
import { loadBaseline } from "../apps/api/src/report.js";
import { renderHtmlReport } from "../packages/reports/src/html.js";
import type { LighthouseRun, PageAudit } from "../packages/contracts/src/types.js";

// Each test here reproduces a defect found by independent review (and fixed), so it cannot come back.
const policy: NetworkPolicy = { mode: "public", allowedHosts: [], privateHosts: [] };
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
const serve = (html: string, headers: Record<string, string> = {}): Transport => async () => ({ status: 200, headers: { "content-type": "text/html", ...headers }, destroy() {}, body: (async function* () { yield Buffer.from(html); })() });
const audit = (html: string, headers?: Record<string, string>, url = "https://site.test/dir/page") => auditPage(url, { policy, resolve, transport: serve(html, headers) });

describe("srcset parsing follows the WHATWG rules", () => {
  it("keeps commas inside URLs and data: URIs, and splits real candidates", () => {
    expect(parseSrcset("a.jpg 1x, https://x/c_w100,h50/b.jpg 2x")).toEqual(["a.jpg", "https://x/c_w100,h50/b.jpg"]);
    expect(parseSrcset("data:image/png;base64,AAA 1x, b.png 2x")).toEqual(["data:image/png;base64,AAA", "b.png"]);
    expect(parseSrcset("a.jpg, b.jpg 2x,c.jpg 3x")).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(parseSrcset("a.jpg 100w (x,y), b.jpg 200w")).toEqual(["a.jpg", "b.jpg"]);
    expect(parseSrcset(undefined)).toEqual([]); expect(parseSrcset(" , ,")).toEqual([]);
  });
});

describe("robots detection", () => {
  it("recognises noindex, the 'none' shorthand and user-agent prefixes, but not value directives", () => {
    for (const v of ["noindex", "NOINDEX, nofollow", "none", "googlebot: noindex", "index, follow, noindex", "noindex; nofollow"]) expect(isNoindex(v), v).toBe(true);
    for (const v of ["index,follow", "max-image-preview:none", "max-snippet:0, index", "nofollow", "", null, undefined, "noarchive"]) expect(isNoindex(v), String(v)).toBe(false);
  });
  it("any source blocks indexing: the X-Robots-Tag header is not overridden by an index meta tag", async () => {
    const a = await audit('<meta name="robots" content="index,follow">', { "x-robots-tag": "noindex" });
    expect(a.findings.some((f) => f.ruleId === "seo.robots.noindex")).toBe(true); expect(a.robots).toContain("noindex");
    expect((await audit('<meta name="robots" content="none">')).findings.some((f) => f.ruleId === "seo.robots.noindex")).toBe(true);
    expect((await audit('<meta name="googlebot" content="noindex">')).findings.some((f) => f.ruleId === "seo.robots.noindex")).toBe(true);
    expect((await audit('<meta name="robots" content="index,follow, max-image-preview:large">')).findings.some((f) => f.ruleId === "seo.robots.noindex")).toBe(false);
  });
  it("a robots change is critical only when indexing becomes blocked", async () => {
    const mk = async (robots: string | null) => audit(robots ? `<meta name="robots" content="${robots}">` : "<p>x</p>");
    const sev = async (o: string | null, n: string | null) => comparePages(await mk(o), await mk(n)).differences.find((d) => d.title === "Robots directive changed")?.severity;
    expect(await sev(null, "noindex")).toBe("critical");
    expect(await sev("noindex", "noindex, nofollow")).toBe("medium");     // already blocked: not a new risk
    expect(await sev("noindex", null)).toBe("low");                       // unblocked
    expect(await sev("index", "index, follow")).toBe("medium");
  });
});

describe("alt text", () => {
  it("counts only images with NO alt attribute (alt='' and presentational images are valid)", async () => {
    const a = await audit('<img src="a"><img alt="" src="b"><img alt="  " src="c"><img role="presentation" src="d"><img aria-hidden="true" src="e"><img alt="ok" src="f"><img role="none" src="g">');
    expect(a.images).toMatchObject({ total: 7, missingAlt: 1 });
    expect(a.findings.find((f) => f.ruleId === "a11y.images.missing-alt")!.title).toContain("1 image(s)");
    expect((await audit('<img alt="" src="b"><img role="presentation" src="c">')).findings.some((f) => f.ruleId === "a11y.images.missing-alt")).toBe(false);
  });
});

describe("HTML extraction is robust", () => {
  it("a malformed preload href does not abort the audit, and empty preloads are dropped", async () => {
    const a = await audit('<title>T</title><link rel="preload" as="image" href="http://[bad"><link rel="preload" as="font"><link rel="preload" as="image" imagesrcset="/a.jpg 1x"><link rel="preload" as="image" href="/ok.jpg">');
    expect(a.title).toBe("T");
    expect(a.preloads).toEqual([{ href: "", as: "image", fetchPriority: null, srcsetUrls: ["https://site.test/a.jpg"] }, { href: "https://site.test/ok.jpg", as: "image", fetchPriority: null, srcsetUrls: [] }]);
  });
  it("resolves URLs against <base href>", async () => {
    const a = await audit('<base href="https://cdn.test/static/"><script src="app.js"></script><img src="i.png" srcset="i-2x.png 2x"><link rel="stylesheet" href="s.css"><link rel="preconnect" href="https://f.test/x">');
    expect(a.scripts![0]!.src).toBe("https://cdn.test/static/app.js"); expect(a.imgTags![0]).toMatchObject({ src: "https://cdn.test/static/i.png", srcsetUrls: ["https://cdn.test/static/i-2x.png"] });
    expect(a.stylesheets![0]!.href).toBe("https://cdn.test/static/s.css");
  });
  it("keeps CDN URLs with commas and ignores data: images", async () => {
    const a = await audit('<img src="data:image/gif;base64,R0lGOD" srcset="https://x/c_w100,h50/b.jpg 2x"><img src="data:image/png;base64,AAA">');
    expect(a.imgTags).toEqual([{ src: "data:image/gif;base64,R0lGOD", srcsetUrls: ["https://x/c_w100,h50/b.jpg"], fetchPriority: null, loading: null }].map((t) => ({ ...t, src: t.src })));
  });
  it("counts JSON-LD with a charset parameter, and truncates very long text so exports keep working", async () => {
    const a = await audit(`<title>${"T".repeat(6000)}</title><h1>${"H".repeat(6000)}</h1><script type="application/ld+json; charset=utf-8">{"@type":"Article"}</script>`);
    expect(a.jsonLdBlocks).toBe(1); expect(a.schemaTypes).toEqual(["Article"]);
    expect(a.title!.length).toBeLessThanOrEqual(1000); expect(a.headings.h1[0]!.length).toBeLessThanOrEqual(500);
  });
  it("compares relative and absolute canonicals as the same URL", async () => {
    const a = await audit('<link rel="canonical" href="/dir/page">'), b = await audit('<link rel="canonical" href="https://site.test/dir/page">');
    expect(comparePages(a, b).differences.some((d) => d.title === "Canonical URL changed")).toBe(false);
  });
});

describe("safe-fetch hardening", () => {
  let server: http.Server; let port: number;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/gzip") { res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }); return res.end(zlib.gzipSync("<title>zipped</title>")); }
      if (req.url === "/bomb") { res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" }); return res.end(zlib.gzipSync(Buffer.alloc(5_000_000, "a"))); }
      if (req.url === "/echo") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<title>${req.headers["accept-encoding"]}</title>`); }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => { server.closeAllConnections(); server.close(); });
  const local: NetworkPolicy = { mode: "local", allowedHosts: [], privateHosts: ["localhost", "127.0.0.1"] };

  it("falls back to the next VALIDATED address ('localhost' resolves to ::1 first, but the dev server listens on IPv4 only)", async () => {
    const both: Resolver = async () => [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }];
    const r = await safeFetch(`http://localhost:${port}/echo`, { policy: local, resolve: both, timeoutMs: 3000 });
    expect(r.status).toBe(200);
  });
  it("never tries an address outside the validated set (a public name with a private answer is still blocked)", async () => {
    const mixed: Resolver = async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
    await expect(safeFetch(`http://rebind.example:${port}/echo`, { policy: { ...local, mode: "public" }, resolve: mixed })).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
  });
  it("reports a clean error when every address refuses the connection", async () => {
    const refused: Resolver = async () => [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }];
    await expect(safeFetch(`http://localhost:1/`, { policy: local, resolve: refused, timeoutMs: 3000 })).rejects.toBeInstanceOf(SafeFetchError);
  });
  it("asks for an uncompressed body, decodes one that is compressed anyway, and still enforces the size limit on decoded bytes", async () => {
    const lo: Resolver = async () => [{ address: "127.0.0.1", family: 4 }];
    expect((await safeFetch(`http://localhost:${port}/echo`, { policy: local, resolve: lo })).body.toString()).toBe("<title>identity</title>");
    expect((await safeFetch(`http://localhost:${port}/gzip`, { policy: local, resolve: lo })).body.toString()).toBe("<title>zipped</title>");
    await expect(safeFetch(`http://localhost:${port}/bomb`, { policy: local, resolve: lo, maxBytes: 100_000 })).rejects.toMatchObject({ code: "TOO_LARGE" });
  });
  it("blocks the extra reserved ranges", () => {
    for (const ip of ["192.88.99.1", "2001:2::1", "2001:10::1", "3fff::1", "3fff:fff::1"]) expect(classifyIp(ip), ip).toBe("blocked");
    for (const ip of ["2001:4860:4860::8888", "192.88.98.1", "2001:3::1"]) expect(classifyIp(ip), ip).toBe("public");
  });
});

describe("CSV", () => {
  it("reports physical line numbers (blank lines and multi-line cells counted) and accepts header variants", () => {
    const r = parseUrlCsv('url\nhttp://a.com\n\n\nftp://x\nhttp://b.com\n"multi\nline",x\nhttp://c.com');
    expect(r.errors.map((e) => e.split(":")[0])).toEqual(["Row 5", "Row 7"]);
    const p = parseUrlCsv("Old URL, New-URL ,Group\nhttp://a.com/,http://b.com/,g");
    expect(p.mode).toBe("pairs"); expect(p.pairs[0]).toMatchObject({ oldUrl: "http://a.com/", newUrl: "http://b.com/", group: "g", rowNumber: 2 });
  });
});

describe("what-if experiment never blocks the LCP image", () => {
  const run = (snippet: string | undefined, over: Partial<LighthouseRun> = {}): LighthouseRun => ({
    ok: true, scores: { performance: 1, accessibility: 1, bestPractices: 1, seo: 1 }, metrics: { fcpMs: 1, lcpMs: 1, tbtMs: 1, cls: 0, speedIndexMs: 1, ttiMs: 1 }, opportunities: [], runWarnings: [],
    lcpPhases: [{ phase: "TTFB", ms: 500 }, { phase: "Load Delay", ms: 9000 }, { phase: "Load Time", ms: 100 }],
    evidence: { ...(snippet ? { "largest-contentful-paint-element": [{ snippet }] } : {}), "network-requests": ["hero.jpg", "hero-800.jpg", "b.jpg", "c.jpg"].map((n) => ({ url: `https://s.test/u/${n}`, totalBytes: 400_000, resourceType: "Image" })) }, ...over
  });
  it("excludes the src and every srcset candidate of the LCP <img>", () => {
    const urls = competingImages(run('<img src="https://s.test/u/hero-800.jpg" srcset="https://s.test/u/hero.jpg 1600w, https://s.test/u/hero-800.jpg 800w">'));
    expect(urls).toEqual(["https://s.test/u/b.jpg", "https://s.test/u/c.jpg"]);
  });
  it("does not run when the LCP element is a CSS background or text (its resource is unknown)", () => {
    expect(competingImages(run('<div style="background-image:url(hero.jpg)">'))).toEqual([]);
    expect(competingImages(run('<p>Heading</p>'))).toEqual([]);
    expect(competingImages(run(undefined))).toEqual([]);
  });
  it("keeps images in the evidence even when scripts and video are larger", () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => ({ url: `https://s.test/s${i}.js`, transferSize: 900_000 - i, resourceType: "Script" })),
      ...Array.from({ length: 4 }, (_, i) => ({ url: `https://s.test/i${i}.png`, transferSize: 300_000 - i, resourceType: "Image" }))
    ];
    const ev = toEvidence("network-requests", items);
    expect(ev.filter((e) => e.resourceType === "Image")).toHaveLength(4);
    expect(ev.length).toBeLessThanOrEqual(12);
  });
});

describe("baseline files are validated, not trusted", () => {
  const write = async (content: string) => { const d = await mkdtemp(join(tmpdir(), "wpi-bl-")); const f = join(d, "data.json"); await writeFile(f, content); return f; };
  const lh = (url: string) => ({ measurement: { url, profile: "mobile", summary: { performanceScore: { median: 80, min: 70, max: 90, samples: 3 } }, runs: [], metadata: {} }, reportFiles: [] });
  it("rejects non-reports with clear messages", async () => {
    await expect(loadBaseline(await write("null"))).rejects.toThrow("not a report");
    await expect(loadBaseline(await write("[]"))).rejects.toThrow("not a report");
    await expect(loadBaseline(await write("{nope"))).rejects.toThrow("not valid JSON");
    await expect(loadBaseline(await write('{"lighthouse":[null,1,"x",{}]}'))).rejects.toThrow("no Lighthouse or browser measurements");
    await expect(loadBaseline(await write('{"measurements":"abc"}'))).rejects.toThrow("no Lighthouse or browser measurements");
  });
  it("drops malformed entries but keeps valid ones, and the report renders from them", async () => {
    const b = await loadBaseline(await write(JSON.stringify({ generatedAt: "then", lighthouse: [null, 1, lh("https://a.test/"), { measurement: { url: 5 } }], measurements: [{}, null] })));
    expect(b.lighthouse).toHaveLength(1); expect(b.measurements).toHaveLength(0);
    expect(() => renderHtmlReport({ audits: [], comparisons: [], measurements: [], lighthouse: [], baseline: b })).not.toThrow();
  });
});

describe("export schema accepts what the audit produces", () => {
  it("a real audit with a huge title/h1 passes the export schema (it was rejected before truncation)", async () => {
    const { pageAuditSchema } = await import("../packages/contracts/src/schemas.js");
    const a: PageAudit = await audit(`<title>${"T".repeat(9000)}</title><h1>${"H".repeat(9000)}</h1><meta name="description" content="${"d".repeat(9000)}"><link rel="canonical" href="https://s.test/${"p".repeat(9000)}">`);
    expect(pageAuditSchema.safeParse(JSON.parse(JSON.stringify(a))).success).toBe(true);
  });
});

describe("what-if trigger works for both Lighthouse 12 and 13 phase semantics", () => {
  const imgs = ["a", "b", "c"].map((n) => ({ url: `https://s.test/u/${n}.png`, totalBytes: 400_000, resourceType: "Image" }));
  const run = (lcpMs: number, phases: Array<{ phase: string; ms: number }>): LighthouseRun => ({
    ok: true, scores: { performance: 1, accessibility: 1, bestPractices: 1, seo: 1 }, metrics: { fcpMs: 1, lcpMs, tbtMs: 1, cls: 0, speedIndexMs: 1, ttiMs: 1 }, opportunities: [], runWarnings: [],
    lcpPhases: phases, evidence: { "largest-contentful-paint-element": [{ snippet: '<img src="https://s.test/u/hero.png">' }], "network-requests": imgs }
  });
  it("Lighthouse 12 (simulated phases): Load Delay dominates", () => expect(competingImages(run(9600, [{ phase: "TTFB", ms: 500 }, { phase: "Load Delay", ms: 9000 }, { phase: "Load Time", ms: 100 }])).length).toBe(3));
  it("Lighthouse 13 (observed phases): a simulated LCP far above their total", () => {
    const observed = [{ phase: "TTFB", ms: 180 }, { phase: "Load Delay", ms: 15 }, { phase: "Load Time", ms: 290 }, { phase: "Render Delay", ms: 40 }];
    expect(competingImages(run(12_000, observed)).length).toBe(3);
    expect(competingImages(run(2_000, observed))).toEqual([]);          // fast page: nothing to investigate
    expect(competingImages(run(2_400, observed))).toEqual([]);          // below the 2.5 s threshold
  });
});
