import { describe, expect, it } from "vitest";
import { renderHtmlReport } from "../packages/reports/src/html.js";
import type { LighthouseMeasurement } from "../packages/contracts/src/types.js";

// The Lighthouse section mirrors PageSpeed Insights' layout and test conditions (run locally; no Google API is called).
const lh = (url: string): LighthouseMeasurement => ({
  schemaVersion: "1.0.0", source: "lab", engine: "lighthouse", url, finalUrl: null, measuredAt: "x", profile: "mobile", status: "complete",
  metadata: { lighthouseVersion: "12.8.2", browser: "chromium", throttlingMethod: "simulate", formFactor: "mobile", runs: 1, settings: { rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier: 4, screenWidth: 412, screenHeight: 823 } },
  runs: [{ ok: true, scores: { performance: 72, accessibility: 99, bestPractices: 100, seo: 66 }, metrics: { fcpMs: 1, lcpMs: 2, tbtMs: 3, cls: 0, speedIndexMs: 4, ttiMs: 5 }, opportunities: [], runWarnings: [], evidence: {},
    diagnostics: [{ id: "dom-size", title: "Avoid an excessive DOM size", displayValue: "1,168 elements", score: 0.5 }], passedAudits: 31 }],
  summary: { performanceScore: { median: 72, min: 72, max: 72, samples: 1 }, lcpMs: { median: 12600, min: 1, max: 2, samples: 1 } }, limitations: []
});
const render = (url: string) => renderHtmlReport({ audits: [], comparisons: [], measurements: [], lighthouse: [{ measurement: lh(url), reportFiles: [] }] });

describe("report: PageSpeed-Insights-style Lighthouse section", () => {
  it("shows the test conditions, diagnostics and passed-audit count, and no TTI card", () => {
    const html = render("https://shop.example/");
    expect(html).toContain("RTT 150 ms, 1638.4 Kbps, CPU 4× slower, screen 412×823");
    expect(html).toContain("same conditions PageSpeed Insights uses");
    expect(html).toContain("Avoid an excessive DOM size"); expect(html).toContain("31 passed audits");
    expect(html).not.toContain("Time to Interactive");
  });
  it("contains no Google PageSpeed Insights API panel, flag or setting", () => {
    const html = render("https://shop.example/");
    expect(html).not.toMatch(/--psi|WPI_PSI|Core Web Vitals assessment|quota|Also compare with Google/i);
  });
});

describe("run-to-run spread and the PageSpeed comparison", () => {
  const withScores = (min: number, max: number, median: number, bench?: number, runs = 3) => {
    const m = lh("https://shop.example/");
    m.summary.performanceScore = { median, min, max, samples: runs };
    m.runs = Array.from({ length: runs }, () => m.runs[0]!);
    if (bench) m.metadata.benchmarkIndex = bench;
    return renderHtmlReport({ audits: [], comparisons: [], measurements: [], lighthouse: [{ measurement: m, reportFiles: [] }] });
  };
  it("shows the lowest–highest score under the gauge when runs differ", () => {
    expect(withScores(83, 95, 85)).toContain(">83–95</span>");
    expect(withScores(72, 72, 72)).not.toContain("72–72");
  });
  it("warns when Performance varied by 10+ points over several runs, with the real numbers", () => {
    const html = withScores(83, 95, 85);
    expect(html).toContain("Scores vary between runs"); expect(html).toContain("ranged from 83 to 95 over 3 runs (median 85)"); expect(html).toContain("PageSpeed Insights tests once");
    expect(withScores(90, 99, 95)).not.toContain("Scores vary between runs");            // 9 points: normal noise
    expect(withScores(40, 90, 70, undefined, 1)).not.toContain("Scores vary between runs");   // a single run has no spread to warn about
  });
  it("explains the differences from pagespeed.web.dev, including how fast this machine is", () => {
    const html = withScores(70, 72, 71, 3800);
    expect(html).toContain("Why can this differ from pagespeed.web.dev?"); expect(html).toContain("One run vs a median"); expect(html).toContain("Lighthouse 12.8.2");
    expect(html).toContain("CPU benchmark is 3800"); expect(html).toContain("500–900"); expect(html).toContain("JavaScript-heavy pages usually look better here");
    expect(withScores(70, 72, 71, 700)).not.toContain("usually look better here");
  });
});

describe("before/after deltas ignore noise in either run set", () => {
  it("a score or metric whose old median lies inside the NEW runs' range is not called a change", async () => {
    const { deltaInfo } = await import("../packages/reports/src/html.js");
    const s = (median: number, min: number, max: number) => ({ median, min, max, samples: 3 });
    expect(deltaInfo("speedIndexMs", s(4100, 1220, 5400), s(3650, 3600, 3700))?.cls).toBe("flat");    // new runs ranged 1.2–5.4 s: 3.65 s is within it
    expect(deltaInfo("speedIndexMs", s(4100, 4000, 4200), s(3650, 3600, 3700))?.cls).toBe("bad");     // tight runs on both sides: a real regression
    expect(deltaInfo("performanceScore", s(95, 94, 96), s(80, 78, 82))).toMatchObject({ cls: "good" });
  });
});
