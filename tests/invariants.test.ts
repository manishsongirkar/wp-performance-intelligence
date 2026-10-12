import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { exactFixes, type ExactFixContext } from "../packages/reports/src/exact-fixes.js";

// Randomised state-space test. For hundreds of page states it checks the invariant behind every regression reported so far:
// advice must never contradict, or ignore, what the page already does, and unknown must never be treated as missing.
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const hasPhp = spawnSync("php", ["-v"]).status === 0;
const S = "https://stage.test", U = `${S}/wp-content/uploads/2026/10`, PLUG = `${S}/wp-content/plugins/p/build`;

interface Scenario { name: string; ctx: ExactFixContext; expect: { preloaded: boolean; prioritised: boolean | "unknown"; lazy: boolean | "unknown"; deferred: boolean | "unknown"; asyncCss: boolean | "unknown"; fontPre: boolean; preconnected: boolean; tbt: number } }

function scenario(r: () => number, n: number): Scenario {
  const pick = <T,>(...v: T[]) => v[Math.floor(r() * v.length)]!;
  const preloadKind = pick("none", "href", "imagesrcset", "other"), snippetKind = pick("full", "absent"), tagKind = pick("tag", "none");
  const prioritisedAttr = r() < 0.5, lazyAttr = r() < 0.3, hasSrcset = r() < 0.7;
  // What the browser actually loaded. It can only be a size variant when the tag has a srcset that lists it.
  const loaded = hasSrcset ? pick(`${U}/hero-1.webp`, `${U}/hero-1-1536x682.webp`) : `${U}/hero-1.webp`;
  const srcset = [`${U}/hero-1.webp`, `${U}/hero-1-768x341.webp`, `${U}/hero-1-1536x682.webp`];
  const attrs = `${prioritisedAttr ? ' fetchpriority="high"' : ""}${lazyAttr ? ' loading="lazy"' : ""}`;
  const snippet = `<img${attrs} class="wp-image-77" src="${U}/hero-1.webp"${hasSrcset ? ` srcset="${srcset.map((u, i) => `${u} ${[1920, 768, 1536][i]}w`).join(", ")}"` : ""}>`;
  const scriptKind = pick("defer", "async", "module", "blocking", "unknown"), cssKind = pick("async", "blocking", "unknown"), tbt = pick(0, 61, 200, 201, 450);
  const fontPre = r() < 0.5, preconnected = r() < 0.5;
  const ev: ExactFixContext["evidence"] = {
    "render-blocking-resources": [{ url: `${PLUG}/a.js?ver=1`, wastedMs: 100 }, { url: `${S}/wp-content/themes/t/main.css?ver=1`, wastedMs: 200 }],
    "bootup-time": [{ url: `${PLUG}/splide.js?ver=2`, scriptingMs: 145 }],
    "font-display": [{ url: `${S}/fonts/f.woff2` }], "uses-rel-preconnect": [{ url: "https://cdn.test/x" }],
    ...(snippetKind === "full" ? { "largest-contentful-paint-element": [{ selector: "img", snippet }] } : {})
  };
  const scripts = scriptKind === "unknown" ? undefined : [`${PLUG}/a.js`, `${PLUG}/splide.js`].map((src) => ({ src: `${src}?ver=9`, defer: scriptKind === "defer", async: scriptKind === "async", module: scriptKind === "module" }));
  const ctx: ExactFixContext = {
    pageUrl: `${S}/`, evidence: ev, metrics: { lcpMs: 3000, fcpMs: 2500, tbtMs: tbt },
    lcpElement: { tag: "IMG", url: loaded }, viewportWidth: 412,
    preloads: [
      ...(preloadKind === "href" ? [{ href: `${U}/hero-1.webp`, as: "image", fetchPriority: "high" }] : []),
      ...(preloadKind === "imagesrcset" ? [{ href: `${U}/hero-1.webp`, as: "image", fetchPriority: "high", srcsetUrls: srcset }] : []),
      ...(preloadKind === "other" ? [{ href: `${U}/logo.webp`, as: "image", fetchPriority: null, srcsetUrls: [`${U}/logo-300x100.webp`] }] : []),
      ...(fontPre ? [{ href: `${S}/fonts/f.woff2`, as: "font", fetchPriority: null }] : [])
    ],
    scripts, stylesheets: cssKind === "unknown" ? undefined : [{ href: `${S}/wp-content/themes/t/main.css?ver=9`, async: cssKind === "async" }],
    imgTags: tagKind === "tag" ? [{ src: `${U}/hero-1.webp`, srcsetUrls: hasSrcset ? srcset : [], fetchPriority: prioritisedAttr ? "high" : null, loading: lazyAttr ? "lazy" : null }] : undefined,
    preconnects: preconnected ? ["https://cdn.test"] : []
  };
  const attrsKnown = snippetKind === "full" || tagKind === "tag";
  return {
    name: `#${n} preload=${preloadKind} snippet=${snippetKind} tag=${tagKind} prio=${prioritisedAttr} lazy=${lazyAttr} scripts=${scriptKind} css=${cssKind} tbt=${tbt} font=${fontPre} pc=${preconnected}`, ctx,
    expect: {
      preloaded: preloadKind === "href" || preloadKind === "imagesrcset", prioritised: attrsKnown ? prioritisedAttr : "unknown", lazy: attrsKnown ? lazyAttr : "unknown",
      deferred: scriptKind === "unknown" ? "unknown" : scriptKind !== "blocking", asyncCss: cssKind === "unknown" ? "unknown" : cssKind === "async", fontPre, preconnected, tbt
    }
  };
}

