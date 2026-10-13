import { chromium } from "playwright";
import lighthouse from "lighthouse";
import { ReportGenerator } from "lighthouse/report/generator/report-generator.js";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import { createServer } from "node:net";
import { validateDestination, SafeFetchError, type NetworkPolicy, type Resolver } from "../../safe-fetch/src/index.js";
import { median } from "./measure.js";
import { parseSrcset } from "../../audit-core/src/srcset.js";
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
const ALWAYS_KEEP = new Set(["long-tasks", "bootup-time", "network-requests", "largest-contentful-paint-element"]);
const EVIDENCE_AUDITS = ["unused-css-rules", "unused-javascript", "render-blocking-resources", "modern-image-formats", "uses-responsive-images", "uses-optimized-images",
  "offscreen-images", "unminified-css", "unminified-javascript", "font-display", "unsized-images", "long-tasks", "bootup-time", "server-response-time", "prioritize-lcp-image", "uses-rel-preconnect", "largest-contentful-paint-element", "network-requests", "layout-shifts"];
const cut = (v: unknown, n = 300) => (typeof v === "string" ? v.slice(0, n) : undefined);
const numOrU = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10) / 10 : undefined);

export type RawItem = { url?: unknown; node?: { selector?: unknown; snippet?: unknown; boundingRect?: { width?: unknown; height?: unknown } }; transferSize?: unknown; resourceType?: unknown; priority?: unknown; totalBytes?: unknown; wastedBytes?: unknown; wastedMs?: unknown; duration?: unknown; scripting?: unknown; responseTime?: unknown; items?: RawItem[] };
export function toEvidence(id: string, items: RawItem[]): EvidenceItem[] {
  // The LCP audit nests its element inside a list of tables.
  let flat = id === "largest-contentful-paint-element" ? items.flatMap((i) => i.items ?? []).filter((i) => i.node).slice(0, 1) : items;
  // The heaviest requests are what compete with the LCP image for bandwidth.
  if (id === "network-requests") {
    // Images are what competes with an LCP image; keep them even when a few big scripts or videos outweigh them.
    const sorted = [...flat].sort((a, b) => Number(b.transferSize ?? 0) - Number(a.transferSize ?? 0));
    flat = [...sorted.filter((i) => i.resourceType === "Image").slice(0, 8), ...sorted.filter((i) => i.resourceType !== "Image").slice(0, 4)];
  }
  return flat.slice(0, 12).map((i) => ({
    url: cut(i.url), selector: cut(i.node?.selector), snippet: cut(i.node?.snippet, 1500),
    totalBytes: numOrU(i.totalBytes ?? i.transferSize), resourceType: cut(i.resourceType, 30), priority: cut(i.priority, 20), displayWidth: numOrU(i.node?.boundingRect?.width), displayHeight: numOrU(i.node?.boundingRect?.height), wastedBytes: numOrU(i.wastedBytes), wastedMs: numOrU(i.wastedMs ?? i.responseTime),
    durationMs: numOrU(i.duration), scriptingMs: numOrU(i.scripting)
  } as EvidenceItem)).map((e) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as EvidenceItem)
    .filter((e) => Object.keys(e).length);
}

