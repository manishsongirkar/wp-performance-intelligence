import { describe, expect, it } from "vitest";
import { fetchPsi, isPsiTestable } from "../packages/browser-audit/src/psi.js";
import { generateReport, planSteps, type ReportRequest } from "../apps/api/src/report.js";
import { renderHtmlReport } from "../packages/reports/src/html.js";
import { loadConfig } from "../apps/api/src/config.js";
import type { LighthouseMeasurement, PsiResult } from "../packages/contracts/src/types.js";
import type { Resolver, Transport } from "../packages/safe-fetch/src/index.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const resolve: Resolver = async (h) => ({ "www.googleapis.com": ["142.250.80.10"], "shop.example": ["93.184.216.34"], "lan.example": ["10.0.0.5"] }[h] ?? (() => { throw new Error("nx"); })()).map((address) => ({ address, family: 4 }));

// Shaped like the PageSpeed Insights v5 response documented at developers.google.com/speed/docs/insights/v5/reference
const psiBody = (over: Record<string, unknown> = {}) => JSON.stringify({
  loadingExperience: { overall_category: "AVERAGE", metrics: {
    LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3100, category: "AVERAGE" }, INTERACTION_TO_NEXT_PAINT: { percentile: 150, category: "FAST" },
    CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: "FAST" }, FIRST_CONTENTFUL_PAINT_MS: { percentile: 1700, category: "FAST" }, EXPERIMENTAL_TIME_TO_FIRST_BYTE: { percentile: 700, category: "FAST" } } },
  originLoadingExperience: { overall_category: "FAST", metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2000, category: "FAST" } } },
  lighthouseResult: {
    lighthouseVersion: "12.6.0", finalDisplayedUrl: "https://shop.example/",
    categories: { performance: { score: 0.81 }, accessibility: { score: 0.99 }, "best-practices": { score: 1 }, seo: { score: 0.92 } },
    audits: {
      "first-contentful-paint": { numericValue: 1234.56 }, "largest-contentful-paint": { numericValue: 3456.78 }, "total-blocking-time": { numericValue: 120 }, "cumulative-layout-shift": { numericValue: 0.04 }, "speed-index": { numericValue: 2500 },
      "modern-image-formats": { id: "modern-image-formats", title: "Serve images in next-gen formats", score: 0.3, details: { type: "opportunity", overallSavingsMs: 450 } },
      "server-response-time": { id: "server-response-time", title: "Fast", score: 1, details: { type: "opportunity", overallSavingsMs: 20 } }
    }
  }, ...over
});
const serve = (status: number, body: string, calls: string[] = []): Transport => async ({ url }) => { calls.push(url.href); return { status, headers: { "content-type": "application/json" }, destroy() {}, body: (async function* () { yield Buffer.from(body); })() }; };

describe("fetchPsi", () => {
  it("maps lab scores/metrics, field data (CLS is reported x100), and failing opportunities only", async () => {
    const calls: string[] = [];
    const r = await fetchPsi("https://shop.example/", { strategy: "mobile", apiKey: "K", resolve, transport: serve(200, psiBody(), calls) });
    expect(calls[0]).toContain("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?");
    expect(calls[0]).toContain("strategy=mobile"); expect(calls[0]).toContain("category=best-practices"); expect(calls[0]).toContain("key=K");
    expect(r.scores).toEqual({ performance: 81, accessibility: 99, bestPractices: 100, seo: 92 });
    expect(r.metrics).toEqual({ fcpMs: 1234.6, lcpMs: 3456.8, tbtMs: 120, cls: 0.04, speedIndexMs: 2500 });
    expect(r.field).toMatchObject({ scope: "url", overall: "AVERAGE", metrics: { lcpMs: { p75: 3100, category: "AVERAGE" }, inpMs: { p75: 150 }, cls: { p75: 0.05 } } });
    expect(r.opportunities).toEqual([{ id: "modern-image-formats", title: "Serve images in next-gen formats", savingsMs: 450 }]);
  });
  it("falls back to origin field data, or none", async () => {
    const origin = await fetchPsi("https://shop.example/", { resolve, transport: serve(200, psiBody({ loadingExperience: { metrics: {} } })) });
    expect(origin.field).toMatchObject({ scope: "origin", overall: "FAST" });
    const none = await fetchPsi("https://shop.example/", { resolve, transport: serve(200, psiBody({ loadingExperience: {}, originLoadingExperience: {} })) });
    expect(none.field).toBeNull();
  });
  it("gives clear errors for quota, HTTP errors and junk", async () => {
    const run = (status: number, body: string) => fetchPsi("https://shop.example/", { resolve, transport: serve(status, body) }).then(() => "ok", (e) => `${e.code}: ${e.message}`);
    expect(await run(429, "{}")).toMatch(/BUSY: .*quota.*WPI_PSI_API_KEY/);
    expect(await run(500, "{}")).toMatch(/NETWORK: .*HTTP 500/);
    expect(await run(200, "<html>")).toMatch(/NETWORK: .*unreadable/);
    expect(await run(200, "{}")).toMatch(/NETWORK: .*no Lighthouse result/);
  });
  it("never contacts Google for local/private URLs", async () => {
    const calls: string[] = [];
    for (const u of ["https://lan.example/", "http://127.0.0.1/", "https://mysite.test/"])
      await expect(fetchPsi(u, { resolve, transport: serve(200, psiBody(), calls) }), u).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
    expect(calls).toEqual([]);
    expect(await isPsiTestable("https://shop.example/", resolve)).toBe(true);
    expect(await isPsiTestable("https://lan.example/", resolve)).toBe(false);
  });
});

