import { chromium, devices, type BrowserContext } from "playwright";
import { createRequire } from "node:module";
import { validateDestination, SafeFetchError, type NetworkPolicy, type Resolver } from "../../safe-fetch/src/index.js";
import type { BrowserMeasurement, BrowserProfileName, BrowserRun, MetricKey, MetricSummary } from "../../contracts/src/types.js";

export interface MeasureOptions {
  policy: NetworkPolicy;
  profile?: BrowserProfileName;
  runs?: number;
  /** Per-run navigation timeout. */
  timeoutMs?: number;
  resolve?: Resolver;
}

const PROFILES = {
  desktop: { viewport: { width: 1350, height: 940 }, deviceScaleFactor: 1, userAgent: undefined, isMobile: false, hasTouch: false },
  mobile: { ...devices["Pixel 7"] }
} as const;

// Runs in every page before its scripts; the top-frame guard avoids counting iframes.
const OBSERVER = `(() => {
  if (window !== window.top) return;
  const s = (window.__wpi = { lcp: null, cls: 0 });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) s.lcp = { time: e.startTime, tag: e.element ? e.element.tagName : null, url: e.url || null }; })
    .observe({ type: "largest-contentful-paint", buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) s.cls += e.value; })
    .observe({ type: "layout-shift", buffered: true });
})();`;

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median and range per metric over successful runs only. A single run is never a trend. */
export function summarize(runs: BrowserRun[]): Partial<Record<MetricKey, MetricSummary>> {
  const keys: MetricKey[] = ["ttfbMs", "fcpMs", "lcpMs", "cls", "domContentLoadedMs", "loadMs", "transferBytes"];
  const out: Partial<Record<MetricKey, MetricSummary>> = {};
  for (const key of keys) {
    const v = runs.filter((r) => r.ok).map((r) => r[key]).filter((x): x is number => typeof x === "number");
    if (v.length) out[key] = { median: round(median(v), 3), min: round(Math.min(...v), 3), max: round(Math.max(...v), 3), samples: v.length };
  }
  return out;
}

/**
 * Every browser request is checked against the network policy before it leaves (route interception).
 * Limitation: the browser resolves DNS itself, so unlike safeFetch there is no address pinning.
 * That is acceptable for trusted local use only; the API therefore refuses this in public mode.
 */
async function guard(context: BrowserContext, policy: NetworkPolicy, resolve: Resolver | undefined, counters: { blocked: number }) {
  const subPolicy: NetworkPolicy = { ...policy, allowedHosts: [] }; // allowlist limits the audited site, not its third-party assets
  const cache = new Map<string, Promise<boolean>>();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const nav = request.isNavigationRequest() && request.frame()?.parentFrame() === null;
    const url = new URL(request.url());
    const key = `${nav ? "n" : "s"}|${url.protocol}//${url.host}`;
    let ok = cache.get(key);
    if (!ok) cache.set(key, ok = validateDestination(url, nav ? policy : subPolicy, resolve).then(() => true, () => false));
    if (await ok) return route.continue();
    counters.blocked++;
    return route.abort("blockedbyclient");
  });
}

export async function measurePage(url: string, options: MeasureOptions): Promise<BrowserMeasurement> {
  const { policy, profile = "desktop", runs: runCount = 3, timeoutMs = 30_000, resolve } = options;
  // Validate the target up front so a bad URL fails fast with a clear error, before launching a browser.
  await validateDestination(new URL(url), policy, resolve).catch((e) => { throw e instanceof SafeFetchError ? e : new SafeFetchError("INVALID_URL", "Malformed URL."); });

  const p = PROFILES[profile];
  const browser = await chromium.launch();
  const runs: BrowserRun[] = [];
  let finalUrl: string | null = null;
  let userAgent = "";
  const browserVersion = browser.version();
  try {
    for (let i = 0; i < runCount; i++) {
      const context = await browser.newContext({ viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor, userAgent: p.userAgent, isMobile: p.isMobile, hasTouch: p.hasTouch, serviceWorkers: "block" });
      const counters = { blocked: 0 };
      try {
        await guard(context, policy, resolve, counters);
        await context.addInitScript(OBSERVER);
        const page = await context.newPage();
        userAgent ||= await page.evaluate(() => navigator.userAgent);
        const response = await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
        await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {}); // best effort settle
        finalUrl = page.url();
        const data = await page.evaluate(() => {
          const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
          const fcp = performance.getEntriesByName("first-contentful-paint")[0];
          const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
          const w = (window as any).__wpi as { lcp: { time: number; tag: string | null; url: string | null } | null; cls: number };
          return {
            ttfb: nav ? nav.responseStart : null, dcl: nav ? nav.domContentLoadedEventEnd : null, load: nav ? nav.loadEventEnd : null,
            fcp: fcp ? fcp.startTime : null, lcp: w.lcp, cls: w.cls,
            transfer: (nav?.transferSize ?? 0) + res.reduce((a, r) => a + r.transferSize, 0), count: res.length + 1,
            slowest: [...res].sort((a, b) => b.duration - a.duration).slice(0, 5).map((r) => ({ url: r.name.slice(0, 300), type: r.initiatorType, durationMs: Math.round(r.duration), transferBytes: r.transferSize }))
          };
        });
        const status = response?.status() ?? null;
        runs.push({
          ok: status !== null && status < 400, ...(status !== null && status >= 400 ? { error: `HTTP ${status}` } : {}),
          httpStatus: status, ttfbMs: data.ttfb && round(data.ttfb), fcpMs: data.fcp && round(data.fcp), lcpMs: data.lcp && round(data.lcp.time),
          lcpElement: data.lcp?.tag ? { tag: data.lcp.tag, url: data.lcp.url } : null, cls: round(data.cls, 4),
          domContentLoadedMs: data.dcl && round(data.dcl), loadMs: data.load && round(data.load),
          requestCount: data.count, transferBytes: data.transfer, slowestResources: data.slowest, blockedRequests: counters.blocked
        });
      } catch (error) {
        runs.push({
          ok: false, error: /timeout/i.test(String(error)) ? "Navigation timed out." : "Browser navigation failed.", httpStatus: null,
          ttfbMs: null, fcpMs: null, lcpMs: null, lcpElement: null, cls: null, domContentLoadedMs: null, loadMs: null,
          requestCount: 0, transferBytes: 0, slowestResources: [], blockedRequests: counters.blocked
        });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }

  const okRuns = runs.filter((r) => r.ok).length;
  const require = createRequire(import.meta.url);
  const limitations = [
    "Lab measurement with no network or CPU throttling; values depend on this machine and are not field Core Web Vitals.",
    "Each run uses a fresh browser context (cold cache). Do not treat a single run as a regression; compare medians of several runs.",
    "Lighthouse metrics (Speed Index, TBT, scores) are not included yet.",
    "Authentication, cookie-consent gates and bot protection are not handled; such pages may produce partial or failed measurements."
  ];
  if (runs.some((r) => r.blockedRequests)) limitations.push("Some requests were blocked by the network policy, so the page may not have loaded fully.");
  return {
    schemaVersion: "1.0.0", source: "lab", url, finalUrl, measuredAt: new Date().toISOString(), profile,
    status: okRuns === runs.length ? "complete" : okRuns ? "partial" : "failed",
    metadata: {
      browser: `chromium ${browserVersion}`, playwrightVersion: require("playwright/package.json").version, userAgent,
      viewport: p.viewport, deviceScaleFactor: p.deviceScaleFactor, throttling: "none", cache: "cold (fresh context per run)", runs: runCount, timeoutMs
    },
    runs, summary: summarize(runs), limitations
  };
}
