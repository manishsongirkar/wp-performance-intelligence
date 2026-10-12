import { chromium } from "playwright";
import lighthouse from "lighthouse";
import { ReportGenerator } from "lighthouse/report/generator/report-generator.js";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import { createServer } from "node:net";
import { validateDestination, SafeFetchError, type NetworkPolicy, type Resolver } from "../../safe-fetch/src/index.js";
import { median } from "./measure.js";
import type { EvidenceItem, LighthouseExperiment, BrowserProfileName, LighthouseMeasurement, LighthouseRun, MetricSummary } from "../../contracts/src/types.js";

export interface LighthouseOptions { policy: NetworkPolicy; profile?: BrowserProfileName; runs?: number; resolve?: Resolver; /** Run one extra what-if pass when the evidence points at competing images (adds ~10 s per URL). */ whatIf?: boolean; /** Also return Lighthouse's own standalone HTML report for each run. */ keepReports?: boolean }

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});
const pct = (n: number | null | undefined) => (typeof n === "number" ? Math.round(n * 100) : null);
const r1 = (n: number | null | undefined) => (typeof n === "number" ? Math.round(n * 10) / 10 : null);

// Audits whose item lists drive exact fixes. "table" audits (no score penalty) are kept when they list items.
// Informational table audits that carry evidence even though they "pass".
const ALWAYS_KEEP = new Set(["long-tasks", "bootup-time", "network-requests"]);
const EVIDENCE_AUDITS = ["unused-css-rules", "unused-javascript", "render-blocking-resources", "modern-image-formats", "uses-responsive-images", "uses-optimized-images",
  "offscreen-images", "unminified-css", "unminified-javascript", "font-display", "unsized-images", "long-tasks", "bootup-time", "server-response-time", "prioritize-lcp-image", "uses-rel-preconnect", "largest-contentful-paint-element", "network-requests"];
const cut = (v: unknown, n = 300) => (typeof v === "string" ? v.slice(0, n) : undefined);
const numOrU = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined);

type RawItem = { url?: unknown; node?: { selector?: unknown; snippet?: unknown; boundingRect?: { width?: unknown; height?: unknown } }; transferSize?: unknown; resourceType?: unknown; priority?: unknown; totalBytes?: unknown; wastedBytes?: unknown; wastedMs?: unknown; duration?: unknown; scripting?: unknown; responseTime?: unknown; items?: RawItem[] };
function toEvidence(id: string, items: RawItem[]): EvidenceItem[] {
  // The LCP audit nests its element inside a list of tables.
  let flat = id === "largest-contentful-paint-element" ? items.flatMap((i) => i.items ?? []).filter((i) => i.node).slice(0, 1) : items;
  // The heaviest requests are what compete with the LCP image for bandwidth.
  if (id === "network-requests") flat = [...flat].sort((a, b) => Number(b.transferSize ?? 0) - Number(a.transferSize ?? 0));
  return flat.slice(0, 10).map((i) => ({
    url: cut(i.url), selector: cut(i.node?.selector), snippet: cut(i.node?.snippet, 400),
    totalBytes: numOrU(i.totalBytes ?? i.transferSize), resourceType: cut(i.resourceType, 30), priority: cut(i.priority, 20), displayWidth: numOrU(i.node?.boundingRect?.width), displayHeight: numOrU(i.node?.boundingRect?.height), wastedBytes: numOrU(i.wastedBytes), wastedMs: numOrU(i.wastedMs ?? i.responseTime),
    durationMs: numOrU(i.duration), scriptingMs: numOrU(i.scripting)
  } as EvidenceItem)).map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as EvidenceItem)
    .filter((e) => Object.keys(e).length);
}

const EMPTY: LighthouseRun = {
  ok: false, scores: { performance: null, accessibility: null, bestPractices: null, seo: null },
  metrics: { fcpMs: null, lcpMs: null, tbtMs: null, cls: null, speedIndexMs: null, ttiMs: null }, opportunities: [], runWarnings: [], evidence: {}
};

function lcpPhases(details: unknown): Array<{ phase: string; ms: number }> | undefined {
  const tables = (details as { items?: Array<{ items?: Array<{ phase?: unknown; timing?: unknown }> }> } | undefined)?.items ?? [];
  const phases = tables.flatMap((t) => t.items ?? []).filter((i) => typeof i.phase === "string" && typeof i.timing === "number").map((i) => ({ phase: String(i.phase), ms: Math.round(Number(i.timing)) }));
  return phases.length ? phases : undefined;
}

