import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { exactFixes, type ExactFixContext } from "../packages/reports/src/exact-fixes.js";
import { deltaInfo, renderHtmlReport } from "../packages/reports/src/html.js";
import type { LighthouseMeasurement } from "../packages/contracts/src/types.js";

const P = "https://shop.test";
const ctx = (over: Partial<ExactFixContext> = {}): ExactFixContext => ({
  pageUrl: `${P}/about-us/`, rerunCommand: "pnpm wpi report --lighthouse https://shop.test/about-us/ --baseline /tmp/x",
  metrics: { lcpMs: 12600, fcpMs: 1350, tbtMs: 300, cls: 0.2, ttfbMs: 900 },
  lcpElement: { tag: "IMG", url: `${P}/wp-content/uploads/2026/10/hero.png` },
  evidence: {
    "render-blocking-resources": [{ url: `${P}/wp-content/themes/t/main.css?ver=1`, wastedMs: 310, totalBytes: 15009 }, { url: `${P}/wp-content/plugins/p/app.js?ver=2`, wastedMs: 120, totalBytes: 9000 }],
    "unused-css-rules": [{ url: `${P}/wp-content/themes/t/main.css?ver=1`, totalBytes: 15009, wastedBytes: 11861 }, { url: `${P}/wp-content/plugins/p/legacy.css`, totalBytes: 40000, wastedBytes: 39500 }],
    "unused-javascript": [{ url: `${P}/wp-content/plugins/p/slider.js`, totalBytes: 50000, wastedBytes: 49000 }, { url: `${P}/wp-content/plugins/p/app.js`, totalBytes: 50000, wastedBytes: 20000 }],
    "bootup-time": [{ url: `${P}/wp-content/plugins/p/app.js?ver=2`, scriptingMs: 113, durationMs: 371 }, { url: `${P}/wp-content/plugins/p/tiny.js`, scriptingMs: 3 }],
    "modern-image-formats": [{ url: `${P}/wp-content/uploads/2026/10/hero.png`, totalBytes: 804090, wastedBytes: 600000 }],
    "uses-rel-preconnect": [{ url: "https://fonts.gstatic.com/s/x.woff2" }],
    "font-display": [{ url: `${P}/fonts/brand.woff2`, wastedMs: 200 }],
    "unsized-images": [{ url: `${P}/wp-content/uploads/2026/10/logo.png`, selector: "header img.logo" }],
    "largest-contentful-paint-element": [{ selector: "div.hero > img", snippet: '<img class="hero" src="/hero.png">' }]
  }, ...over
});
const all = (g: ReturnType<typeof exactFixes>) => g.flatMap((x) => x.fixes);
const text = (g: ReturnType<typeof exactFixes>) => all(g).map((f) => f.code).join("\n");

