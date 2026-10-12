import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runFromLhr, type Lhr } from "../packages/browser-audit/src/lighthouse.js";
import { exactFixes } from "../packages/reports/src/exact-fixes.js";

// REAL Lighthouse results for the same page (trimmed to the audits we read): Lighthouse 13.5.0 (what PageSpeed Insights runs) and 12.8.2.
// Lighthouse 13 replaced several audits with "insights" and cuts long attribute values in element snippets: the extraction must cope with both.
const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as Lhr;
const lh13 = () => runFromLhr(load("lighthouse-13.5-staging.json")), lh12 = () => runFromLhr(load("lighthouse-12.8-staging.json"));

describe("Lighthouse 13.5 (PageSpeed Insights' version)", () => {
  it("reads scores, metrics and the host CPU benchmark", () => {
    const r = lh13();
    expect(r.ok).toBe(true); expect(r.scores.performance).toBeGreaterThan(0); expect(r.metrics.lcpMs).toBeGreaterThan(0); expect(r.metrics.fcpMs).toBeGreaterThan(0);
    expect(r.benchmarkIndex).toBeGreaterThan(500);
  });
  it("reads the LCP phases from lcp-breakdown-insight, with Lighthouse 12's names", () => {
    const r = lh13();
    expect(r.lcpPhases!.map((p) => p.phase)).toEqual(["TTFB", "Load Delay", "Load Time", "Render Delay"]);
    expect(r.lcpPhases!.every((p) => p.ms >= 0)).toBe(true);
  });
  it("reads the LCP element, and Lighthouse's own discovery verdict (fetchpriority / eager / discoverable)", () => {
    const r = lh13(), el = r.evidence["largest-contentful-paint-element"]![0]!;
    expect(el.selector).toContain("wp-block-cover__image-background"); expect(el.snippet).toContain("fetchpriority");
    expect(el.displayWidth).toBeGreaterThan(0);
    expect(r.lcpDiscovery).toEqual({ priorityHinted: true, requestDiscoverable: true, eagerlyLoaded: true });
  });
  it("maps the image, render-blocking and font insights onto the evidence the fixes use", () => {
    const r = lh13(), imgs = r.evidence["modern-image-formats"]!;
    expect(imgs.length).toBeGreaterThan(3); expect(imgs[0]!.url).toMatch(/^https:\/\//); expect(imgs[0]!.wastedBytes).toBeGreaterThan(0);
    expect(imgs.some((i) => i.displayWidth !== undefined)).toBe(true);
    expect(r.evidence["render-blocking-resources"]!.length).toBeGreaterThan(0);
  });
  it("lists insights as opportunities (by estimated LCP/FCP savings) and diagnostics", () => {
    const r = lh13();
    expect(r.opportunities[0]).toMatchObject({ id: "image-delivery-insight" }); expect(r.opportunities[0]!.savingsMs).toBeGreaterThan(500);
    expect(r.diagnostics!.map((d) => d.id)).toEqual(expect.arrayContaining(["image-delivery-insight"]));
    expect(r.passedAudits).toBeGreaterThan(10);
  });
  it("the fixes work from Lighthouse 13 data: truncated snippet URLs are not mistaken for a different element, and the hero's applied fixes are recognised", () => {
    const r = lh13(), url = "https://geokon-staging.mystagingwebsite.com/";
    const g = exactFixes({ pageUrl: url, evidence: r.evidence, lcpPhases: r.lcpPhases, lcpDiscovery: r.lcpDiscovery, metrics: { lcpMs: r.metrics.lcpMs ?? undefined, fcpMs: 3000 }, viewportWidth: 412 }).map((x) => x.area);
    expect(g).toContain("Images (LCP, Speed Index, page weight)");
    const lcp = exactFixes({ pageUrl: url, evidence: r.evidence, lcpPhases: r.lcpPhases, lcpDiscovery: r.lcpDiscovery, metrics: { lcpMs: 3000 }, preloads: [] }).find((x) => x.area.startsWith("LCP"));
    expect(lcp?.note ?? "").not.toMatch(/different LCP element/);
    expect(lcp?.applied).toContain('fetchpriority="high" is set on the LCP image');       // from Lighthouse's own flag, although the snippet's URLs are cut off
    expect(lcp?.applied).toContain("The LCP image is not lazy-loaded");
  });
});

describe("Lighthouse 12.8 results still work", () => {
  it("reads phases, LCP element, evidence and diagnostics from the Lighthouse 12 audit names", () => {
    const r = lh12();
    expect(r.ok).toBe(true); expect(r.lcpPhases!.map((p) => p.phase)).toEqual(["TTFB", "Load Delay", "Load Time", "Render Delay"]);
    expect(r.evidence["largest-contentful-paint-element"]![0]!.snippet).toContain("<img");
    expect(r.evidence["modern-image-formats"]!.length).toBeGreaterThan(3);
    expect(r.diagnostics!.map((d) => d.id)).toContain("uses-responsive-images");              // a Lighthouse 12 audit name is listed as a diagnostic
    expect(r.opportunities).toEqual([]);                                                   // this page's image savings are in bytes, not milliseconds: no time-based opportunity
  });
});

describe("a Lighthouse failure is reported, not hidden", () => {
  it("a runtime error marks the run as failed with its code", () => {
    const r = runFromLhr({ ...load("lighthouse-13.5-staging.json"), runtimeError: { code: "NO_FCP" } });
    expect(r.ok).toBe(false); expect(r.error).toBe("Lighthouse: NO_FCP");
  });
});
