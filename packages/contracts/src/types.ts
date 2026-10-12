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