describe("advice never contradicts the page state (400 random states)", () => {
  const r = rng(20261012);
  const scenarios = Array.from({ length: 400 }, (_, n) => scenario(r, n));
  it("holds for every state", () => {
    for (const { name, ctx, expect: e } of scenarios) {
      const groups = exactFixes(ctx), all = groups.flatMap((g) => g.fixes), titles = all.map((f) => f.title).join("\n"), code = all.map((f) => f.code).join("\n");
      const lcp = groups.find((g) => g.area.startsWith("LCP"))!;
      // LCP image
      expect(/Preload the LCP image/.test(titles), `${name}: preload advice vs preloaded=${e.preloaded}`).toBe(!e.preloaded);
      if (e.prioritised === "unknown" || e.lazy === "unknown") {
        expect(titles, `${name}: must not guess`).not.toMatch(/high priority|Remove loading/);
        expect(lcp.applied ?? [], name).not.toContain('fetchpriority="high" is set on the LCP image');
        expect(lcp.applied ?? [], name).not.toContain("The LCP image is not lazy-loaded");
      } else {
        expect(/high priority|Remove loading/.test(titles), `${name}: priority advice vs prio=${e.prioritised} lazy=${e.lazy}`).toBe(!e.prioritised || e.lazy === true);
        expect((lcp.applied ?? []).includes('fetchpriority="high" is set on the LCP image'), name).toBe(e.prioritised === true);
      }
      expect((lcp.applied ?? []).includes("Preload for the LCP image is present"), name).toBe(e.preloaded);
      // scripts / css / fonts / preconnect (the FCP group)
      const jsListed = /'\/wp-content\/plugins\/p\/build\/a\.js'/.test(code), cssListed = /'\/wp-content\/themes\/t\/main\.css'/.test(code);
      expect(jsListed, `${name}: a.js listed vs deferred=${e.deferred}`).toBe(e.deferred === true ? false : true);
      expect(cssListed, `${name}: main.css listed vs async=${e.asyncCss}`).toBe(e.asyncCss === true ? false : true);
      expect(/f\.woff2/.test(all.filter((f) => f.language === "html" && /Preload the web fonts/.test(f.title)).map((f) => f.code).join("")), name).toBe(!e.fontPre);
      expect(/cdn\.test/.test(code), `${name}: preconnect listed`).toBe(!e.preconnected);
      // TBT: never for a metric that is within the Good limit; never "defer" for a script that already defers
      expect(groups.some((g) => g.area.startsWith("TBT")), `${name}: TBT group vs tbt=${e.tbt}`).toBe(e.tbt > 200);
      if (e.tbt > 200 && e.deferred === true) expect(titles, name).not.toMatch(/Defer the scripts/);
      if (e.tbt > 200 && e.deferred !== true) expect(titles, name).toMatch(/Defer the scripts/);
      // nothing is ever generated with fake values
      expect(code, name).not.toMatch(/example\.com|YOUR-SITE/);
    }
  });
  it("covers every combination of the interesting states", () => {
    const seen = new Set(scenarios.map((s) => [s.expect.preloaded, s.expect.prioritised, s.expect.lazy, s.expect.deferred].join("/")));
    expect(seen.size).toBeGreaterThanOrEqual(20);
  });
  it("every generated bash/PHP snippet is syntactically valid, across all states", () => {
    const seen = new Set<string>(); let checked = 0;
    for (const { ctx } of scenarios) for (const f of exactFixes(ctx).flatMap((g) => g.fixes)) {
      if (seen.has(f.code) || (f.language !== "bash" && f.language !== "php")) continue; seen.add(f.code);
      if (f.language === "bash") { const x = spawnSync("bash", ["-n"], { input: f.code, encoding: "utf8" }); expect(x.status, `${f.title}\n${x.stderr}`).toBe(0); checked++; }
      else if (hasPhp) { const x = spawnSync("php", ["-l"], { input: f.code.startsWith("<?php") ? f.code : `<?php\n${f.code}\n`, encoding: "utf8" }); expect(x.status, `${f.title}\n${x.stdout}`).toBe(0); checked++; }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });
});
