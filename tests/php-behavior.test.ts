import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { exactFixes, type ExactFixContext } from "../packages/reports/src/exact-fixes.js";
import { competingImages } from "../packages/browser-audit/src/lighthouse.js";
import type { LighthouseRun } from "../packages/contracts/src/types.js";

const P = "https://shop.test";
const HERO = `${P}/wp-content/uploads/2026/10/hero.png`;
const hasPhp = spawnSync("php", ["-v"]).status === 0;

const base = (over: Partial<ExactFixContext> = {}): ExactFixContext => ({
  pageUrl: `${P}/`, viewportWidth: 412, metrics: { lcpMs: 12900, fcpMs: 1650 },
  lcpPhases: [{ phase: "TTFB", ms: 600 }, { phase: "Load Delay", ms: 11500 }, { phase: "Load Time", ms: 100 }, { phase: "Render Delay", ms: 700 }],
  preloads: [{ href: HERO, as: "image", fetchPriority: "high" }],
  evidence: {
    "largest-contentful-paint-element": [{ selector: "div.cover > img", snippet: `<img decoding="async" fetchpriority="high" class="wp-block-cover__image-background wp-image-2516 size-full" alt="Hero" src="${HERO}">` }],
    "uses-responsive-images": [{ url: HERO, totalBytes: 802993, wastedBytes: 326704, displayWidth: 412, displayHeight: 769 }],
    "modern-image-formats": [{ url: HERO, totalBytes: 802993, wastedBytes: 600000, displayWidth: 412 }, { url: `${P}/wp-content/uploads/2026/10/tunnel.png`, totalBytes: 474000, wastedBytes: 380000 }],
    "render-blocking-resources": [{ url: `${P}/wp-content/themes/t/main.css?ver=1`, wastedMs: 300, totalBytes: 15000 }, { url: `${P}/wp-content/plugins/p/app.js?ver=2`, wastedMs: 100, totalBytes: 9000 }]
  },
  experiments: [{ id: "block-competing-images", description: "d", blocked: [`${P}/a.png`, `${P}/b.png`], lcpMs: 2200, performanceScore: 91, baselineLcpMs: 12900, baselinePerformance: 72 }],
  ...over
});
const lcpGroup = (c: ExactFixContext) => exactFixes(c).find((g) => g.area.startsWith("LCP"))!;

