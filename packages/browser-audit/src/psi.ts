import { safeFetch, validateDestination, SafeFetchError, type NetworkPolicy, type Resolver, type Transport } from "../../safe-fetch/src/index.js";
import type { BrowserProfileName, PsiFieldMetric, PsiResult } from "../../contracts/src/types.js";

export interface PsiOptions {
  strategy?: BrowserProfileName;
  apiKey?: string;
  timeoutMs?: number;
  /** Test seams. */
  resolve?: Resolver;
  transport?: Transport;
}

const API = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
// Google's servers must be able to reach the page, and its API only talks to the public internet.
const PUBLIC: NetworkPolicy = { mode: "public", allowedHosts: [], privateHosts: [] };
const GOOGLE: NetworkPolicy = { mode: "public", allowedHosts: ["googleapis.com"], privateHosts: [] };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (v: unknown) => (typeof v === "number" ? Math.round(v * 100) : null);
const r1 = (v: unknown) => (typeof v === "number" ? Math.round(v * 10) / 10 : null);

function field(exp: Json | undefined, scope: "url" | "origin"): PsiResult["field"] {
  const m = exp?.metrics as Json | undefined;
  if (!m || !Object.keys(m).length) return null;
  const pick = (key: string, scale = 1): PsiFieldMetric | undefined => {
    const x = m[key]; if (!x || typeof x.percentile !== "number") return undefined;
    return { p75: x.percentile / scale, category: String(x.category ?? "") };
  };
  return {
    scope, overall: typeof exp?.overall_category === "string" ? exp.overall_category : null,
    metrics: {
      lcpMs: pick("LARGEST_CONTENTFUL_PAINT_MS"), inpMs: pick("INTERACTION_TO_NEXT_PAINT"),
      cls: pick("CUMULATIVE_LAYOUT_SHIFT_SCORE", 100), // PSI reports CLS multiplied by 100
      fcpMs: pick("FIRST_CONTENTFUL_PAINT_MS"), ttfbMs: pick("EXPERIMENTAL_TIME_TO_FIRST_BYTE")
    }
  };
}

/** True when the URL is reachable by Google (public host). Local and private URLs cannot be tested by PageSpeed Insights. */
export async function isPsiTestable(url: string, resolve?: Resolver): Promise<boolean> {
  try { await validateDestination(new URL(url), PUBLIC, resolve); return true; } catch { return false; }
}

/**
 * Calls Google's PageSpeed Insights API. This sends the URL to Google, so callers must make it opt-in.
 * Returns the lab score/metrics (Lighthouse on Google's servers) and real-user field data (CrUX) when Google has it.
 */
export async function fetchPsi(url: string, options: PsiOptions = {}): Promise<PsiResult> {
  const strategy = options.strategy ?? "mobile";
  if (!(await isPsiTestable(url, options.resolve))) throw new SafeFetchError("BLOCKED_DESTINATION", "PageSpeed Insights can only test public URLs.");
  const q = new URLSearchParams({ url, strategy });
  for (const c of ["performance", "accessibility", "best-practices", "seo"]) q.append("category", c);
  if (options.apiKey) q.set("key", options.apiKey);
  const res = await safeFetch(`${API}?${q}`, { policy: GOOGLE, timeoutMs: options.timeoutMs ?? 90_000, maxBytes: 12_000_000, resolve: options.resolve, transport: options.transport });
  if (res.status === 429) throw new SafeFetchError("BUSY", "PageSpeed Insights quota exceeded. Set WPI_PSI_API_KEY or try again later.");
  if (res.status >= 400) throw new SafeFetchError("NETWORK", `PageSpeed Insights returned HTTP ${res.status}.`);
  let body: Json;
  try { body = JSON.parse(res.body.toString("utf8")) as Json; } catch { throw new SafeFetchError("NETWORK", "PageSpeed Insights returned an unreadable response."); }
  const lhr = body.lighthouseResult as Json | undefined;
  if (!lhr?.audits) throw new SafeFetchError("NETWORK", "PageSpeed Insights returned no Lighthouse result.");
  const a = lhr.audits as Json, c = (lhr.categories ?? {}) as Json;
  return {
    strategy, fetchedAt: new Date().toISOString(), lighthouseVersion: String(lhr.lighthouseVersion ?? ""), finalUrl: String(lhr.finalDisplayedUrl ?? url).slice(0, 500),
    scores: { performance: pct(c.performance?.score), accessibility: pct(c.accessibility?.score), bestPractices: pct(c["best-practices"]?.score), seo: pct(c.seo?.score) },
    metrics: { fcpMs: r1(a["first-contentful-paint"]?.numericValue), lcpMs: r1(a["largest-contentful-paint"]?.numericValue), tbtMs: r1(a["total-blocking-time"]?.numericValue), cls: num(a["cumulative-layout-shift"]?.numericValue), speedIndexMs: r1(a["speed-index"]?.numericValue) },
    // URL-level field data is preferred; Google falls back to the whole origin for low-traffic pages.
    field: field(body.loadingExperience, "url") ?? field(body.originLoadingExperience, "origin"),
    opportunities: Object.values(a).filter((x: Json) => x?.details?.type === "opportunity" && typeof x.details.overallSavingsMs === "number" && x.details.overallSavingsMs > 0 && x.score !== null && x.score < 0.9)
      .map((x: Json) => ({ id: String(x.id), title: String(x.title), savingsMs: Math.round(x.details.overallSavingsMs) })).sort((p, q) => q.savingsMs - p.savingsMs).slice(0, 8)
  };
}
