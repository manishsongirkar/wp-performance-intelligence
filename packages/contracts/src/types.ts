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
