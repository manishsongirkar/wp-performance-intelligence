import { randomUUID } from "node:crypto";
import type { ComparisonResult, PageAudit, Severity } from "../../contracts/src/types.js";

function diff(category: "seo" | "schema" | "content" | "migration", severity: Severity, title: string, oldValue: unknown, newValue: unknown, recommendation: string) {
  return { id: randomUUID(), category, severity, title, oldValue, newValue, recommendation };
}

export function comparePages(oldAudit: PageAudit, newAudit: PageAudit): ComparisonResult {
  const differences: ComparisonResult["differences"] = [];
  if (oldAudit.statusCode !== newAudit.statusCode) differences.push(diff("migration", "high", "HTTP status changed", oldAudit.statusCode, newAudit.statusCode, "Confirm the new status is intentional and that important old URLs redirect to the correct equivalent page."));
  if (oldAudit.title !== newAudit.title) differences.push(diff("seo", "medium", "Page title changed", oldAudit.title, newAudit.title, "Review the title change; confirm the new title remains accurate and unique."));
  if (oldAudit.metaDescription !== newAudit.metaDescription) differences.push(diff("seo", "low", "Meta description changed", oldAudit.metaDescription, newAudit.metaDescription, "Review whether the new description is intentional and useful."));
  if (oldAudit.canonical !== newAudit.canonical) differences.push(diff("seo", "high", "Canonical URL changed", oldAudit.canonical, newAudit.canonical, "Confirm the new canonical points to the intended indexable URL."));
  if (oldAudit.robots !== newAudit.robots) differences.push(diff("seo", /noindex/i.test(newAudit.robots ?? "") ? "critical" : "medium", "Robots directive changed", oldAudit.robots, newAudit.robots, "Review the directive and response X-Robots-Tag. A noindex on an intended indexable page can block search visibility."));
  const oldTypes = [...oldAudit.schemaTypes].sort();
  const newTypes = [...newAudit.schemaTypes].sort();
  if (JSON.stringify(oldTypes) !== JSON.stringify(newTypes)) differences.push(diff("schema", "high", "Structured data types changed", oldTypes, newTypes, "Validate whether removed or changed schema types are intentional; check for duplicate schema before adding markup."));
  if (oldAudit.headings.h1.join(" | ") !== newAudit.headings.h1.join(" | ")) differences.push(diff("content", "medium", "H1 content changed", oldAudit.headings.h1, newAudit.headings.h1, "Confirm the new page preserves the intended primary topic and heading."));
  if (newAudit.images.missingAlt > oldAudit.images.missingAlt) differences.push(diff("content", "medium", "More images lack alt text", oldAudit.images.missingAlt, newAudit.images.missingAlt, "Review new image elements and add appropriate alt text or empty alt for decorative images."));
  if (newAudit.links.internal < oldAudit.links.internal) differences.push(diff("content", "medium", "Internal link count decreased", oldAudit.links.internal, newAudit.links.internal, "Review removed internal links and confirm important navigation and contextual links remain."));
  if (newAudit.jsonLdBlocks < oldAudit.jsonLdBlocks) differences.push(diff("schema", "medium", "JSON-LD block count decreased", oldAudit.jsonLdBlocks, newAudit.jsonLdBlocks, "Validate the new page's schema graph; fewer scripts are not necessarily a problem if equivalent valid schema remains."));
  return {
    oldUrl: oldAudit.url, newUrl: newAudit.url, comparedAt: new Date().toISOString(),
    status: "compared", differences, oldAudit, newAudit
  };
}