type Chain = { url?: string; request?: { url?: string; startTime?: number; endTime?: number; transferSize?: number }; navStartToEndTime?: number; transferSize?: number; children?: Record<string, Chain> };
/** Lighthouse 13 ("network-dependency-tree-insight") and 12 ("critical-request-chains") describe the request chain in different shapes. */
export function networkTree(A: Record<string, Audit>): LighthouseRun["networkTree"] {
  const d = A["network-dependency-tree-insight"]?.details ?? A["critical-request-chains"]?.details;
  const roots: Chain[] = d?.items ? (d.items as Array<{ value?: { chains?: Record<string, Chain> } }>).flatMap((i) => Object.values(i.value?.chains ?? {})) : Object.values((d?.chains ?? {}) as Record<string, Chain>);
  if (!roots.length) return undefined;
  const nodes: NonNullable<LighthouseRun["networkTree"]>["nodes"] = []; let maxDepth = 0, longestMs = 0;
  const walk = (c: Chain, depth: number, t0: number) => {
    const url = c.url ?? c.request?.url; const ms = c.navStartToEndTime ?? (c.request?.endTime !== undefined ? (c.request.endTime - t0) * 1000 : 0);
    if (url) { maxDepth = Math.max(maxDepth, depth); longestMs = Math.max(longestMs, ms); if (nodes.length < 30) nodes.push({ url: url.slice(0, 300), depth, ms: Math.round(ms), ...(numOrU(c.transferSize ?? c.request?.transferSize) !== undefined ? { bytes: numOrU(c.transferSize ?? c.request?.transferSize) } : {}) }); }
    Object.values(c.children ?? {}).forEach((k) => walk(k, depth + 1, t0));
  };
  roots.forEach((r) => walk(r, 0, r.request?.startTime ?? 0));
  return nodes.length ? { maxDepth, longestMs, nodes } : undefined;
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
  // Lighthouse 12 reports the SIMULATED breakdown (Load Delay dominates when images compete for bandwidth). Lighthouse 13 reports the
  // OBSERVED, unthrottled breakdown, where the same situation shows up as a simulated LCP far above the observed total.
  const lcp = run.metrics.lcpMs ?? 0;
  const delayDominates = delay / total >= 0.5, throttleGap = lcp > 2500 && lcp > 2 * total;
  if (!total || !(delayDominates || throttleGap)) return [];
  // Never block the LCP resource itself: that would make the "what-if" meaningless. We can only tell which request it is when the
  // LCP element is an <img> (its src and every srcset candidate are excluded). For a CSS background or text, do not run the experiment.
  const snippet = run.evidence["largest-contentful-paint-element"]?.[0]?.snippet ?? "";
  if (!/^\s*<img\b/i.test(snippet)) return [];
  const pathOf = (u: string) => { try { return new URL(u, "https://x.invalid").pathname; } catch { return u; } };
  const sizeless = (p: string) => p.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, "$1");
  const srcs = [/\ssrc=["']([^"']+)["']/i.exec(snippet)?.[1], ...parseSrcset(/\ssrcset=["']([^"']+)["']/i.exec(snippet)?.[1])].filter((u): u is string => !!u).map(pathOf);
  const isLcp = (p: string) => srcs.some((c) => c === p || sizeless(c) === sizeless(p));
  const heavy = (run.evidence["network-requests"] ?? []).filter((r) => r.url && r.resourceType === "Image" && (r.totalBytes ?? 0) > 100 * 1024 && !isLcp(pathOf(r.url)));
  return heavy.length >= 2 ? heavy.slice(0, 8).map((r) => r.url!) : [];
}

/** The parts of a Lighthouse result we read. Typed loosely on purpose: the audit set differs between Lighthouse 12 and 13. */
export interface Lhr {
  lighthouseVersion: string;
  audits: Record<string, Audit>;
  categories: Record<string, { score?: number | null; auditRefs?: Array<{ id: string; group?: string }> } | undefined>;
  configSettings: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  environment?: { benchmarkIndex?: number };
  runtimeError?: { code: string };
  runWarnings?: unknown[];
  finalDisplayedUrl?: string;
}
interface Audit {
  id: string; title: string; score: number | null; scoreDisplayMode?: string; displayValue?: unknown; numericValue?: number;
  details?: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  metricSavings?: Record<string, number>;
}

// Lighthouse 13 replaced several audits with "insights". Each is mapped onto the evidence key the fixes already use.
const INSIGHT_TO_EVIDENCE: Array<[insight: string, key: string]> = [["image-delivery-insight", "modern-image-formats"], ["render-blocking-insight", "render-blocking-resources"], ["font-display-insight", "font-display"]];
const PHASE_NAMES: Record<string, string> = { timeToFirstByte: "TTFB", resourceLoadDelay: "Load Delay", resourceLoadDuration: "Load Time", elementRenderDelay: "Render Delay" };