describe("LCP analysis", () => {
  it("explains a Load-Delay-dominated LCP when the image is already preloaded, with the measured what-if", () => {
    const g = lcpGroup(base());
    expect(g.measured).toContain("Load Delay 11.50 s");
    expect(g.note).toMatch(/89% of LCP is Load Delay, although the image is already preloaded/);
    expect(g.note).toContain("with 2 other heavy images blocked, simulated LCP is 2.20 s instead of 12.90 s");
    expect(g.fixes.map((f) => f.title).join("\n")).not.toMatch(/Preload the LCP image|high priority/);   // already applied: not re-recommended
  });
  it("never recommends low priority for other images (it could hurt other breakpoints)", () => {
    const all = exactFixes(base()).flatMap((g) => [g.note ?? "", ...g.fixes.map((f) => f.title + f.code)]).join("\n");
    expect(all).not.toMatch(/fetchpriority(=|["' ]+=>\s*)["']low/);
  });
  it("tells other dominant phases apart", () => {
    const phase = (name: string) => lcpGroup(base({ lcpPhases: [{ phase: name, ms: 9000 }, { phase: "TTFB", ms: 500 }], experiments: [] })).note;
    expect(phase("Load Time")).toMatch(/image download itself/); expect(phase("Render Delay")).toMatch(/render-blocking/); expect(phase("TTFB")).toMatch(/server response/);
    const notPreloaded = lcpGroup(base({ preloads: [], evidence: { "largest-contentful-paint-element": [{ snippet: `<img src="${HERO}">` }] } }));
    expect(notPreloaded.note).toMatch(/starts loading the image late/);
  });
  it("offers a srcset fix only for a full-bleed image that has none", () => {
    const titles = (c: ExactFixContext) => lcpGroup(c).fixes.map((f) => f.title).join("\n");
    expect(titles(base())).toMatch(/Add srcset\/sizes to that exact image/);
    expect(titles(base())).toMatch(/Check whether WordPress can build a srcset for attachment 2516/);
    const hasSrcset = base(); hasSrcset.evidence["largest-contentful-paint-element"] = [{ snippet: `<img class="wp-image-2516" srcset="a 1w" src="${HERO}">` }];
    expect(titles(hasSrcset)).not.toMatch(/srcset/);
    const notFull = base(); notFull.evidence["uses-responsive-images"] = [{ url: HERO, displayWidth: 200 }]; notFull.evidence["modern-image-formats"] = [];
    expect(titles(notFull)).not.toMatch(/Add srcset\/sizes/);          // 100vw would be wrong for a 200px image
    expect(titles(base({ viewportWidth: undefined }))).not.toMatch(/Add srcset\/sizes/);
  });
});

describe("no fixes for metrics that are already good", () => {
  it("skips the TBT group unless blocking time exceeds 200 ms", () => {
    const withTbt = (tbtMs: number) => exactFixes(base({ metrics: { tbtMs }, evidence: { "bootup-time": [{ url: `${P}/wp-content/plugins/p/app.js`, scriptingMs: 113 }] } })).some((g) => g.area.startsWith("TBT"));
    expect(withTbt(0)).toBe(false); expect(withTbt(200)).toBe(false); expect(withTbt(450)).toBe(true);
  });
});

describe("competingImages", () => {
  const run = (over: Partial<LighthouseRun>): LighthouseRun => ({ ok: true, scores: { performance: 1, accessibility: 1, bestPractices: 1, seo: 1 }, metrics: { fcpMs: 1, lcpMs: 1, tbtMs: 1, cls: 0, speedIndexMs: 1, ttiMs: 1 }, opportunities: [], runWarnings: [], evidence: {}, ...over });
  const img = (n: string, kb: number) => ({ url: `${P}/wp-content/uploads/${n}.png`, totalBytes: kb * 1024, resourceType: "Image", priority: "Low" });
  const ev = { "largest-contentful-paint-element": [{ snippet: `<img src="${HERO}">` }], "network-requests": [{ ...img("hero", 785), url: HERO }, img("a", 400), img("b", 300), img("tiny", 20), { url: `${P}/app.js`, totalBytes: 900 * 1024, resourceType: "Script" }] };
  const delay = { lcpPhases: [{ phase: "TTFB", ms: 500 }, { phase: "Load Delay", ms: 9000 }, { phase: "Load Time", ms: 100 }] };
  it("selects only heavy non-LCP images, and only when Load Delay dominates", () => {
    expect(competingImages(run({ ...delay, evidence: ev }))).toEqual([`${P}/wp-content/uploads/a.png`, `${P}/wp-content/uploads/b.png`]);
    expect(competingImages(run({ lcpPhases: [{ phase: "Load Time", ms: 9000 }, { phase: "TTFB", ms: 500 }], evidence: ev }))).toEqual([]);
    expect(competingImages(run({ ...delay, evidence: { ...ev, "network-requests": [img("a", 400)] } }))).toEqual([]);     // need at least two
    expect(competingImages(run({ evidence: ev }))).toEqual([]);                                                          // no phase data
  });
});

// Execute the generated PHP against WordPress function stubs and check what it actually does to markup.
const STUBS = `<?php
$GLOBALS['filters'] = array();
function add_filter( $tag, $fn, $p = 10, $n = 1 ) { $GLOBALS['filters'][ $tag ][] = $fn; }
function add_action( $tag, $fn, $p = 10, $n = 1 ) { add_filter( $tag, $fn ); }
function run_filter( $tag, ...$args ) { $v = $args[0]; foreach ( $GLOBALS['filters'][ $tag ] ?? array() as $fn ) { $a = $args; $a[0] = $v; $v = $fn( ...$a ); } return $v; }
function run_action( $tag ) { ob_start(); foreach ( $GLOBALS['filters'][ $tag ] ?? array() as $fn ) { $fn(); } return ob_get_clean(); }
function esc_attr( $s ) { return htmlspecialchars( $s, ENT_QUOTES ); }
function esc_url( $s ) { return $s; }
function is_front_page() { return true; }
function wp_unslash( $s ) { return $s; }
function trailingslashit( $s ) { return rtrim( $s, '/' ) . '/'; }
function wp_get_attachment_image_srcset( $id, $size ) { return 2516 === $id ? 'hero-480.png 480w, hero-1920.png 1920w' : false; }
`;
const php = (code: string, tail: string) => { const r = spawnSync("php", [], { input: `${STUBS}\n${code}\n${tail}`, encoding: "utf8" }); expect(r.stderr + r.stdout.match(/Parse error.*/)?.[0], code).not.toMatch(/error/i); return r.stdout; };
const fix = (c: ExactFixContext, area: RegExp, title: RegExp) => exactFixes(c).find((g) => area.test(g.area))!.fixes.find((f) => title.test(f.title))!.code;

describe.skipIf(!hasPhp)("generated PHP does what it says (executed with WordPress stubs)", () => {
  const tag = `<img decoding="async" class="wp-block-cover__image-background wp-image-2516 size-full" alt="Hero" src="${HERO}">`;
  it("srcset filter: adds srcset+sizes only to attachment 2516 and only when missing", () => {
    const code = fix(base(), /^LCP/, /Add srcset\/sizes/);
    const out = (html: string, id: number) => php(code, `echo run_filter( 'wp_content_img_tag', ${JSON.stringify(html)}, 'the_content', ${id} );`);
    const hero = out(tag, 2516);
    expect(hero).toContain('srcset="hero-480.png 480w, hero-1920.png 1920w" sizes="100vw"'); expect(hero).toContain(`src="${HERO}"`); expect(hero.match(/<img /g)).toHaveLength(1);
    expect(out(tag, 99)).toBe(tag);                                                        // another attachment: untouched
    expect(out(tag.replace("<img ", '<img srcset="x 1w" '), 2516)).toContain('srcset="x 1w"');
    expect(out(tag.replace("<img ", '<img srcset="x 1w" '), 2516).match(/srcset=/g)).toHaveLength(1);   // not doubled
  });
  it("LCP priority filter: adds fetchpriority=high and removes lazy, for that image only", () => {
    const c = base({ preloads: [], evidence: { "largest-contentful-paint-element": [{ selector: "img", snippet: `<img src="${HERO}">` }] } });
    const code = fix(c, /^LCP/, /high priority/);
    const run = (html: string) => php(code, `echo run_filter( 'wp_content_img_tag', ${JSON.stringify(html)} );`);
    const out = run(`<img loading="lazy" src="${HERO}">`);
    expect(out).toContain('fetchpriority="high"'); expect(out).not.toContain("lazy");
    expect(run(`<img loading="lazy" src="${P}/other.png">`)).toBe(`<img loading="lazy" src="${P}/other.png">`);
  });
  it("preload hook prints one correctly escaped link on the target page only", () => {
    const c = base({ preloads: [] });
    const out = php(fix(c, /^LCP/, /Preload the LCP image/), "echo run_action( 'wp_head' );");
    expect(out).toBe(`<link rel="preload" as="image" href="${HERO}" fetchpriority="high">\n`);
    const other = php(fix({ ...c, pageUrl: `${P}/about/` }, /^LCP/, /Preload the LCP image/).replace(/is_front_page\(\)/, "false"), "echo run_action( 'wp_head' );");
    expect(other).toBe("");
  });
  it("defer / async filters touch only the listed files", () => {
    const defer = fix(base(), /^FCP/, /Defer these/), async_ = fix(base(), /^FCP/, /stylesheets/);
    const script = (src: string) => php(defer, `echo run_filter( 'script_loader_tag', "<script src='${src}'></script>", 'h', '${src}' );`);
    expect(script(`${P}/wp-content/plugins/p/app.js?ver=2`)).toBe(`<script defer src='${P}/wp-content/plugins/p/app.js?ver=2'></script>`);
    expect(script(`${P}/wp-includes/js/jquery.js`)).toBe(`<script src='${P}/wp-includes/js/jquery.js'></script>`);   // not listed: untouched
    const link = `<link rel='stylesheet' href='${P}/wp-content/themes/t/main.css?ver=1' />`;
    const css = php(async_, `echo run_filter( 'style_loader_tag', ${JSON.stringify(link)}, 'h', '${P}/wp-content/themes/t/main.css?ver=1' );`);
    expect(css).toContain("rel='preload' as='style'"); expect(css).toContain("<noscript>" + link + "</noscript>");
    expect(php(async_, `echo run_filter( 'style_loader_tag', ${JSON.stringify(link)}, 'h', '${P}/other.css' );`)).toBe(link);
  });
});
