export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type FindingStatus = "open" | "intentional" | "fixed" | "verified" | "ignored" | "unverified";

export interface Evidence {
  type: "html" | "header" | "link" | "resource" | "comparison";
  description: string;
  value?: string | number | boolean | null;
}

export interface Finding {
  id: string;
  ruleId: string;
  category: "performance" | "seo" | "schema" | "migration" | "content";
  severity: Severity;
  confidence: "high" | "medium" | "low";
  title: string;
  description: string;
  url: string;
  evidence: Evidence[];
  recommendation: string;
  status: FindingStatus;
}

export interface PageAudit {
  schemaVersion: "1.0.0";
  url: string;
  fetchedAt: string;
  statusCode: number;
  finalUrl: string;
  redirectChain: string[];
  /** <link rel="preload"> tags found in the HTML (used to tell which fixes are already applied). */
  preloads?: Array<{ href: string; as: string | null; fetchPriority: string | null }>;
  contentType: string | null;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robots: string | null;
  headings: { h1: string[]; h2Count: number; h3Count: number };
  images: { total: number; missingAlt: number; missingDimensions: number };
  links: { total: number; internal: number; external: number };
  schemaTypes: string[];
  jsonLdBlocks: number;
  findings: Finding[];
  limitations: string[];
}

export interface UrlPair {
  oldUrl: string;
  newUrl: string;
  group?: string;
  priority?: string;
  rowNumber: number;
}

export interface ComparisonResult {
  oldUrl: string;
  newUrl: string;
  comparedAt: string;
  status: "compared" | "failed";
  differences: Array<{
    id: string;
    category: "seo" | "schema" | "content" | "migration";
    severity: Severity;
    title: string;
    oldValue: unknown;
    newValue: unknown;
    recommendation: string;
  }>;
  oldAudit?: PageAudit;
  newAudit?: PageAudit;
  error?: string;
}

export type BrowserProfileName = "desktop" | "mobile";

export interface BrowserRun {
  ok: boolean;
  error?: string;
  httpStatus: number | null;
  ttfbMs: number | null;
  fcpMs: number | null;
  lcpMs: number | null;
  lcpElement: { tag: string; url: string | null } | null;
  cls: number | null;
  domContentLoadedMs: number | null;
  loadMs: number | null;
  requestCount: number;
  transferBytes: number;
  slowestResources: Array<{ url: string; type: string; durationMs: number; transferBytes: number }>;
  blockedRequests: number;
}

export type MetricKey = "ttfbMs" | "fcpMs" | "lcpMs" | "cls" | "domContentLoadedMs" | "loadMs" | "transferBytes";
export interface MetricSummary { median: number; min: number; max: number; samples: number }

/** Lab measurement from a real browser. This is NOT field data (CrUX/RUM). */
export interface BrowserMeasurement {
  schemaVersion: "1.0.0";
  source: "lab";
  url: string;
  finalUrl: string | null;
  measuredAt: string;
  profile: BrowserProfileName;
  status: "complete" | "partial" | "failed";
  metadata: {
    browser: string; playwrightVersion: string; userAgent: string;
    viewport: { width: number; height: number }; deviceScaleFactor: number;
    throttling: "none"; cache: "cold (fresh context per run)"; runs: number; timeoutMs: number;
  };
  runs: BrowserRun[];
  summary: Partial<Record<MetricKey, MetricSummary>>;
  limitations: string[];
}

/** Per-resource evidence from a failing Lighthouse audit (capped, strings truncated). */
export interface EvidenceItem {
  url?: string; selector?: string; snippet?: string;
  totalBytes?: number; wastedBytes?: number; wastedMs?: number; durationMs?: number; scriptingMs?: number;
  resourceType?: string; priority?: string; displayWidth?: number; displayHeight?: number;
}

export interface LighthouseRun {
  ok: boolean;
  error?: string;
  scores: { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null }; // 0-100
  metrics: { fcpMs: number | null; lcpMs: number | null; tbtMs: number | null; cls: number | null; speedIndexMs: number | null; ttiMs: number | null };
  opportunities: Array<{ id: string; title: string; savingsMs: number }>;
  runWarnings: string[];
  /** PageSpeed-Insights-style "Diagnostics": failing audits that are not opportunities. */
  /** LCP broken into TTFB / Load Delay / Load Time / Render Delay (ms), as in Lighthouse and PageSpeed Insights. */
  lcpPhases?: Array<{ phase: string; ms: number }>;
  diagnostics?: Array<{ id: string; title: string; displayValue?: string; score: number | null }>;
  passedAudits?: number;
  /** Keyed by Lighthouse audit id, e.g. "unused-css-rules". Only audits that failed or list items. */
  evidence: Record<string, EvidenceItem[]>;
}

/** A what-if Lighthouse run with some requests blocked, to turn an inferred cause into a measured one. Not a fix. */
export interface LighthouseExperiment {
  id: "block-competing-images";
  description: string;
  blocked: string[];
  lcpMs: number | null;
  performanceScore: number | null;
  baselineLcpMs: number | null;
  baselinePerformance: number | null;
}

/** Lighthouse lab result (simulated throttling by default). Not field data. */
export interface LighthouseMeasurement {
  schemaVersion: "1.0.0";
  source: "lab";
  engine: "lighthouse";
  url: string;
  finalUrl: string | null;
  measuredAt: string;
  profile: BrowserProfileName;
  status: "complete" | "partial" | "failed";
  metadata: {
    lighthouseVersion: string; browser: string; throttlingMethod: string; formFactor: string; runs: number;
    /** Effective Lighthouse settings, to compare with PageSpeed Insights' lab conditions. */
    settings?: { rttMs?: number; throughputKbps?: number; cpuSlowdownMultiplier?: number; screenWidth?: number; screenHeight?: number; deviceScaleFactor?: number; userAgent?: string };
  };
  runs: LighthouseRun[];
  summary: Record<string, MetricSummary>;
  limitations: string[];
  experiments?: LighthouseExperiment[];
  /** Full Lighthouse HTML report per run; only present when requested (large). */
  htmlReports?: string[];
}

export interface PsiFieldMetric { p75: number; category: string }
/** Result of Google's PageSpeed Insights API (lab = Lighthouse on Google's servers, field = CrUX real-user data). */
export interface PsiResult {
  strategy: BrowserProfileName;
  fetchedAt: string;
  lighthouseVersion: string;
  finalUrl: string;
  scores: { performance: number | null; accessibility: number | null; bestPractices: number | null; seo: number | null };
  metrics: { fcpMs: number | null; lcpMs: number | null; tbtMs: number | null; cls: number | null; speedIndexMs: number | null };
  field: null | { scope: "url" | "origin"; overall: string | null; metrics: { lcpMs?: PsiFieldMetric; inpMs?: PsiFieldMetric; cls?: PsiFieldMetric; fcpMs?: PsiFieldMetric; ttfbMs?: PsiFieldMetric } };
  opportunities: Array<{ id: string; title: string; savingsMs: number }>;
}
