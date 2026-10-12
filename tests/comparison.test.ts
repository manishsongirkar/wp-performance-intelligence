import { describe, expect, it } from "vitest";
import { comparePages } from "../packages/site-comparison/src/compare.js";
import type { PageAudit } from "../packages/contracts/src/types.js";

const page = (overrides: Partial<PageAudit> = {}): PageAudit => ({
  schemaVersion: "1.0.0", url: "https://example.com/", fetchedAt: new Date(0).toISOString(),
  statusCode: 200, finalUrl: "https://example.com/", contentType: "text/html",
  title: "Title", metaDescription: "Description", canonical: "https://example.com/",
  robots: null, headings: { h1: ["Title"], h2Count: 1, h3Count: 0 },
  images: { total: 1, missingAlt: 0, missingDimensions: 0 },
  links: { total: 2, internal: 1, external: 1 }, schemaTypes: ["Article"], jsonLdBlocks: 1,
  findings: [], limitations: [], ...overrides
});

describe("comparePages", () => {
  it("flags a newly introduced noindex directive and removed schema", () => {
    const result = comparePages(page(), page({ robots: "noindex", schemaTypes: [], jsonLdBlocks: 0 }));
    expect(result.differences.some(d => d.title === "Robots directive changed" && d.severity === "critical")).toBe(true);
    expect(result.differences.some(d => d.title === "Structured data types changed")).toBe(true);
  });
});