describe("exactFixes", () => {
  const groups = exactFixes(ctx());
  const areas = groups.map((g) => g.area.split(":")[0]);
  it("produces a group per measured problem, using the real URLs", () => {
    expect(areas).toEqual(expect.arrayContaining(["LCP", "FCP", "TBT", "Unused CSS", "Unused JavaScript", "Images (LCP, Speed Index, page weight)", "CLS", "Verify the improvement"]));
    const t = text(groups);
    expect(t).toContain("'/wp-content/uploads/2026/10/hero.png'");           // LCP preload + filter
    expect(t).toContain("'/wp-content/themes/t/main.css'");                    // render-blocking + purge
    expect(t).toContain("'/wp-content/plugins/p/app.js'");                     // defer
    expect(t).toContain("'/wp-content/plugins/p/slider.js'");                  // 98% unused -> dequeue
    expect(t).toContain("fetchpriority");
    expect(t).toContain("isset( $_SERVER['REQUEST_URI'] )");                    // page-scoped: not site-wide
    expect(t).toContain("=== '/about-us/'");
    expect(t).toContain("https://fonts.gstatic.com");
  });
  it("does not tell you to dequeue a stylesheet that is mostly used", () => {
    const dequeue = groups.find((g) => g.area === "Unused CSS")!.fixes.find((f) => f.code.includes("wp_dequeue_style"))!;
    expect(dequeue.code).toContain("legacy.css");
    expect(dequeue.code).not.toContain("main.css");
    const purge = groups.find((g) => g.area === "Unused CSS")!.fixes.find((f) => f.code.includes("purgecss"))!;
    expect(purge.note).toContain("Do NOT dequeue");
  });
  it("ignores trivial scripts and uses the front-page conditional for /", () => {
    expect(text(exactFixes(ctx()))).not.toContain("tiny.js");
    expect(text(exactFixes(ctx({ pageUrl: `${P}/` })))).toContain("is_front_page()");
  });
  it("recovers the LCP image URL from Lighthouse's element snippet when no browser measurement exists", () => {
    const g = exactFixes(ctx({ lcpElement: null, evidence: { "largest-contentful-paint-element": [{ selector: "img.x", snippet: '<img decoding="async" src="https://shop.test/wp-content/uploads/a.jpg" alt="x">' }] } }));
    expect(g[0]!.fixes[0]!.code).toContain("'https://shop.test/wp-content/uploads/a.jpg'");
    const rel = exactFixes(ctx({ lcpElement: null, evidence: { "largest-contentful-paint-element": [{ snippet: '<img src="/wp-content/uploads/b.jpg">' }] } }));
    expect(rel[0]!.fixes[0]!.code).toContain("https://shop.test/wp-content/uploads/b.jpg");
  });
  it("does not recommend a preload / fetchpriority that is already in place, and says so", () => {
    const applied = ctx({
      preloads: [{ href: `${P}/wp-content/uploads/2026/10/hero.png`, as: "image", fetchPriority: "high" }],
      evidence: {
        "largest-contentful-paint-element": [{ selector: "img.hero", snippet: `<img decoding="async" fetchpriority="high" class="hero" src="${P}/wp-content/uploads/2026/10/hero.png">` }],
        "modern-image-formats": [{ url: `${P}/wp-content/uploads/2026/10/hero.png`, totalBytes: 804090, wastedBytes: 600000 }]
      }
    });
    const lcp = exactFixes(applied).find((g) => g.area.startsWith("LCP"))!;
    expect(lcp.applied).toEqual(expect.arrayContaining(["Preload for the LCP image is present", 'fetchpriority="high" is set on the LCP image', "The LCP image is not lazy-loaded"]));
    const titles = lcp.fixes.map((f) => f.title).join("\n");
    expect(titles).not.toMatch(/Preload the LCP image/); expect(titles).not.toMatch(/high priority/);
    expect(titles).toMatch(/LCP image itself is heavy/);                       // the real remaining lever
    expect(lcp.fixes.map((f) => f.code).join("\n")).toContain("cwebp -q 82 'wp-content/uploads/2026/10/hero.png'");
    expect(lcp.note).toContain("remaining LCP time is mostly the image download");
  });
  it("still asks for the missing half, and for removing lazy-loading", () => {
    const only = (snippet: string, preloaded: boolean) => exactFixes(ctx({
      preloads: preloaded ? [{ href: `${P}/wp-content/uploads/2026/10/hero.png`, as: "image", fetchPriority: null }] : [],
      evidence: { "largest-contentful-paint-element": [{ snippet }] }
    })).find((g) => g.area.startsWith("LCP"))!.fixes.map((f) => f.title).join("\n");
    const src = `src="${P}/wp-content/uploads/2026/10/hero.png"`;
    expect(only(`<img fetchpriority="high" ${src}>`, false)).toMatch(/Preload the LCP image/);
    expect(only(`<img ${src}>`, true)).toMatch(/high priority/);
    expect(only(`<img loading="lazy" fetchpriority="high" ${src}>`, true)).toMatch(/Remove loading="lazy"/);
  });
  it("returns nothing when there is no evidence", () => expect(exactFixes({ pageUrl: P, evidence: {}, metrics: {} })).toEqual([]));

  it("never lets hostile site data break out of the generated code", () => {
    const evil = ctx({
      lcpElement: { tag: "IMG", url: `${P}/a'.png` },
      evidence: {
        "render-blocking-resources": [{ url: `${P}/x.css?a=');system('id');//` }, { url: `${P}/ok.css` }],
        "modern-image-formats": [{ url: `${P}/$(touch pwned).png`, wastedBytes: 1 }, { url: `${P}/b"c.png`, wastedBytes: 1 }, { url: `${P}/fine.png`, wastedBytes: 9, totalBytes: 10 }],
        "unsized-images": [{ url: `${P}/q'; rm -rf ~; '.png` }]
      }
    });
    const t = text(exactFixes(evil));
    expect(t).not.toMatch(/system\(/); expect(t).not.toContain("touch pwned"); expect(t).not.toContain("rm -rf"); expect(t).not.toContain('b"c');
    expect(t).toContain("fine.png"); expect(t).toContain("ok.css");
  });

  it("generates syntactically valid bash and PHP", () => {
    const fixes = all(exactFixes(ctx()));
    for (const f of fixes.filter((x) => x.language === "bash" && !x.code.includes("wp eval") && !x.code.includes("pnpm wpi"))) {
      const r = spawnSync("bash", ["-n"], { input: f.code, encoding: "utf8" });
      expect(r.status, `${f.title}\n${r.stderr}`).toBe(0);
    }
    const php = spawnSync("php", ["-v"]);
    if (php.status !== 0) return; // no PHP available: bash checks only
    for (const f of fixes.filter((x) => x.language === "php")) {
      const r = spawnSync("php", ["-l"], { input: `<?php\n${f.code}\n`, encoding: "utf8" });
      expect(r.status, `${f.title}\n${r.stdout}${r.stderr}`).toBe(0);
    }
  });
});

describe("deltaInfo", () => {
  const sum = (median: number, min = median, max = median) => ({ median, min, max, samples: 3 });
  it("direction and noise handling", () => {
    expect(deltaInfo("lcpMs", sum(2000), sum(12000, 11000, 13000))).toMatchObject({ cls: "good" });
    expect(deltaInfo("lcpMs", sum(14000), sum(12000, 11000, 13000))).toMatchObject({ cls: "bad" });
    expect(deltaInfo("lcpMs", sum(12500), sum(12000, 11000, 13000))).toMatchObject({ cls: "flat" });
    expect(deltaInfo("performanceScore", sum(95), sum(72))).toMatchObject({ cls: "good", text: expect.stringContaining("23 pts") });
    expect(deltaInfo("performanceScore", sum(60), sum(72))).toMatchObject({ cls: "bad" });
    expect(deltaInfo("lcpMs", sum(1), undefined)).toBeNull();
  });
});

describe("report with exact fixes and baseline", () => {
  const lh = (perf: number, lcp: number): { measurement: LighthouseMeasurement; reportFiles: string[] } => ({
    reportFiles: [], measurement: {
      schemaVersion: "1.0.0", source: "lab", engine: "lighthouse", url: `${P}/about-us/`, finalUrl: null, measuredAt: "x", profile: "mobile", status: "complete",
      metadata: { lighthouseVersion: "12", browser: "chromium", throttlingMethod: "simulate", formFactor: "mobile", runs: 1 },
      runs: [{ ok: true, scores: { performance: perf, accessibility: 1, bestPractices: 1, seo: 1 }, metrics: { fcpMs: 1, lcpMs: lcp, tbtMs: 1, cls: 0, speedIndexMs: 1, ttiMs: 1 }, opportunities: [], runWarnings: [], evidence: ctx().evidence }],
      summary: { performanceScore: { median: perf, min: perf, max: perf, samples: 1 }, lcpMs: { median: lcp, min: lcp, max: lcp, samples: 1 } }, limitations: []
    }
  });
  it("renders exact-fix groups and before/after deltas", () => {
    const html = renderHtmlReport({ audits: [], comparisons: [], measurements: [], lighthouse: [lh(90, 2500)], baseline: { generatedAt: "then", lighthouse: [lh(72, 12600)], measurements: [] }, rerunCommand: "pnpm wpi report" });
    expect(html).toContain("Exact fixes for this page");
    expect(html).toContain("/wp-content/uploads/2026/10/hero.png");
    expect(html).toContain("d-good");
    expect(html).toContain("metrics better");
  });
});
