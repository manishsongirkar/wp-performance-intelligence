import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateReport, normalizeProfiles, planSteps, type ReportRequest } from "../apps/api/src/report.js";
import { loadConfig } from "../apps/api/src/config.js";
import type { BrowserMeasurement, LighthouseMeasurement } from "../packages/contracts/src/types.js";

const base: ReportRequest = { audits: [], compares: [], measures: [], lighthouse: [], runs: 1, profiles: ["mobile"], outDir: "/tmp" };

describe("device profiles", () => {
  it("normalises to unique profiles, mobile first", () => {
    expect(normalizeProfiles(["desktop", "mobile"])).toEqual(["mobile", "desktop"]);
    expect(normalizeProfiles(["desktop", "desktop"])).toEqual(["desktop"]);
    expect(normalizeProfiles([])).toEqual([]);
  });
  it("plans one measure/Lighthouse step per URL and device, URL-outer so a page's devices sit together", () => {
    const r = { ...base, audits: ["https://a.test/"], compares: [["https://o.test/", "https://n.test/"]] as Array<[string, string]>, measures: ["https://a.test/"], lighthouse: ["https://a.test/", "https://b.test/"], profiles: ["desktop", "mobile"] as ReportRequest["profiles"] };
    expect(planSteps(r)).toEqual([
      "audit https://a.test/", "compare https://o.test/ vs https://n.test/",
      "measure https://a.test/ (mobile)", "measure https://a.test/ (desktop)",
      "lighthouse https://a.test/ (mobile)", "lighthouse https://a.test/ (desktop)", "lighthouse https://b.test/ (mobile)", "lighthouse https://b.test/ (desktop)"
    ]);
    expect(planSteps({ ...r, profiles: ["desktop"] }).filter((s) => /\(/.test(s))).toEqual(["measure https://a.test/ (desktop)", "lighthouse https://a.test/ (desktop)", "lighthouse https://b.test/ (desktop)"]);
  });
  it("audits and comparisons do not multiply by device", () => {
    expect(planSteps({ ...base, audits: ["https://a.test/"], profiles: ["mobile", "desktop"] })).toEqual(["audit https://a.test/"]);
  });
});

describe("generateReport with both devices", () => {
  const lh = (url: string, profile: "mobile" | "desktop"): LighthouseMeasurement => ({
    schemaVersion: "1.0.0", source: "lab", engine: "lighthouse", url, finalUrl: null, measuredAt: "x", profile, status: "complete",
    metadata: { lighthouseVersion: "12", browser: "c", throttlingMethod: "simulate", formFactor: profile, runs: 2 },
    runs: [{ ok: true, scores: { performance: profile === "mobile" ? 70 : 95, accessibility: 1, bestPractices: 1, seo: 1 }, metrics: { fcpMs: 1, lcpMs: 1, tbtMs: 1, cls: 0, speedIndexMs: 1, ttiMs: 1 }, opportunities: [], runWarnings: [], evidence: {} }],
    summary: { performanceScore: { median: profile === "mobile" ? 70 : 95, min: 1, max: 1, samples: 1 } }, limitations: [], htmlReports: ["<html>r1</html>", "<html>r2</html>"]
  });
  const br = (url: string, profile: "mobile" | "desktop"): BrowserMeasurement => ({ schemaVersion: "1.0.0", source: "lab", url, finalUrl: url, measuredAt: "x", profile, status: "complete", metadata: { browser: "c", playwrightVersion: "1", userAgent: "u", viewport: { width: 1, height: 1 }, deviceScaleFactor: 1, throttling: "none", cache: "cold (fresh context per run)", runs: 1, timeoutMs: 1 }, runs: [], summary: {}, limitations: [] });

  it("runs every device in plan order, keeps results per device, names report files per device and re-runs with both", async () => {
    const calls: string[] = []; const events: Array<[number, string]> = []; let labels: string[] = [];
    const out = await mkdtemp(join(tmpdir(), "wpi-prof-"));
    const r = await generateReport({ ...base, measures: ["https://a.test/"], lighthouse: ["https://a.test/"], profiles: ["desktop", "mobile"], outDir: out }, loadConfig({ WPI_MODE: "local" }).fetch, {
      onPlan: (l) => { labels = l; }, onStep: (i, state) => events.push([i, state]),
      deps: {
        auditPage: (async () => { throw new Error("no html"); }) as never,
        measurePage: (async (u: string, o: { profile: "mobile" | "desktop" }) => { calls.push(`measure ${o.profile}`); return br(u, o.profile); }) as never,
        runLighthouse: (async (u: string, o: { profile: "mobile" | "desktop" }) => { calls.push(`lighthouse ${o.profile}`); return lh(u, o.profile); }) as never
      }
    });
    expect(calls).toEqual(["measure mobile", "measure desktop", "lighthouse mobile", "lighthouse desktop"]);
    // every "running" event refers to the matching label, in order
    expect(events.filter(([, s]) => s === "running").map(([i]) => labels[i])).toEqual(["measure https://a.test/ (mobile)", "measure https://a.test/ (desktop)", "lighthouse https://a.test/ (mobile)", "lighthouse https://a.test/ (desktop)"]);
    expect(events.filter(([, s]) => s === "done")).toHaveLength(4);
    const data = JSON.parse(await readFile(join(r.dir, "data.json"), "utf8"));
    expect(data.lighthouse.map((l: { measurement: { profile: string } }) => l.measurement.profile)).toEqual(["mobile", "desktop"]);
    expect(data.lighthouse[0].reportFiles).toEqual(["lighthouse-1-mobile-run1.html", "lighthouse-1-mobile-run2.html"]);
    expect(data.lighthouse[1].reportFiles).toEqual(["lighthouse-1-desktop-run1.html", "lighthouse-1-desktop-run2.html"]);
    expect((await readdir(r.dir)).filter((f) => f.startsWith("lighthouse-")).sort()).toEqual(["lighthouse-1-desktop-run1.html", "lighthouse-1-desktop-run2.html", "lighthouse-1-mobile-run1.html", "lighthouse-1-mobile-run2.html"]);
    expect(data.rerunCommand).toContain("--profile mobile --profile desktop");
    const html = await readFile(join(r.dir, "report.html"), "utf8");
    expect(html).toMatch(/id="lh-0"[\s\S]*mobile[\s\S]*id="lh-1"[\s\S]*desktop/);                       // both devices appear, mobile first
    expect(html).toContain('href="lighthouse-1-desktop-run2.html"');
  });
  it("a failing device does not stop the other and is recorded as a failure", async () => {
    const out = await mkdtemp(join(tmpdir(), "wpi-prof-"));
    const r = await generateReport({ ...base, lighthouse: ["https://a.test/"], profiles: ["mobile", "desktop"], outDir: out }, loadConfig({ WPI_MODE: "local" }).fetch, {
      deps: { auditPage: (async () => { throw new Error("x"); }) as never, measurePage: (async () => br("", "mobile")) as never,
        runLighthouse: (async (u: string, o: { profile: "mobile" | "desktop" }) => { if (o.profile === "mobile") throw new Error("Chrome crashed"); return lh(u, o.profile); }) as never }
    });
    expect(r.failures).toEqual(["lighthouse https://a.test/ (mobile): Chrome crashed"]);
    const data = JSON.parse(await readFile(join(r.dir, "data.json"), "utf8"));
    expect(data.lighthouse.map((l: { measurement: { profile: string } }) => l.measurement.profile)).toEqual(["desktop"]);
  });
});

describe("CLI --profile", () => {
  const cli = (...args: string[]) => spawnSync("npx", ["tsx", "apps/api/src/cli.ts", "report", ...args], { encoding: "utf8", timeout: 60_000 });
  it("rejects unknown profiles", () => expect(cli("--audit", "https://a.test/", "--profile", "tablet").stderr).toContain('--profile must be desktop, mobile or both (got "tablet")'), 30_000);
  it("accepts repeated profiles and 'both' (reaches the next validation)", () => {
    for (const args of [["--profile", "mobile", "--profile", "desktop"], ["--profile", "both"], ["--profile", "desktop"], []]) expect(cli(...args).stderr, args.join(" ")).toContain("Nothing to do");
  }, 60_000);   // starts the CLI four times (~1 s each when idle)
});

describe("report folders never collide", () => {
  it("two reports for the same site in the same second get different folders and both survive", async () => {
    const out = await mkdtemp(join(tmpdir(), "wpi-coll-"));
    const deps = { auditPage: (async () => ({ url: "https://a.test/", findings: [], statusCode: 200, headings: { h1: [], h2Count: 0, h3Count: 0 }, images: { total: 0, missingAlt: 0, missingDimensions: 0 }, links: { total: 0, internal: 0, external: 0 }, schemaTypes: [], jsonLdBlocks: 0, limitations: [], redirectChain: [], title: null, metaDescription: null, canonical: null, robots: null, contentType: "text/html", finalUrl: "https://a.test/", fetchedAt: "x", schemaVersion: "1.0.0" })) as never, measurePage: (async () => { throw new Error("n/a"); }) as never, runLighthouse: (async () => { throw new Error("n/a"); }) as never };
    const run = () => generateReport({ ...base, audits: ["https://a.test/"], outDir: out }, loadConfig({ WPI_MODE: "local" }).fetch, { deps });
    const [a, b, c] = [await run(), await run(), await run()];
    expect(new Set([a.folder, b.folder, c.folder]).size).toBe(3);
    expect((await readdir(out)).length).toBe(3);
    for (const f of [a, b, c]) expect(f.folder).toMatch(/^a\.test_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/);     // still valid report folder names
  });
});
