import { load } from "cheerio";
import { randomUUID } from "node:crypto";
import type { Finding, PageAudit, Severity } from "../../contracts/src/types.js";

export interface FetchPageOptions {
  timeoutMs?: number;
  maxBytes?: number;
  allowedHosts?: string[];
}

function makeFinding(input: Omit<Finding, "id" | "status">): Finding {
  return { ...input, id: randomUUID(), status: "open" };
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Early-MVP fetch policy. This checks host allowlists before the request, but it is NOT
 * sufficient protection for a public deployment; DNS rebinding and redirect validation
 * require connection-time enforcement in an isolated worker.
 */
export async function auditPage(inputUrl: string, options: FetchPageOptions = {}): Promise<PageAudit> {
  const parsed = new URL(inputUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
  if (parsed.username || parsed.password) throw new Error("URLs containing credentials are not allowed.");
  const allowlist = options.allowedHosts;
  if (allowlist?.length && !allowlist.some((h) => normalizeHost(parsed.hostname) === normalizeHost(h) || parsed.hostname.endsWith(`.${h}`))) {
    throw new Error(`Host ${parsed.hostname} is not in the configured allowlist.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  let response: Response;
  try {
    response = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: "manual",
      headers: { "user-agent": "WP-Performance-Intelligence/0.1 (+authorized website audit)" }
    });
  } finally {
    clearTimeout(timeout);
  }

  const contentType = response.headers.get("content-type");
  const finalUrl = parsed.toString();
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    const finding = makeFinding({
      ruleId: "http.redirect",
      category: "migration",
      severity: "medium",
      confidence: "high",
      title: "Page redirects",
      description: "The requested URL returned a redirect. Redirect destination is recorded for manual or follow-up validation.",
      url: inputUrl,
      evidence: [{ type: "header", description: "HTTP redirect response", value: location }],
      recommendation: "Confirm the redirect points to the intended equivalent page and does not create a chain or loop."
    });
    return emptyAudit(inputUrl, response.status, contentType, [finding], location ? [ `Redirect destination: ${new URL(location, inputUrl).toString()}` ] : []);
  }
  if (!contentType?.toLowerCase().includes("text/html")) {
    return emptyAudit(inputUrl, response.status, contentType, [], ["Response was not HTML; page-level SEO checks were skipped."]);
  }

  const maxBytes = options.maxBytes ?? 2_000_000;
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`HTML response exceeded configured limit (${maxBytes} bytes).`);
  const $ = load(text);
  const findings: Finding[] = [];
  const title = $("title").first().text().trim() || null;
  const metaDescription = $('meta[name="description" i]').attr("content")?.trim() || null;
  const canonical = $('link[rel~="canonical" i]').attr("href")?.trim() || null;
  const robots = $('meta[name="robots" i]').attr("content")?.trim() || response.headers.get("x-robots-tag");
  const h1 = $("h1").map((_, el) => $(el).text().trim()).get().filter(Boolean);
  const h2Count = $("h2").length;
  const h3Count = $("h3").length;
  const images = $("img");
  const missingAlt = images.filter((_, el) => !$(el).attr("alt")?.trim()).length;
  const missingDimensions = images.filter((_, el) => !$(el).attr("width") || !$(el).attr("height")).length;
  const anchors = $("a[href]");
  let internal = 0;
  let external = 0;
  anchors.each((_, el) => {
    try {
      const target = new URL($(el).attr("href")!, inputUrl);
      if (target.hostname === parsed.hostname) internal++; else external++;
    } catch { /* Ignore non-URL links such as mailto: and javascript:. */ }
  });
  const jsonLdScripts = $('script[type="application/ld+json"]');
  const schemaTypes = new Set<string>();
  jsonLdScripts.each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      collectTypes(data, schemaTypes);
    } catch {
      findings.push(makeFinding({
        ruleId: "schema.jsonld.invalid-json",
        category: "schema",
        severity: "medium",
        confidence: "high",
        title: "Invalid JSON-LD",
        description: "A JSON-LD script could not be parsed as valid JSON.",
        url: inputUrl,
        evidence: [{ type: "html", description: "Invalid JSON-LD script found in rendered HTML." }],
        recommendation: "Validate and correct the JSON syntax, then re-run structured data validation."
      }));
    }
  });

  if (!title) findings.push(seoFinding(inputUrl, "seo.title.missing", "Missing page title", "high", "Add a unique, descriptive title that accurately represents this page."));
  if (!metaDescription) findings.push(seoFinding(inputUrl, "seo.description.missing", "Missing meta description", "medium", "Add a useful, page-specific meta description; avoid copying descriptions across many URLs."));
  if (!canonical) findings.push(seoFinding(inputUrl, "seo.canonical.missing", "Missing canonical link", "medium", "Confirm the intended canonical URL and add it through the theme or SEO configuration if appropriate."));
  if (h1.length === 0) findings.push(seoFinding(inputUrl, "seo.h1.missing", "No H1 heading found", "medium", "Check whether the main page heading is present in the rendered HTML."));
  if (h1.length > 1) findings.push(seoFinding(inputUrl, "seo.h1.multiple", "Multiple H1 headings found", "low", "Review the heading structure and ensure the main page topic is clear. Multiple H1 elements are not automatically an SEO error."));
  if (missingAlt > 0) findings.push(makeFinding({
    ruleId: "a11y.images.missing-alt",
    category: "seo",
    severity: "medium",
    confidence: "high",
    title: `${missingAlt} image(s) missing alt attributes`,
    description: "One or more images have no alt attribute. Decorative images may intentionally use an empty alt attribute.",
    url: inputUrl,
    evidence: [{ type: "html", description: "Image elements without a non-empty alt attribute", value: missingAlt }],
    recommendation: "Review each image and add meaningful alternative text for informative images; use alt=\"\" for decorative images."
  }));
  if (robots && /noindex/i.test(robots)) findings.push(makeFinding({
    ruleId: "seo.robots.noindex",
    category: "seo",
    severity: "high",
    confidence: "high",
    title: "Page has a noindex directive",
    description: `The page exposes a noindex directive: ${robots}`,
    url: inputUrl,
    evidence: [{ type: "header", description: "Robots directive", value: robots }],
    recommendation: "Confirm this is intentional. If the page should be indexed, update the source of the directive and re-check response headers and rendered HTML."
  }));

  return {
    schemaVersion: "1.0.0",
    url: inputUrl,
    fetchedAt: new Date().toISOString(),
    statusCode: response.status,
    finalUrl,
    contentType,
    title,
    metaDescription,
    canonical,
    robots: robots ?? null,
    headings: { h1, h2Count, h3Count },
    images: { total: images.length, missingAlt, missingDimensions },
    links: { total: anchors.length, internal, external },
    schemaTypes: [...schemaTypes],
    jsonLdBlocks: jsonLdScripts.length,
    findings,
    limitations: [
      "This MVP inspects fetched HTML only; it does not yet run Lighthouse or a real browser.",
      "A missing canonical, description or H1 is a diagnostic signal and requires context-specific review.",
      "Field Core Web Vitals and source-code attribution are not available in this version."
    ]
  };
}

function collectTypes(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) { value.forEach((v) => collectTypes(v, out)); return; }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  if (typeof type === "string") out.add(type);
  if (Array.isArray(type)) type.forEach((t) => { if (typeof t === "string") out.add(t); });
  if (record["@graph"]) collectTypes(record["@graph"], out);
}

function seoFinding(url: string, ruleId: string, title: string, severity: Severity, recommendation: string): Finding {
  return makeFinding({
    ruleId, category: "seo", severity, confidence: "high", title,
    description: title,
    url, evidence: [{ type: "html", description: title }],
    recommendation
  });
}

function emptyAudit(url: string, statusCode: number, contentType: string | null, findings: Finding[], limitations: string[]): PageAudit {
  return {
    schemaVersion: "1.0.0", url, fetchedAt: new Date().toISOString(), statusCode, finalUrl: url, contentType,
    title: null, metaDescription: null, canonical: null, robots: null,
    headings: { h1: [], h2Count: 0, h3Count: 0 },
    images: { total: 0, missingAlt: 0, missingDimensions: 0 },
    links: { total: 0, internal: 0, external: 0 },
    schemaTypes: [], jsonLdBlocks: 0, findings, limitations
  };
}
