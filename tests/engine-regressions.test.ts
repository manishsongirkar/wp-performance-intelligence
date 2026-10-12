import { describe, expect, it } from "vitest";
import { exactFixes, type ExactFixContext } from "../packages/reports/src/exact-fixes.js";
import { renderHtmlReport } from "../packages/reports/src/html.js";
import type { LighthouseMeasurement } from "../packages/contracts/src/types.js";

// Defects found by independent review of the recommendation engine. Each assertion pins the exact behaviour, not "something happened".
const S = "https://stage.test", U = `${S}/wp-content/uploads/2026/10`;
const lcpGroup = (c: ExactFixContext) => exactFixes(c).find((g) => g.area.startsWith("LCP"));
const titles = (g?: { fixes: Array<{ title: string }> }) => (g?.fixes ?? []).map((f) => f.title).join("\n");
const base = (over: Partial<ExactFixContext> = {}): ExactFixContext => ({ pageUrl: `${S}/`, metrics: { lcpMs: 3000, fcpMs: 2500 }, evidence: {}, ...over });
const imgEvidence = (src: string, extra = "") => ({ "largest-contentful-paint-element": [{ selector: "img", snippet: `<img ${extra} src="${src}">` }] });

describe("LCP image conversion", () => {
  const withWeight = (url: string) => base({ lcpElement: { tag: "IMG", url }, evidence: { ...imgEvidence(url), "uses-responsive-images": [{ url, totalBytes: 800_000, wastedBytes: 500_000 }] } });
  it("never converts a file onto itself: already-modern, vector and animated formats get no convert command", () => {
    for (const ext of ["webp", "avif", "svg", "gif"]) expect(titles(lcpGroup(withWeight(`${U}/hero.${ext}`))), ext).not.toMatch(/Convert this exact file/);
    for (const ext of ["png", "jpg", "jpeg"]) expect(titles(lcpGroup(withWeight(`${U}/hero.${ext}`))), ext).toMatch(/Convert this exact file/);
  });
  it("downloads by URL (works from any folder, site in a subdirectory, names with spaces) and writes to a separate folder", () => {
    const code = lcpGroup(withWeight(`${U}/my%20hero.png`))!.fixes.find((f) => /Convert this exact file/.test(f.title))!.code;
    expect(code).toContain(`'${U}/my%20hero.png'`); expect(code).toContain('OUT=./webp-out'); expect(code).not.toMatch(/-o '?wp-content/);
  });
});

describe("LCP analysis uses the right element and a consistent story", () => {
  it("does not judge the browser's LCP image by a Lighthouse snippet that describes a DIFFERENT image", () => {
    const g = lcpGroup(base({ lcpElement: { tag: "IMG", url: `${U}/A.jpg` }, evidence: imgEvidence(`${U}/B.jpg`, 'fetchpriority="high"') }))!;
    expect(g.applied).not.toContain('fetchpriority="high" is set on the LCP image');          // that attribute belongs to B, not A
    expect(g.note).toMatch(/different LCP element/);
    expect(titles(g)).not.toMatch(/high priority/);                                           // attributes of A are unknown: no guess either way
  });
  it("does treat the same image under another folder or size as the same element", () => {
    const g = lcpGroup(base({ lcpElement: { tag: "IMG", url: `${U}/hero-1536x682.webp` }, evidence: imgEvidence(`${S}/other/hero.webp`, 'fetchpriority="high"') }))!;
    expect(g.applied).toContain('fetchpriority="high" is set on the LCP image');
  });
  it("the Load Delay note never contradicts what is applied", () => {
    const phases = [{ phase: "TTFB", ms: 500 }, { phase: "Load Delay", ms: 9000 }, { phase: "Load Time", ms: 100 }];
    const url = `${U}/h.webp`, pre = [{ href: url, as: "image", fetchPriority: null }];
    // preload present, priority missing: must ask for priority, must NOT claim a preload is needed
    const a = lcpGroup(base({ lcpPhases: phases, preloads: pre, lcpElement: { tag: "IMG", url }, evidence: imgEvidence(url) }))!;
    expect(a.note).toContain('Add fetchpriority="high"'); expect(a.note).not.toMatch(/a preload|already preloaded and high priority/);
    // priority present, preload missing: ask for the preload only
    const b = lcpGroup(base({ lcpPhases: phases, preloads: [], lcpElement: { tag: "IMG", url }, evidence: imgEvidence(url, 'fetchpriority="high"') }))!;
    expect(b.note).toContain("Add a preload"); expect(b.note).not.toContain("fetchpriority");
    // both missing
    expect(lcpGroup(base({ lcpPhases: phases, preloads: [], lcpElement: { tag: "IMG", url }, evidence: imgEvidence(url) }))!.note).toContain('Add a preload and fetchpriority="high"');
    // both present: the bandwidth explanation
    expect(lcpGroup(base({ lcpPhases: phases, preloads: pre, lcpElement: { tag: "IMG", url }, evidence: imgEvidence(url, 'fetchpriority="high"') }))!.note).toContain("although the image is already preloaded and high priority");
    // preload present, attributes unknown: no claim about priority
    const c = lcpGroup(base({ lcpPhases: phases, preloads: pre, lcpElement: { tag: "IMG", url }, evidence: {} }))!;
    expect(c.note).toContain("although the image is already preloaded"); expect(c.note).not.toContain("high priority");
  });
  it("claims 'no srcset' only when every source agrees", () => {
    const url = `${U}/h-1536x682.webp`, ev = imgEvidence(`${U}/h.webp`, 'class="wp-image-9"');
    const withTag = (srcsetUrls: string[]) => base({ lcpElement: { tag: "IMG", url }, evidence: ev, viewportWidth: 412, imgTags: [{ src: `${U}/h.webp`, srcsetUrls, fetchPriority: null, loading: null }] });
    expect(titles(lcpGroup(withTag([])))).toMatch(/Check whether WordPress can build a srcset for attachment 9/);
    expect(titles(lcpGroup(withTag([url, `${U}/h-300x100.webp`])))).not.toMatch(/srcset for attachment/);       // the HTML shows a srcset even though Lighthouse's snippet omitted it
  });
});

describe("recommendations never print invented or unsafe code", () => {
  it("CLS: no made-up CSS class; lists the elements Lighthouse says shift, and unsized images get a real command", () => {
    const none = exactFixes(base({ metrics: { cls: 0.4 }, evidence: {} }));
    expect(none.find((g) => g.area.startsWith("CLS"))).toBeUndefined();                       // cause unknown: say nothing rather than invent a class
    const g = exactFixes(base({ metrics: { cls: 0.4 }, evidence: { "layout-shifts": [{ selector: "div.late-banner > img" }, { selector: "div.late-banner > img" }, { selector: "header.site" }] } })).find((x) => x.area.startsWith("CLS"))!;
    expect(g.fixes).toEqual([]); expect(g.note).toContain("div.late-banner > img; header.site");
    const u = exactFixes(base({ metrics: { cls: 0.4 }, evidence: { "unsized-images": [{ url: `${U}/logo.png` }] } })).find((x) => x.area.startsWith("CLS"))!;
    expect(u.fixes[0]!.code).toContain("attachment_url_to_postid");
    expect(JSON.stringify(exactFixes(base({ metrics: { cls: 0.4 }, evidence: { "unsized-images": [{ url: `${U}/l.png` }] } })))).not.toContain("late-banner {");
  });
  it("the generic WebP-for-new-uploads filter appears only when something convertible was flagged", () => {
    const g = (url: string) => exactFixes(base({ evidence: { "uses-responsive-images": [{ url, totalBytes: 900_000, wastedBytes: 500_000 }] } })).find((x) => x.area.startsWith("Images"))!;
    expect(titles(g(`${U}/a.webp`))).not.toMatch(/Generate WebP for new uploads|Download and convert/);   // already WebP: only the regenerate command
    expect(titles(g(`${U}/a.webp`))).toMatch(/Regenerate the WordPress sizes/);
    expect(titles(g(`${U}/a.png`))).toMatch(/Generate WebP for new uploads/);
    expect(titles(g(`${U}/a.svg`))).not.toMatch(/Download and convert/);
  });
  it("the audited page's query string is part of the page condition ('/?p=12' is not the front page)", () => {
    const g = (pageUrl: string) => exactFixes(base({ pageUrl, lcpElement: { tag: "IMG", url: `${U}/h.png` }, evidence: imgEvidence(`${U}/h.png`) })).find((x) => x.area.startsWith("LCP"))!.fixes.find((f) => /Preload/.test(f.title))!.code;
    expect(g(`${S}/`)).toContain("is_front_page()");
    expect(g(`${S}/?p=12`)).not.toContain("is_front_page()"); expect(g(`${S}/?p=12`)).toContain("=== '/?p=12'");
    expect(g(`${S}/about/`)).toContain("=== '/about/'");
  });
});

describe("render-blocking advice respects metric health, font types and origins", () => {
  const ev = { "render-blocking-resources": [{ url: `${S}/a.css`, wastedMs: 100 }], "font-display": [{ url: `${S}/f.woff2` }, { url: `${S}/f.ttf` }, { url: `${S}/f.otf` }, { url: `${S}/f.eot` }, { url: `${S}/f.woff` }], "uses-rel-preconnect": [{ url: "https://fonts.gstatic.com/s/x.woff2" }, { url: "https://cdn.test/y.js" }] };
  it("skips async-CSS/defer/font/preconnect advice once FCP is Good", () => {
    expect(exactFixes(base({ metrics: { fcpMs: 900 }, evidence: ev })).find((g) => g.area.startsWith("FCP"))).toBeUndefined();
    expect(exactFixes(base({ metrics: { fcpMs: 1800 }, evidence: ev })).find((g) => g.area.startsWith("FCP"))).toBeUndefined();
    expect(exactFixes(base({ metrics: { fcpMs: 1801 }, evidence: ev })).find((g) => g.area.startsWith("FCP"))).toBeDefined();
  });
  it("uses the right MIME type per font, never preloads .eot, and preloads at most two fonts", () => {
    const g = exactFixes(base({ metrics: { fcpMs: 3000 }, evidence: ev })).find((x) => x.area.startsWith("FCP"))!;
    const html = g.fixes.find((f) => /Preload the web fonts/.test(f.title))!.code;
    expect(html.split("\n")).toHaveLength(2); expect(html).toContain('type="font/woff2"'); expect(html).toContain('type="font/ttf"'); expect(html).not.toContain(".eot");
    expect(exactFixes(base({ metrics: { fcpMs: 3000 }, evidence: { "font-display": [{ url: `${S}/a.ttf` }, { url: `${S}/b.otf` }] } })).find((x) => x.area.startsWith("FCP"))!.fixes[0]!.code)
      .toBe(`<link rel="preload" as="font" type="font/ttf" crossorigin href="${S}/a.ttf">\n<link rel="preload" as="font" type="font/otf" crossorigin href="${S}/b.otf">`);
  });
  it("font origins get crossorigin on the preconnect, and an unreadable page is said to be unread", () => {
    const g = exactFixes(base({ metrics: { fcpMs: 3000 }, evidence: ev })).find((x) => x.area.startsWith("FCP"))!;
    const pc = g.fixes.find((f) => /Preconnect/.test(f.title))!;
    expect(pc.code).toContain("array( 'href' => 'https://fonts.gstatic.com', 'crossorigin' => 'anonymous' )"); expect(pc.code).toContain("$urls[] = 'https://cdn.test';");
    expect(pc.note).toMatch(/page HTML could not be read/);
    const read = exactFixes(base({ metrics: { fcpMs: 3000 }, evidence: ev, preconnects: [] })).find((x) => x.area.startsWith("FCP"))!.fixes.find((f) => /Preconnect/.test(f.title))!;
    expect(read.note).toBeUndefined();
  });
});

describe("removing 'unused' code carries a warning", () => {
  it("scripts and styles that are almost unused get an explicit interaction/dependency warning", () => {
    const g = exactFixes(base({ evidence: { "unused-javascript": [{ url: `${S}/menu.js`, totalBytes: 50_000, wastedBytes: 48_000 }], "unused-css-rules": [{ url: `${S}/old.css`, totalBytes: 40_000, wastedBytes: 39_500 }] } }));
    expect(g.find((x) => x.area === "Unused JavaScript")!.fixes[0]!.note).toMatch(/interaction/);
    expect(g.find((x) => x.area === "Unused JavaScript")!.fixes[0]!.note).toMatch(/depends on the handle/);
    expect(g.find((x) => x.area === "Unused CSS")!.fixes[0]!.note).toMatch(/menus, modals, tabs/);
  });
});

describe("Lighthouse opportunity advice: per opportunity, not all-or-nothing", () => {
  const lh = (opps: Array<{ id: string; title: string; savingsMs: number }>, evidence = {}): LighthouseMeasurement => ({
    schemaVersion: "1.0.0", source: "lab", engine: "lighthouse", url: `${S}/`, finalUrl: null, measuredAt: "x", profile: "mobile", status: "complete",
    metadata: { lighthouseVersion: "13", browser: "c", throttlingMethod: "simulate", formFactor: "mobile", runs: 1 },
    runs: [{ ok: true, scores: { performance: 50, accessibility: 1, bestPractices: 1, seo: 1 }, metrics: { fcpMs: 3000, lcpMs: 1, tbtMs: 1, cls: 0, speedIndexMs: 1, ttiMs: 1 }, opportunities: opps, runWarnings: [], evidence }],
    summary: { fcpMs: { median: 3000, min: 3000, max: 3000, samples: 1 } }, limitations: []
  });
  const html = (m: LighthouseMeasurement) => renderHtmlReport({ audits: [], comparisons: [], measurements: [], lighthouse: [{ measurement: m, reportFiles: [] }] });
  it("an exact group for one opportunity does not silence the generic advice for another", () => {
    const out = html(lh([{ id: "uses-text-compression", title: "Enable text compression", savingsMs: 400 }, { id: "uses-long-cache-ttl", title: "Cache", savingsMs: 100 }, { id: "modern-image-formats", title: "Images", savingsMs: 900 }],
      { "unsized-images": [{ url: `${U}/l.png` }], "modern-image-formats": [{ url: `${U}/a.png`, totalBytes: 900_000, wastedBytes: 500_000 }] }));
    expect(out).toContain("Enable gzip/brotli (nginx)"); expect(out).toContain("Long cache lifetime for static assets (Apache)");
    expect(out.split("Generate WebP for new uploads").length - 1).toBe(1);                       // the exact Images group covers it once, not twice
  });
  it("shows generic advice when nothing exact exists, with obvious placeholders and both JavaScript MIME types", () => {
    const out = html(lh([{ id: "render-blocking-resources", title: "Eliminate render-blocking resources", savingsMs: 300 }, { id: "uses-long-cache-ttl", title: "Cache", savingsMs: 100 }]));
    expect(out).toContain("YOUR-HANDLE"); expect(out).not.toContain("my-script"); expect(out).toContain("text/javascript");
  });
});

describe("Lighthouse 13 reports OBSERVED LCP phases: the simulated LCP is read against them", () => {
  const phases = [{ phase: "TTFB", ms: 180 }, { phase: "Load Delay", ms: 15 }, { phase: "Load Time", ms: 290 }, { phase: "Render Delay", ms: 40 }];   // observed total 525 ms
  const url = `${U}/h.webp`, pre = [{ href: url, as: "image", fetchPriority: "high" }];
  const g = (lcpMs: number, over: Partial<ExactFixContext> = {}) => lcpGroup(base({ metrics: { lcpMs }, lcpPhases: phases, lcpElement: { tag: "IMG", url }, evidence: imgEvidence(url, 'fetchpriority="high"'), preloads: pre, ...over }))!;
  it("a simulated LCP far above the observed total is explained as the throttled network, with the what-if if one was measured", () => {
    const withExp = g(12_000, { experiments: [{ id: "block-competing-images", description: "d", blocked: ["a", "b"], lcpMs: 6_500, performanceScore: 76, baselineLcpMs: 12_000, baselinePerformance: 72 }] });
    expect(withExp.note).toContain("add up to only 525 ms"); expect(withExp.note).toContain("simulated slow-connection LCP is 12.00 s");
    expect(withExp.note).toContain("with 2 other heavy images blocked, simulated LCP is 6.50 s instead of 12.00 s");
    expect(withExp.measured).toContain("(simulated) · observed phases: TTFB 180 ms + Load Delay 15 ms");
  });
  it("no throttle-gap story when the LCP is simply close to the observed total, or fast", () => {
    expect(g(900).note ?? "").not.toMatch(/throttled network/);
    expect(g(2_400).note ?? "").not.toMatch(/throttled network/);                         // below 2.5 s: nothing to explain
    expect(g(600).measured).toContain("= TTFB 180 ms + Load Delay 15 ms");          // 525 ms of phases for a 600 ms LCP: they add up
  });
  it("missing prioritisation still comes first", () => {
    const n = g(12_000, { preloads: [], evidence: imgEvidence(url) }).note!;
    expect(n).toContain('add a preload and fetchpriority="high"'); expect(n).not.toContain("throttled network");
  });
});

describe("the LCP breakdown line is only an equation when the phases add up", () => {
  const url = `${U}/h.webp`;
  const measured = (lcpMs: number, ms: number[]) => lcpGroup(base({ metrics: { lcpMs }, lcpPhases: ["TTFB", "Load Delay", "Load Time", "Render Delay"].map((phase, i) => ({ phase, ms: ms[i]! })), lcpElement: { tag: "IMG", url }, evidence: imgEvidence(url, 'fetchpriority="high"'), preloads: [{ href: url, as: "image", fetchPriority: null }] }))!.measured;
  it("Lighthouse 12 style (simulated phases that sum to the LCP) keeps '='", () => expect(measured(12_000, [600, 10_800, 100, 500])).toContain("= TTFB 600 ms + Load Delay 10.80 s"));
  it("Lighthouse 13 style (observed phases far below the LCP) is labelled, even for a fast LCP", () => {
    expect(measured(1_990, [113, 5, 75, 56])).toContain("(simulated) · observed phases: TTFB 113 ms + Load Delay 5 ms");
    expect(measured(1_990, [113, 5, 75, 56])).not.toContain("= TTFB");
  });
});
