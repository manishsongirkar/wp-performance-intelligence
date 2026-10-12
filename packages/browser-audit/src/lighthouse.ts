import { chromium } from "playwright";
import lighthouse from "lighthouse";
import { ReportGenerator } from "lighthouse/report/generator/report-generator.js";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import { createServer } from "node:net";
import { validateDestination, SafeFetchError, type NetworkPolicy, type Resolver } from "../../safe-fetch/src/index.js";
import { median } from "./measure.js";
import type { BrowserProfileName, LighthouseMeasurement, LighthouseRun, MetricSummary } from "../../contracts/src/types.js";

export interface LighthouseOptions { policy: NetworkPolicy; profile?: BrowserProfileName; runs?: number; resolve?: Resolver; /** Also return Lighthouse's own standalone HTML report for each run. */ keepReports?: boolean }

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});
const pct = (n: number | null | undefined) => (typeof n === "number" ? Math.round(n * 100) : null);
const r1 = (n: number | null | undefined) => (typeof n === "number" ? Math.round(n * 10) / 10 : null);

const EMPTY: LighthouseRun = {
  ok: false, scores: { performance: null, accessibility: null, bestPractices: null, seo: null },
  metrics: { fcpMs: null, lcpMs: null, tbtMs: null, cls: null, speedIndexMs: null, ttiMs: null }, opportunities: [], runWarnings: []
};

export function summarizeLighthouse(runs: LighthouseRun[]): Record<string, MetricSummary> {
  const ok = runs.filter((r) => r.ok);
  const series: Record<string, Array<number | null>> = {
    performanceScore: ok.map((r) => r.scores.performance), accessibilityScore: ok.map((r) => r.scores.accessibility),
    bestPracticesScore: ok.map((r) => r.scores.bestPractices), seoScore: ok.map((r) => r.scores.seo),
    ...Object.fromEntries((Object.keys(EMPTY.metrics) as Array<keyof LighthouseRun["metrics"]>).map((k) => [k, ok.map((r) => r.metrics[k])]))
  };
  const out: Record<string, MetricSummary> = {};
  for (const [k, raw] of Object.entries(series)) {
    const v = raw.filter((x): x is number => typeof x === "number");
    if (v.length) out[k] = { median: Math.round(median(v) * 1000) / 1000, min: Math.min(...v), max: Math.max(...v), samples: v.length };
  }
  return out;
}

/**
 * Runs Lighthouse against Playwright's Chromium over its debugging port. Like measurePage, the browser
 * resolves DNS itself (no address pinning, no per-request policy), so callers must restrict this to local mode.
 */
export async function runLighthouse(url: string, options: LighthouseOptions): Promise<LighthouseMeasurement> {
  const { policy, profile = "mobile", runs: runCount = 1, resolve } = options;
  await validateDestination(new URL(url), policy, resolve).catch((e) => { throw e instanceof SafeFetchError ? e : new SafeFetchError("INVALID_URL", "Malformed URL."); });

  const port = await freePort();
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const runs: LighthouseRun[] = [];
  let finalUrl: string | null = null;
  const htmlReports: string[] = [];
  let version = "";
  let throttlingMethod = "";
  try {
    for (let i = 0; i < runCount; i++) {
      try {
        const flags = { port, output: "json" as const, logLevel: "error" as const, onlyCategories: ["performance", "accessibility", "best-practices", "seo"] };
        const result = await lighthouse(url, flags, profile === "desktop" ? desktopConfig : undefined);
        const lhr = result?.lhr;
        if (!lhr) throw new Error("no result");
        version = lhr.lighthouseVersion; throttlingMethod = lhr.configSettings.throttlingMethod; finalUrl = lhr.finalDisplayedUrl;
        if (options.keepReports) htmlReports.push(ReportGenerator.generateReportHtml(lhr));
        const num = (id: string) => r1(lhr.audits[id]?.numericValue);
        const fatal = lhr.runtimeError;
        runs.push({
          ok: !fatal, ...(fatal ? { error: `Lighthouse: ${fatal.code}` } : {}),
          scores: { performance: pct(lhr.categories.performance?.score), accessibility: pct(lhr.categories.accessibility?.score), bestPractices: pct(lhr.categories["best-practices"]?.score), seo: pct(lhr.categories.seo?.score) },
          metrics: { fcpMs: num("first-contentful-paint"), lcpMs: num("largest-contentful-paint"), tbtMs: num("total-blocking-time"), cls: lhr.audits["cumulative-layout-shift"]?.numericValue ?? null, speedIndexMs: num("speed-index"), ttiMs: num("interactive") },
          opportunities: Object.values(lhr.audits)
            .filter((a) => a.score !== null && a.score < 0.9) // passing audits are not opportunities
            .map((a) => ({ id: a.id, title: a.title, savingsMs: Math.round((a.details as { overallSavingsMs?: number } | undefined)?.overallSavingsMs ?? 0) }))
            .filter((o) => o.savingsMs > 0).sort((a, b) => b.savingsMs - a.savingsMs).slice(0, 5),
          runWarnings: (lhr.runWarnings ?? []).map(String).slice(0, 5)
        });
      } catch { runs.push({ ...EMPTY, error: "Lighthouse run failed." }); }
    }
  } finally { await browser.close(); }

  const ok = runs.filter((r) => r.ok).length;
  return {
    schemaVersion: "1.0.0", source: "lab", engine: "lighthouse", url, finalUrl, measuredAt: new Date().toISOString(), profile,
    status: ok === runs.length ? "complete" : ok ? "partial" : "failed",
    metadata: { lighthouseVersion: version, browser: `chromium ${browser.version?.() ?? ""}`.trim(), throttlingMethod, formFactor: profile, runs: runCount },
    runs, summary: summarizeLighthouse(runs), ...(options.keepReports ? { htmlReports } : {}),
    limitations: [
      "Lab data from Lighthouse with simulated throttling on this machine; it is not field Core Web Vitals (CrUX/RUM).",
      "Scores vary between runs. Compare medians of several runs, never a single run.",
      "The browser resolves DNS itself and subrequests are not policy-checked, so this runs in local mode only."
    ]
  };
}
