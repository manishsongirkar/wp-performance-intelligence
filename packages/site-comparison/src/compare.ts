import { randomUUID } from "node:crypto";
import { isNoindex } from "../../contracts/src/robots.js";
import type { ComparisonResult, PageAudit, Severity } from "../../contracts/src/types.js";

function diff(category: "seo" | "schema" | "content" | "migration", severity: Severity, title: string, oldValue: unknown, newValue: unknown, recommendation: string) {
  return { id: randomUUID(), category, severity, title, oldValue, newValue, recommendation };
}

export function comparePages(oldAudit: PageAudit, newAudit: PageAudit): ComparisonResult {
  const differences: ComparisonResult["differences"] = [];
  if (oldAudit.statusCode !== newAudit.statusCode) differences.push(diff("migration", "high", "HTTP status changed", oldAudit.statusCode, newAudit.statusCode, "Confirm the new status is intentional and that important old URLs redirect to the correct equivalent page."));
  if (oldAudit.title !== newAudit.title) differences.push(diff("seo", "medium", "Page title changed", oldAudit.title, newAudit.title, "Review the title change; confirm the new title remains accurate and unique."));
  if (oldAudit.metaDescription !== newAudit.metaDescription) differences.push(diff("seo", "low", "Meta description changed", oldAudit.metaDescription, newAudit.metaDescription, "Review whether the new description is intentional and useful."));
  // Compare canonicals as absolute URLs (a relative "/" and an absolute "https://same-site/" are the same canonical).
  const absCanon = (a: PageAudit) => { try { return a.canonical ? new URL(a.canonical, a.finalUrl || a.url).href : null; } catch { return a.canonical; } };
  if (absCanon(oldAudit) !== absCanon(newAudit)) differences.push(diff("seo", "high", "Canonical URL changed", oldAudit.canonical, newAudit.canonical, "Confirm the new canonical points to the intended indexable URL."));
  if (oldAudit.robots !== newAudit.robots) {
    const nowBlocked = isNoindex(newAudit.robots), wasBlocked = isNoindex(oldAudit.robots);
    // Critical only when indexing becomes blocked. Already blocked before, or unblocked now, is not a new risk.
    differences.push(diff("seo", nowBlocked && !wasBlocked ? "critical" : wasBlocked && !nowBlocked ? "low" : "medium", "Robots directive changed", oldAudit.robots, newAudit.robots, nowBlocked && !wasBlocked ? "A noindex on an intended indexable page blocks search visibility. Review the directive and the X-Robots-Tag response header." : "Review the directive and the X-Robots-Tag response header."));
  }
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