/** One Lighthouse run -> the data the report and the fixes use. Pure (no browser), so it is tested against saved real results. */
export function runFromLhr(lhr: Lhr): LighthouseRun {
  const A = lhr.audits, refs = lhr.categories.performance?.auditRefs ?? [];
  const num = (id: string) => r1(A[id]?.numericValue);
  const savingsOf = (a: Audit) => {
    const o = a.details?.overallSavingsMs;
    if (typeof o === "number" && o > 0) return o;
    const m = a.metricSavings;
    return m ? Math.max(m.LCP ?? 0, m.FCP ?? 0, m.TBT ?? 0) : 0;      // Lighthouse 13 reports estimated savings per metric
  };
  const failing = (a: Audit | undefined): a is Audit => !!a && a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "notApplicable";
  const opportunities = Object.values(A).filter((a) => failing(a) && savingsOf(a) > 0)
    .map((a) => ({ id: a.id, title: a.title, savingsMs: Math.round(savingsOf(a)) })).sort((x, y) => y.savingsMs - x.savingsMs).slice(0, 5);
  const diagnostics = refs.filter((r) => r.group === "diagnostics" || r.group === "insights").map((r) => A[r.id]).filter(failing)
    .map((a) => ({ id: a.id, title: a.title, displayValue: a.displayValue ? String(a.displayValue).slice(0, 80) : savingsOf(a) > 0 ? `est. savings ${Math.round(savingsOf(a))} ms` : undefined, score: a.score })).slice(0, 12);
  const passedAudits = refs.filter((r) => r.group !== "metrics" && r.group !== "hidden" && A[r.id]?.score !== null && (A[r.id]?.score ?? 0) >= 0.9).length;

  // ---- evidence (keyed by the Lighthouse 12 audit ids) ----
  const evidence: Record<string, EvidenceItem[]> = {};
  for (const id of EVIDENCE_AUDITS) {
    const a = A[id]; const items = a?.details?.items as RawItem[] | undefined;
    if (!a || !items?.length || (a.score === 1 && !ALWAYS_KEEP.has(id))) continue;
    const ev = toEvidence(id, items); if (ev.length) evidence[id] = ev;
  }
  for (const [insight, key] of INSIGHT_TO_EVIDENCE) {
    const a = A[insight], items = a?.details?.items as RawItem[] | undefined;
    if (evidence[key]?.length || !a || !items?.length || (a.score !== null && a.score >= 1)) continue;
    const ev = toEvidence(key, items); if (ev.length) evidence[key] = ev;
  }
  // LCP element, phases and discovery flags: "lcp-breakdown-insight" / "lcp-discovery-insight" in Lighthouse 13.
  const lcpItems = [...((A["lcp-breakdown-insight"]?.details?.items ?? []) as any[]), ...((A["lcp-discovery-insight"]?.details?.items ?? []) as any[])]; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!evidence["largest-contentful-paint-element"]) {
    const node = lcpItems.find((i) => i?.type === "node");
    if (node) evidence["largest-contentful-paint-element"] = [{ selector: cut(node.selector), snippet: cut(node.snippet, 1500), displayWidth: numOrU(node.boundingRect?.width), displayHeight: numOrU(node.boundingRect?.height) }];
  }
  const subparts = (lcpItems.find((i) => i?.type === "table" && Array.isArray(i.items) && i.items.some((x: { subpart?: string }) => x.subpart))?.items ?? []) as Array<{ subpart?: string; duration?: number }>;
  const insightPhases = subparts.filter((x) => x.subpart && PHASE_NAMES[x.subpart] && typeof x.duration === "number").map((x) => ({ phase: PHASE_NAMES[x.subpart!]!, ms: Math.round(x.duration!) }));
  const check = lcpItems.find((i) => i?.type === "checklist")?.items as Record<string, { value?: boolean }> | undefined;
  const lcpDiscovery = check ? { priorityHinted: check.priorityHinted?.value, requestDiscoverable: check.requestDiscoverable?.value, eagerlyLoaded: check.eagerlyLoaded?.value } : undefined;
  const fatal = lhr.runtimeError;
  return {
    ok: !fatal, ...(fatal ? { error: `Lighthouse: ${fatal.code}` } : {}),
    scores: { performance: pct(lhr.categories.performance?.score), accessibility: pct(lhr.categories.accessibility?.score), bestPractices: pct(lhr.categories["best-practices"]?.score), seo: pct(lhr.categories.seo?.score) },
    metrics: { fcpMs: num("first-contentful-paint"), lcpMs: num("largest-contentful-paint"), tbtMs: num("total-blocking-time"), cls: A["cumulative-layout-shift"]?.numericValue ?? null, speedIndexMs: num("speed-index"), ttiMs: num("interactive") },
    opportunities, runWarnings: (lhr.runWarnings ?? []).map(String).slice(0, 5), diagnostics, passedAudits,
    lcpPhases: insightPhases.length ? insightPhases : lcpPhases(A["largest-contentful-paint-element"]?.details),
    ...(lcpDiscovery ? { lcpDiscovery } : {}), ...(networkTree(A) ? { networkTree: networkTree(A) } : {}), ...(typeof lhr.environment?.benchmarkIndex === "number" ? { benchmarkIndex: Math.round(lhr.environment.benchmarkIndex) } : {}),
    evidence
  };
}

const benchmark = (runs: LighthouseRun[]) => { const b = runs.map((r) => r.benchmarkIndex).filter((x): x is number => typeof x === "number"); return b.length ? { benchmarkIndex: Math.round(median(b)) } : {}; };

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
        if (options.keepReports) htmlReports.push(ReportGenerator.generateReportHtml(lhr));
        runs.push(runFromLhr(lhr as unknown as Lhr));
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
    metadata: { lighthouseVersion: version, browser: `chromium ${browser.version?.() ?? ""}`.trim(), throttlingMethod, formFactor: profile, runs: runCount, settings, ...benchmark(runs) },
    runs, summary: summarizeLighthouse(runs), ...(experiments.length ? { experiments } : {}), ...(options.keepReports ? { htmlReports } : {}),
    limitations: [
      "Lab data from Lighthouse with simulated throttling on this machine; it is not field Core Web Vitals (CrUX/RUM).",
      "Scores vary between runs. Compare medians of several runs, never a single run.",
      "The browser resolves DNS itself and subrequests are not policy-checked, so this runs in local mode only."
    ]
  };
}