const lh = (url: string): LighthouseMeasurement => ({
  schemaVersion: "1.0.0", source: "lab", engine: "lighthouse", url, finalUrl: null, measuredAt: "x", profile: "mobile", status: "complete",
  metadata: { lighthouseVersion: "12.8.2", browser: "chromium", throttlingMethod: "simulate", formFactor: "mobile", runs: 1, settings: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4, screenWidth: 412, screenHeight: 823 } },
  runs: [{ ok: true, scores: { performance: 72, accessibility: 99, bestPractices: 100, seo: 66 }, metrics: { fcpMs: 1, lcpMs: 2, tbtMs: 3, cls: 0, speedIndexMs: 4, ttiMs: 5 }, opportunities: [], runWarnings: [], evidence: {},
    diagnostics: [{ id: "dom-size", title: "Avoid an excessive DOM size", displayValue: "1,168 elements", score: 0.5 }], passedAudits: 31 }],
  summary: { performanceScore: { median: 72, min: 72, max: 72, samples: 1 }, lcpMs: { median: 12600, min: 1, max: 2, samples: 1 } }, limitations: []
});
const render = (url: string, psi?: Record<string, { result?: PsiResult; error?: string }>) =>
  renderHtmlReport({ audits: [], comparisons: [], measurements: [], lighthouse: [{ measurement: lh(url), reportFiles: [] }], psi });

describe("report: PageSpeed Insights alignment", () => {
  it("shows the PSI-equivalent test conditions, diagnostics and passed-audit count, and no TTI card", () => {
    const html = render("https://shop.example/");
    expect(html).toContain("RTT 150 ms, 1638.4 Kbps, CPU 4× slower, screen 412×823");
    expect(html).toContain("same conditions PageSpeed Insights uses");
    expect(html).toContain("Avoid an excessive DOM size"); expect(html).toContain("31 passed audits");
    expect(html).not.toContain("Time to Interactive");
    expect(html).toContain("--psi");                                            // public URL: how to enable
  });
  it("explains that local URLs cannot be tested by PSI", () => expect(render("https://geokon.test/")).toContain("cannot test local or private URLs"));
  it("renders Google's field data and the lab comparison", async () => {
    const result = await fetchPsi("https://shop.example/", { resolve, transport: serve(200, psiBody()) });
    const html = render("https://shop.example/", { "https://shop.example/": { result } });
    expect(html).toContain("Core Web Vitals assessment"); expect(html).toContain("Not passed");   // LCP is AVERAGE
    expect(html).toContain("This tool (median)"); expect(html).toContain("Lighthouse 12.6.0");
    expect(html).toContain("Expect differences");
    expect(render("https://shop.example/", { "https://shop.example/": { error: "PageSpeed Insights quota exceeded." } })).toContain("quota exceeded");
  });
});

describe("generateReport with PSI", () => {
  const stubs = (calls: string[]) => ({
    auditPage: (async () => { throw new Error("no html"); }) as never, measurePage: (async () => { throw new Error("n/a"); }) as never,
    runLighthouse: (async (url: string) => ({ ...lh(url), htmlReports: [] })) as never,
    fetchPsi: (async (url: string) => { calls.push(url); return { strategy: "mobile", fetchedAt: "x", lighthouseVersion: "12", finalUrl: url, scores: {}, metrics: {}, field: null, opportunities: [] }; }) as never
  });
  it("adds one pagespeed step per Lighthouse URL only when requested", () => {
    const base: ReportRequest = { audits: [], compares: [], measures: [], lighthouse: ["https://a.example/"], runs: 1, profile: "mobile", outDir: "/tmp" };
    expect(planSteps(base)).toEqual(["lighthouse https://a.example/"]);
    expect(planSteps({ ...base, psi: true })).toEqual(["lighthouse https://a.example/", "pagespeed insights https://a.example/"]);
  });
  it("queries Google for public URLs, and records (not fails) a note for local ones", async () => {
    const calls: string[] = []; const out = await mkdtemp(join(tmpdir(), "wpi-psi-"));
    const r = await generateReport({ audits: [], compares: [], measures: [], lighthouse: ["https://example.com/", "https://mysite.test/"], runs: 1, profile: "mobile", psi: true, outDir: out },
      loadConfig({ WPI_MODE: "local" }).fetch, { deps: stubs(calls) });
    expect(calls).toEqual(["https://example.com/"]);
    expect(r.failures).toEqual([]);
    const data = JSON.parse(await readFile(join(r.dir, "data.json"), "utf8"));
    expect(data.psi["https://example.com/"].result).toBeTruthy();
    expect(data.psi["https://mysite.test/"].error).toMatch(/local or private/);
    expect(JSON.parse(await readFile(join(r.dir, "data.json"), "utf8")).rerunCommand).toContain("--psi");
  });
});
