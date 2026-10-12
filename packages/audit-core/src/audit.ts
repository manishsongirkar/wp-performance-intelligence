import { load } from "cheerio";
import { randomUUID } from "node:crypto";
import { safeFetch, type SafeFetchOptions } from "../../safe-fetch/src/index.js";
import { isNoindex } from "../../contracts/src/robots.js";
import { parseSrcset } from "./srcset.js";
import type { Finding, PageAudit, Severity } from "../../contracts/src/types.js";

export type FetchPageOptions = Omit<SafeFetchOptions, "wantBody">;

function makeFinding(input: Omit<Finding, "id" | "status">): Finding {
  return { ...input, id: randomUUID(), status: "open" };
}

/** Fetches through the network policy (see packages/safe-fetch) and runs the HTML checks. */
export async function auditPage(inputUrl: string, options: FetchPageOptions): Promise<PageAudit> {
  const fetched = await safeFetch(inputUrl, { ...options, wantBody: (_s, h) => /text\/html/i.test(h["content-type"] ?? "") });
  const contentType = fetched.headers["content-type"] ?? null;
  const { finalUrl, redirectChain } = fetched;
  const early: Finding[] = [];
  if (redirectChain.length) early.push(makeFinding({
    ruleId: "http.redirect",
    category: "migration",
    severity: "medium",
    confidence: "high",
    title: "Page redirects",
    description: `The requested URL redirected ${redirectChain.length} time(s) before the final response.`,
    url: inputUrl,
    evidence: redirectChain.map((to, i) => ({ type: "header" as const, description: `Redirect hop ${i + 1}`, value: to })),
    recommendation: "Confirm the redirect points to the intended equivalent page, avoid chains, and link directly to the final URL."
  }));
  if (fetched.status >= 400) early.push(makeFinding({
    ruleId: "http.error-status",
    category: "migration",
    severity: "high",
    confidence: "high",
    title: `Page returned HTTP ${fetched.status}`,
    description: `The final URL responded with an HTTP error status (${fetched.status}).`,
    url: inputUrl,
    evidence: [{ type: "header", description: "HTTP status", value: fetched.status }],
    recommendation: "Confirm the URL should exist; restore it or redirect it to the equivalent page."
  }));
  if (!/text\/html/i.test(contentType ?? "")) {
    return emptyAudit(inputUrl, fetched.status, contentType, early, ["Response was not HTML; page-level SEO checks were skipped."], finalUrl, redirectChain);
  }

  const text = fetched.body.toString("utf8");
  const $ = load(text);
  const findings: Finding[] = [...early];
  // URLs resolve against <base href> when the page has one, exactly as a browser does.
  const baseHref = (() => { const b = $("base[href]").first().attr("href"); try { return b ? new URL(b, finalUrl).href : finalUrl; } catch { return finalUrl; } })();
  const abs = (v: string | undefined) => { try { return v ? new URL(v, baseHref).href.slice(0, 500) : ""; } catch { return ""; } };
  const srcsetUrls = (v: string | undefined) => parseSrcset(v).filter((u) => !/^data:/i.test(u)).map(abs).filter(Boolean).slice(0, 30);
  const clip = (v: string | null | undefined, n = 1000) => (v ? v.slice(0, n) : null);

  const title = clip($("title").first().text().trim() || null);
  const metaDescription = clip($('meta[name="description" i]').attr("content")?.trim() || null);
  const canonical = clip($('link[rel~="canonical" i]').attr("href")?.trim() || null, 500);
  // Every source can block indexing, and any one of them is enough: the meta tag does not override the X-Robots-Tag header.
  const robotsParts = [$('meta[name="robots" i]').attr("content"), $('meta[name="googlebot" i]').attr("content"), fetched.headers["x-robots-tag"]].map((v) => v?.trim()).filter((v): v is string => !!v);
  const robots = robotsParts.length ? [...new Set(robotsParts)].join(", ").slice(0, 500) : undefined;
  const h1 = $("h1").map((_, el) => $(el).text().trim().slice(0, 500)).get().filter(Boolean);
  const h2Count = $("h2").length;
  const h3Count = $("h3").length;
  const images = $("img");
  // Missing = no alt attribute at all. alt="" is valid (decorative), as is role=presentation / aria-hidden.
  const missingAlt = images.filter((_, el) => {
    const img = $(el), role = (img.attr("role") ?? "").toLowerCase();
    return img.attr("alt") === undefined && role !== "presentation" && role !== "none" && img.attr("aria-hidden") !== "true";
  }).length;
  const missingDimensions = images.filter((_, el) => !$(el).attr("width") || !$(el).attr("height")).length;
  const anchors = $("a[href]");
  let internal = 0;
  let external = 0;
  anchors.each((_, el) => {
    try {
      const target = new URL($(el).attr("href")!, baseHref);
      if (!/^https?:$/.test(target.protocol)) return;
      if (target.hostname === new URL(finalUrl).hostname) internal++; else external++;
    } catch { /* Ignore non-URL links such as mailto: and javascript:. */ }
  });
  // A preload with only imagesrcset (no href) is valid; one with neither is dropped.
  const preloads = $('link[rel~="preload" i]').map((_, el) => ({
    href: abs($(el).attr("href")), as: $(el).attr("as") ?? null, fetchPriority: $(el).attr("fetchpriority")?.toLowerCase() ?? null,
    srcsetUrls: srcsetUrls($(el).attr("imagesrcset"))
  })).get().filter((p) => p.href || p.srcsetUrls.length).slice(0, 50);
  const scripts = $("script[src]").map((_, el) => ({ src: abs($(el).attr("src")), defer: $(el).attr("defer") !== undefined, async: $(el).attr("async") !== undefined, module: ($(el).attr("type") ?? "").toLowerCase() === "module" })).get().filter((x) => x.src).slice(0, 300);
  const stylesheets = $('link[rel~="stylesheet" i], link[rel~="preload" i][as="style" i]').map((_, el) => {
    const rel = ($(el).attr("rel") ?? "").toLowerCase(), media = ($(el).attr("media") ?? "").toLowerCase();
    return { href: abs($(el).attr("href")), async: rel.includes("preload") || (media === "print" && $(el).attr("onload") !== undefined) };
  }).get().filter((x) => x.href).slice(0, 300);
  const imgTags = $("img").map((_, el) => ({ src: abs($(el).attr("src")), srcsetUrls: srcsetUrls($(el).attr("srcset")), fetchPriority: $(el).attr("fetchpriority")?.toLowerCase() ?? null, loading: $(el).attr("loading")?.toLowerCase() ?? null })).get().filter((x) => (x.src && !/^data:/i.test(x.src)) || x.srcsetUrls.length).slice(0, 60);
  const preconnects = [...new Set($('link[rel~="preconnect" i]').map((_, el) => { try { return new URL($(el).attr("href") ?? "", baseHref).origin; } catch { return ""; } }).get().filter(Boolean))].slice(0, 50);
  const jsonLdScripts = $('script[type^="application/ld+json" i]');
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
    description: "One or more images have no alt attribute at all. (An empty alt=\"\" is valid for decorative images and is not counted.)",
    url: inputUrl,
    evidence: [{ type: "html", description: "Image elements without an alt attribute", value: missingAlt }],
    recommendation: "Review each image and add meaningful alternative text for informative images; use alt=\"\" for decorative images."
  }));
  if (isNoindex(robots)) findings.push(makeFinding({
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
    statusCode: fetched.status,
    finalUrl,
    redirectChain,
    preloads, scripts, stylesheets, imgTags, preconnects,
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

function emptyAudit(url: string, statusCode: number, contentType: string | null, findings: Finding[], limitations: string[], finalUrl = url, redirectChain: string[] = []): PageAudit {
  return {
    schemaVersion: "1.0.0", url, fetchedAt: new Date().toISOString(), statusCode, finalUrl, redirectChain, contentType,
    title: null, metaDescription: null, canonical: null, robots: null,
    headings: { h1: [], h2Count: 0, h3Count: 0 },
    images: { total: 0, missingAlt: 0, missingDimensions: 0 },
    links: { total: 0, internal: 0, external: 0 },
    schemaTypes: [], jsonLdBlocks: 0, findings, limitations
  };
}
