import { z } from "zod";

// Runtime validation for data that crosses the HTTP boundary (currently the export endpoint).
const str = z.string().max(5000);
const severity = z.enum(["critical", "high", "medium", "low", "info"]);

const finding = z.object({
  id: str, ruleId: str,
  category: z.enum(["performance", "seo", "schema", "migration", "content"]),
  severity, confidence: z.enum(["high", "medium", "low"]),
  title: str, description: str, url: str,
  evidence: z.array(z.object({
    type: z.enum(["html", "header", "link", "resource", "comparison"]),
    description: str, value: z.union([str, z.number(), z.boolean(), z.null()]).optional()
  })).max(50),
  recommendation: str,
  status: z.enum(["open", "intentional", "fixed", "verified", "ignored", "unverified"])
});

export const pageAuditSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  url: str, fetchedAt: str, statusCode: z.number().int(), finalUrl: str,
  redirectChain: z.array(str).max(20).default([]),
  preloads: z.array(z.object({ href: str, as: str.nullable(), fetchPriority: str.nullable(), srcsetUrls: z.array(str).max(30).optional() })).max(100).optional(),
  scripts: z.array(z.object({ src: str, defer: z.boolean(), async: z.boolean(), module: z.boolean() })).max(300).optional(),
  stylesheets: z.array(z.object({ href: str, async: z.boolean() })).max(300).optional(),
  imgTags: z.array(z.object({ src: str, srcsetUrls: z.array(str).max(30), fetchPriority: str.nullable(), loading: str.nullable() })).max(100).optional(),
  preconnects: z.array(str).max(100).optional(),
  contentType: str.nullable(), title: str.nullable(), metaDescription: str.nullable(),
  canonical: str.nullable(), robots: str.nullable(),
  headings: z.object({ h1: z.array(str).max(100), h2Count: z.number(), h3Count: z.number() }),
  images: z.object({ total: z.number(), missingAlt: z.number(), missingDimensions: z.number() }),
  links: z.object({ total: z.number(), internal: z.number(), external: z.number() }),
  schemaTypes: z.array(str).max(200), jsonLdBlocks: z.number(),
  findings: z.array(finding).max(500), limitations: z.array(str).max(50)
});

export const comparisonResultSchema = z.object({
  oldUrl: str, newUrl: str, comparedAt: str, status: z.enum(["compared", "failed"]),
  differences: z.array(z.object({
    id: str, category: z.enum(["seo", "schema", "content", "migration"]), severity,
    title: str, oldValue: z.unknown(), newValue: z.unknown(), recommendation: str
  })).max(200),
  error: str.optional()
});

export const exportSchema = z.object({ results: z.array(z.union([comparisonResultSchema, pageAuditSchema])).max(5000) });