/** When Load Delay dominates LCP and several heavy images load at the same time, pick them for the what-if run. */
export function competingImages(run: LighthouseRun): string[] {
  const phases = run.lcpPhases ?? [], total = phases.reduce((a, p) => a + p.ms, 0);
  const delay = phases.find((p) => p.phase === "Load Delay")?.ms ?? 0;
  if (!total || delay / total < 0.5) return [];
  const lcp = run.evidence["largest-contentful-paint-element"]?.[0], src = /\ssrc=["']([^"']+)["']/.exec(lcp?.snippet ?? "")?.[1];
  const lcpPath = (() => { try { return src ? new URL(src, "https://x.invalid").pathname : ""; } catch { return ""; } })();
  const heavy = (run.evidence["network-requests"] ?? []).filter((r) => r.url && r.resourceType === "Image" && (r.totalBytes ?? 0) > 100 * 1024 && (() => { try { return new URL(r.url!).pathname !== lcpPath; } catch { return false; } })());
  return heavy.length >= 2 ? heavy.slice(0, 8).map((r) => r.url!) : [];
}

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
  const experiments: LighthouseExperiment[] = [];
  let version = "";
  let throttlingMethod = "";
  let settings: NonNullable<LighthouseMeasurement["metadata"]["settings"]> | undefined;
  try {
    for (let i = 0; i < runCount; i++) {
      try {
        // Lighthouse defaults are what PageSpeed Insights uses for its lab run: mobile = Moto G Power emulation, simulated slow 4G (RTT 150 ms, 1.6 Mbps) and 4x CPU slowdown; desktop = the desktop preset. Set explicitly so a change of defaults cannot silently drift us away from PSI.
        const flags = { port, output: "json" as const, logLevel: "error" as const, throttlingMethod: "simulate" as const, onlyCategories: ["performance", "accessibility", "best-practices", "seo"] };
        const result = await lighthouse(url, flags, profile === "desktop" ? desktopConfig : undefined);
        const lhr = result?.lhr;
        if (!lhr) throw new Error("no result");
        version = lhr.lighthouseVersion; throttlingMethod = lhr.configSettings.throttlingMethod; finalUrl = lhr.finalDisplayedUrl;
        const cs = lhr.configSettings;
        settings = { rttMs: cs.throttling?.rttMs, throughputKbps: cs.throttling?.throughputKbps, cpuSlowdownMultiplier: cs.throttling?.cpuSlowdownMultiplier, screenWidth: cs.screenEmulation?.width, screenHeight: cs.screenEmulation?.height, deviceScaleFactor: cs.screenEmulation?.deviceScaleFactor, userAgent: cs.emulatedUserAgent ? String(cs.emulatedUserAgent).slice(0, 200) : undefined };
        const refs = lhr.categories.performance?.auditRefs ?? [];
        const diagnostics = refs.filter((r) => r.group === "diagnostics").map((r) => lhr.audits[r.id]).filter((a) => a && a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "notApplicable")
          .map((a) => ({ id: a!.id, title: a!.title, displayValue: a!.displayValue ? String(a!.displayValue).slice(0, 80) : undefined, score: a!.score })).slice(0, 12);
        const passedAudits = refs.filter((r) => r.group !== "metrics" && lhr.audits[r.id]?.score !== null && (lhr.audits[r.id]?.score ?? 0) >= 0.9).length;
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
          runWarnings: (lhr.runWarnings ?? []).map(String).slice(0, 5), diagnostics, passedAudits, lcpPhases: lcpPhases(lhr.audits["largest-contentful-paint-element"]?.details),
          evidence: Object.fromEntries(EVIDENCE_AUDITS.flatMap((id) => {
            const a = lhr.audits[id]; const items = (a?.details as { items?: RawItem[] } | undefined)?.items;
            if (!a || !items?.length || (a.score === 1 && !ALWAYS_KEEP.has(id))) return [];
            const ev = toEvidence(id, items); return ev.length ? [[id, ev]] : [];
          }))
        });
      } catch { runs.push({ ...EMPTY, error: "Lighthouse run failed." }); }
    }
    if (options.whatIf) {
      const first = runs.find((r) => r.ok), blocked = first ? competingImages(first) : [];
      if (blocked.length) {
        try {
          const flags = { port, output: "json" as const, logLevel: "error" as const, throttlingMethod: "simulate" as const, blockedUrlPatterns: blocked, onlyCategories: ["performance"] };
          const lhr = (await lighthouse(url, flags, profile === "desktop" ? desktopConfig : undefined))?.lhr;
          const sum = summarizeLighthouse(runs);
          if (lhr && !lhr.runtimeError) experiments.push({
            id: "block-competing-images", blocked, lcpMs: r1(lhr.audits["largest-contentful-paint"]?.numericValue), performanceScore: pct(lhr.categories.performance?.score),
            baselineLcpMs: sum.lcpMs?.median ?? null, baselinePerformance: sum.performanceScore?.median ?? null,
            description: `What-if: the same page measured with ${blocked.length} other heavy images blocked, to test whether they delay the LCP image. This is an experiment, not a fix.`
          });
        } catch { /* the experiment is optional */ }
      }
    }
  } finally { await browser.close(); }

  const ok = runs.filter((r) => r.ok).length;
  return {
    schemaVersion: "1.0.0", source: "lab", engine: "lighthouse", url, finalUrl, measuredAt: new Date().toISOString(), profile,
    status: ok === runs.length ? "complete" : ok ? "partial" : "failed",
    metadata: { lighthouseVersion: version, browser: `chromium ${browser.version?.() ?? ""}`.trim(), throttlingMethod, formFactor: profile, runs: runCount, settings },
    runs, summary: summarizeLighthouse(runs), ...(experiments.length ? { experiments } : {}), ...(options.keepReports ? { htmlReports } : {}),
    limitations: [
      "Lab data from Lighthouse with simulated throttling on this machine; it is not field Core Web Vitals (CrUX/RUM).",
      "Scores vary between runs. Compare medians of several runs, never a single run.",
      "The browser resolves DNS itself and subrequests are not policy-checked, so this runs in local mode only."
    ]
  };
}
