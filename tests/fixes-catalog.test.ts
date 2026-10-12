import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { catalogRuleIds, fixesForDifference, fixesForRule, redirectFixes } from "../packages/reports/src/fixes.js";

const hasPhp = spawnSync("php", ["-v"]).status === 0;
const PAGE = "https://shop.example/about/", FINAL = "https://shop.example/about-us/";
const all = () => catalogRuleIds().flatMap((id) => fixesForRule(id, { pageUrl: PAGE, redirectTo: FINAL }).map((f) => ({ id, ...f })));

describe("every catalogue fix is usable as pasted", () => {
  it("covers a reasonable number of rules and fixes", () => expect(all().length).toBeGreaterThan(25));
  it("uses the real URL, never a fake example value", () => {
    for (const f of all()) { expect(f.code, `${f.id}: ${f.title}`).not.toMatch(/example\.com|old-page|new-page/); if (f.id !== "http.error-status") expect(f.code, f.title).not.toContain("YOUR-SITE"); }   // a 404 has no known replacement page: its placeholder is intentional and labelled
    expect(all().find((f) => f.title.startsWith("Find who sends noindex"))!.code).toContain(`curl -sI ${PAGE}`);
    expect(all().find((f) => f.title.startsWith("Find slow queries"))!.code).toContain(`--url=${PAGE}`);
  });
  it("has valid bash", () => {
    for (const f of all().filter((x) => x.language === "bash")) {
      const r = spawnSync("bash", ["-n"], { input: f.code, encoding: "utf8" });
      expect(r.status, `${f.id}: ${f.title}\n${r.stderr}`).toBe(0);
    }
  });
  it.skipIf(!hasPhp)("has valid PHP (lint)", () => {
    for (const f of all().filter((x) => x.language === "php")) {
      const r = spawnSync("php", ["-l"], { input: f.code.startsWith("<?php") ? f.code : `<?php\n${f.code}\n`, encoding: "utf8" });   // template files already open with <?php
      expect(r.status, `${f.id}: ${f.title}\n${r.stdout}${r.stderr}`).toBe(0);
    }
  });
  it("wp-cli examples that embed PHP have valid PHP", () => {
    if (!hasPhp) return;
    for (const f of all().filter((x) => /wp eval '/.test(x.code))) {
      const r = spawnSync("php", ["-l"], { input: `<?php ${/wp eval '([^']+)'/.exec(f.code)![1]}`, encoding: "utf8" });
      expect(r.status, f.title).toBe(0);
    }
  });
});

describe("redirect fixes", () => {
  it("are exact when source and target are known (the path is matched exactly, the query string is ignored)", () => {
    const [apache, nginx, wp] = redirectFixes(PAGE, FINAL);
    expect(apache!.code).toBe(`RedirectMatch 301 ^/about/$ ${FINAL}`);
    expect(nginx!.code).toBe(`location = /about/ { return 301 "${FINAL}"; }`);
    expect(wp!.code).toContain("wp_safe_redirect( 'https://shop.example/about-us/', 301 )");     // same host
    expect(wp!.code).not.toContain("$query");
    expect(wp!.note).toMatch(/Exact rule/);
  });
  it("escapes regex characters in the Apache pattern, so /a.b/ does not also match /axb/", () => {
    expect(redirectFixes("https://s.test/a.b/", "https://s.test/c/")[0]!.code).toBe("RedirectMatch 301 ^/a\\.b/$ https://s.test/c/");
  });
  it("NEVER produces a rule that redirects a URL to itself", () => {
    expect(redirectFixes("https://a.com/about/", "https://a.com/about/")).toEqual([]);
    expect(redirectFixes("https://a.com/about/?x=1", "https://a.com/about/?x=1")).toEqual([]);
    // http -> https and www -> bare keep the path: the rule must be domain-level, not path-level
    for (const [from, to] of [["http://a.com/about/", "https://a.com/about/"], ["https://www.a.com/about/", "https://a.com/about/"], ["http://a.com/", "https://www.a.com/"]] as const) {
      const fixes = redirectFixes(from, to);
      expect(fixes.length, `${from} -> ${to}`).toBeGreaterThan(0);
      for (const f of fixes) { expect(f.language, f.title).not.toBe("php"); expect(f.code, f.title).not.toMatch(/RedirectMatch|location = \//); expect(f.note).toMatch(/loop/); }
    }
    expect(redirectFixes("http://a.com/about/", "https://a.com/about/")[0]!.code).toBe("RewriteEngine On\nRewriteCond %{HTTPS} off\nRewriteRule ^ https://a.com%{REQUEST_URI} [L,R=301]");
    expect(redirectFixes("http://a.com/about/", "https://a.com/about/")[1]!.code).toContain('return 301 "https://a.com$request_uri";');
  });
  it("handles a source with a query string without catching the whole path", () => {
    const [apache, nginx, wp] = redirectFixes("https://a.com/?p=12", "https://a.com/hello/");
    expect(apache!.code).toBe("RewriteEngine On\nRewriteCond %{QUERY_STRING} ^p=12$\nRewriteRule ^$ https://a.com/hello/ [L,R=301]");
    expect(nginx!.code).toContain('if ($args = "p=12")'); expect(wp!.code).toContain("'p=12' === $query");
  });
  it("use wp_redirect for another host, and require a 404 only for broken URLs", () => {
    expect(redirectFixes(PAGE, "https://other.example/x/")[2]!.code).toContain("wp_redirect(");
    expect(redirectFixes(PAGE, undefined, true)[2]!.code).toContain("is_404() && ");
    expect(redirectFixes(PAGE, FINAL)[2]!.code).not.toContain("is_404");
  });
  it("show obvious CAPITALISED placeholders when something is unknown, never a plausible fake", () => {
    const code = redirectFixes(undefined, undefined, true).map((f) => f.code).join("\n");
    expect(code).toContain("/OLD-PATH/"); expect(code).toContain("https://YOUR-SITE/NEW-PATH/"); expect(code).not.toMatch(/example\.com|old-page/);
    expect(fixesForRule("http.error-status", { pageUrl: PAGE })[0]!.code).toBe("RedirectMatch 301 ^/about/$ https://YOUR-SITE/NEW-PATH/");
    expect(fixesForRule("http.error-status", { pageUrl: PAGE })[0]!.note).toMatch(/CAPITALISED/);
  });
  it("ignores URLs that could break out of the config (falls back to placeholders)", () => {
    const code = redirectFixes("https://a.test/x'; rm -rf ~; '", "https://b.test/y\nRewriteRule evil").map((f) => f.code).join("\n");
    expect(code).not.toContain("rm -rf"); expect(code).not.toContain("RewriteRule evil"); expect(code).toContain("OLD-PATH");
    expect(redirectFixes("https://a.test/x/", "https://b.test/y;return 200")[0]!.code).toContain("YOUR-SITE");        // ';' is not allowed in a target URL
  });
  it.skipIf(!hasPhp)("the WordPress redirect hook fires only on exactly that path (executed with stubs)", () => {
    const STUBS = `<?php
function add_action( $t, $fn ) { $GLOBALS['hook'] = $fn; }
function wp_unslash( $s ) { return $s; }
function wp_parse_url( $u, $c ) { return parse_url( $u, $c ); }
function is_404() { return ! empty( $GLOBALS['is404'] ); }
function wp_safe_redirect( $url, $code ) { echo "REDIRECT $code $url"; }
function wp_redirect( $url, $code ) { echo "WP_REDIRECT $code $url"; }
`;
    const run = (code: string, uri: string, is404 = false) => spawnSync("php", [], { input: `${STUBS}\n$GLOBALS['is404'] = ${is404};\n${code}\n$_SERVER['REQUEST_URI'] = ${JSON.stringify(uri)};\n( $GLOBALS['hook'] )();\necho 'NO-REDIRECT';`, encoding: "utf8" }).stdout;
    const known = redirectFixes(PAGE, FINAL)[2]!.code;
    expect(run(known, "/about/")).toBe(`REDIRECT 301 ${FINAL}`);
    expect(run(known, "/about/?utm=1")).toBe(`REDIRECT 301 ${FINAL}`);          // tracking parameters do not stop a path redirect
    expect(run(known, "/about-us/")).toBe("NO-REDIRECT");                       // the target itself: no loop
    expect(run(known, "/contact/")).toBe("NO-REDIRECT");
    const broken = redirectFixes(PAGE, FINAL, true)[2]!.code;
    expect(run(broken, "/about/", false)).toBe("NO-REDIRECT");                  // the page exists: leave it alone
    expect(run(broken, "/about/", true)).toBe(`REDIRECT 301 ${FINAL}`);
    const withQuery = redirectFixes("https://shop.example/?p=12", "https://shop.example/hello/")[2]!.code;
    expect(run(withQuery, "/?p=12")).toBe("REDIRECT 301 https://shop.example/hello/");
    expect(run(withQuery, "/")).toBe("NO-REDIRECT");                             // the plain home page is not caught
    expect(run(withQuery, "/?p=13")).toBe("NO-REDIRECT");
  });
});

describe("comparison advice follows the direction of the change", () => {
  const d = (title: string, oldValue: unknown, newValue: unknown) => fixesForDifference(title, { oldUrl: "https://old.shop/p/", newUrl: "https://new.shop/p/", oldValue, newValue });
  it("robots: only when indexing became blocked", () => {
    expect(d("Robots directive changed", null, "noindex, nofollow").length).toBeGreaterThan(0);
    expect(d("Robots directive changed", "noindex", null)).toEqual([]);                  // noindex was REMOVED: nothing to fix
    expect(d("Robots directive changed", "noindex", "noindex, nofollow")).toEqual([]);   // was already blocked
    expect(d("Robots directive changed", null, "max-image-preview:large")).toEqual([]);
  });
  it("canonical / description / title / H1: only when the new page lacks them", () => {
    expect(d("Canonical URL changed", "https://a/", null).length).toBeGreaterThan(0); expect(d("Canonical URL changed", "https://a/", "https://b/")).toEqual([]);
    expect(d("Meta description changed", "x", null).length).toBeGreaterThan(0); expect(d("Meta description changed", null, "added")).toEqual([]);
    expect(d("Page title changed", "x", "").length).toBeGreaterThan(0); expect(d("Page title changed", "x", "y")).toEqual([]);
    expect(d("H1 content changed", ["a"], []).length).toBeGreaterThan(0); expect(d("H1 content changed", ["a"], ["a", "b"]).length).toBeGreaterThan(0); expect(d("H1 content changed", ["a"], ["b"])).toEqual([]);
  });
  it("schema: only when types were lost; status: only when the new page is broken; links: never", () => {
    expect(d("Structured data types changed", ["Article", "Org"], ["Org"]).length).toBeGreaterThan(0); expect(d("Structured data types changed", ["Org"], ["Org", "Article"])).toEqual([]);
    expect(d("HTTP status changed", 200, 404)[0]!.code).toContain("RedirectMatch 301 ^/p/$ https://YOUR-SITE/NEW-PATH/");
    expect(d("HTTP status changed", 404, 200)).toEqual([]); expect(d("HTTP status changed", 301, 200)).toEqual([]);
    expect(d("Internal link count decreased", 10, 5)).toEqual([]); expect(d("More images lack alt text", 1, 5).length).toBeGreaterThan(0);
  });
  it("offers nothing when there are no values to judge the direction", () => expect(fixesForDifference("Canonical URL changed")).toEqual([]));
});
