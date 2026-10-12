import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseReport, readHistory } from "../apps/api/src/history.js";
import { buildApp } from "../apps/api/src/app.js";
import { loadConfig } from "../apps/api/src/config.js";

const lh = (url: string, profile: string, perf: number, lcp: number) => ({ measurement: { url, profile, summary: { performanceScore: { median: perf }, accessibilityScore: { median: 99 }, bestPracticesScore: { median: 100 }, seoScore: { median: 66 }, lcpMs: { median: lcp }, fcpMs: { median: 1200 }, tbtMs: { median: 0 }, cls: { median: 0 }, speedIndexMs: { median: 2000 } } }, reportFiles: [] });
const data = (at: string, perf: number) => ({
  generatedAt: at, title: "Report: shop.test",
  lighthouse: [lh("https://shop.test/", "mobile", perf, 4000 - perf * 20), lh("https://shop.test/", "desktop", perf + 10, 1500)],
  measurements: [{ url: "https://shop.test/", profile: "mobile", summary: { ttfbMs: { median: 400 }, lcpMs: { median: 480 }, transferBytes: { median: 3_800_000 } } }],
  audits: [{ url: "https://shop.test/", findings: [{ severity: "high" }, { severity: "medium" }, { severity: "critical" }], images: { missingAlt: 4 } }],
  comparisons: [{ newUrl: "https://new.shop.test/" }], failures: ["x: boom"]
});

describe("parseReport", () => {
  it("extracts one point per tested URL, device and tool, plus the report summary", () => {
    const { report, points } = parseReport("shop.test_2026-10-12_10-00-00", data("2026-10-12T10:00:00.000Z", 70), "fallback");
    expect(points.filter((p) => p.kind === "lighthouse").map((p) => [p.device, p.values.performance, p.values.lcpMs])).toEqual([["mobile", 70, 2600], ["desktop", 80, 1500]]);
    expect(points.find((p) => p.kind === "browser")!.values).toMatchObject({ ttfbMs: 400, lcpMs: 480, transferBytes: 3_800_000 });
    expect(points.find((p) => p.kind === "audit")!.values).toEqual({ issues: 3, criticalHigh: 2, missingAlt: 4 });
    expect(report).toMatchObject({ folder: "shop.test_2026-10-12_10-00-00", at: "2026-10-12T10:00:00.000Z", title: "Report: shop.test", failures: 1, tools: { lighthouse: 2, browser: 1, audit: 1, comparisons: 1 }, reportUrl: "/reports/shop.test_2026-10-12_10-00-00/report.html" });
    expect(report.urls.sort()).toEqual(["https://new.shop.test/", "https://shop.test/"]);
    expect(report.headline).toEqual([{ url: "https://shop.test/", device: "mobile", performance: 70 }, { url: "https://shop.test/", device: "desktop", performance: 80 }]);
  });
  it("treats data.json as untrusted: wrong types, nulls, missing pieces and prototype keys never throw or leak", () => {
    const hostile = [null, 5, "x", [], {}, { lighthouse: "x", measurements: [null, 3, { url: 5 }], audits: [{ url: "https://a/", findings: "no" }] },
      { lighthouse: [{ measurement: { url: "https://a/", profile: "tablet", summary: { performanceScore: { median: "99" }, lcpMs: { median: NaN } } } }], generatedAt: "not a date", title: { a: 1 } },
      JSON.parse('{"__proto__":{"polluted":1},"lighthouse":[{"measurement":{"url":"https://a/","summary":{}}}]}')];
    for (const h of hostile) {
      const r = parseReport("a.test_2026-01-01_00-00-00", h, "2026-01-01T00:00:00.000Z");
      expect(r.report.at).toMatch(/^\d{4}-/); expect(Array.isArray(r.points)).toBe(true);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const odd = parseReport("a.test_2026-01-01_00-00-00", hostile[6], "FALLBACK");
    expect(odd.report.at).toBe("FALLBACK");                                              // invalid date: falls back
    expect(odd.points[0]).toMatchObject({ device: null, values: { performance: null, lcpMs: null } });   // "99" (a string) and NaN are not numbers
    expect(odd.report.title).toBe("a.test_2026-01-01_00-00-00");
  });
});

describe("readHistory and /api/history", () => {
  async function seed() {
    const dir = await mkdtemp(join(tmpdir(), "wpi-hist-"));
    const mk = async (folder: string, content: string | object | null, mtime: Date) => {
      await mkdir(join(dir, folder), { recursive: true });
      await writeFile(join(dir, folder, "report.html"), "<html></html>");
      if (content !== null) await writeFile(join(dir, folder, "data.json"), typeof content === "string" ? content : JSON.stringify(content));
      await utimes(join(dir, folder, "report.html"), mtime, mtime);
    };
    await mk("shop.test_2026-10-10_09-00-00", data("2026-10-10T09:00:00.000Z", 60), new Date("2026-10-10T09:00:00Z"));
    await mk("shop.test_2026-10-12_09-00-00", data("2026-10-12T09:00:00.000Z", 90), new Date("2026-10-12T09:00:00Z"));
    await mk("shop.test_2026-10-11_09-00-00", "{ this is not json", new Date("2026-10-11T09:00:00Z"));       // corrupt: listed, no points
    await mk("shop.test_2026-10-09_09-00-00", null, new Date("2026-10-09T09:00:00Z"));                        // no data.json (older tool version)
    await mkdir(join(dir, "not-a-report-folder"), { recursive: true }); await writeFile(join(dir, "not-a-report-folder", "report.html"), "x");
    await mkdir(join(dir, "Desktop_2026-01-01_00-00-00"), { recursive: true });                                // no report.html: not a report
    return dir;
  }
  it("lists every report newest first, builds points oldest first, and survives corrupt or missing files", async () => {
    const h = await readHistory(await seed());
    expect(h.reports.map((r) => r.folder)).toEqual(["shop.test_2026-10-12_09-00-00", "shop.test_2026-10-11_09-00-00", "shop.test_2026-10-10_09-00-00", "shop.test_2026-10-09_09-00-00"]);
    expect(h.reports[1]).toMatchObject({ tools: { lighthouse: 0, browser: 0, audit: 0, comparisons: 0 }, urls: [] });      // the corrupt one is still openable
    expect(h.points.map((p) => p.at)).toEqual([...h.points.map((p) => p.at)].sort());
    expect(new Set(h.points.map((p) => p.folder))).toEqual(new Set(["shop.test_2026-10-10_09-00-00", "shop.test_2026-10-12_09-00-00"]));
  });
  it("respects the report limit and caches by file change", async () => {
    const dir = await seed();
    expect((await readHistory(dir, 2)).reports).toHaveLength(2);
    const first = await readHistory(dir), second = await readHistory(dir);
    expect(second.points).toEqual(first.points);
    await writeFile(join(dir, "shop.test_2026-10-12_09-00-00", "data.json"), JSON.stringify(data("2026-10-12T09:00:00.000Z", 50)));
    expect((await readHistory(dir)).points.find((p) => p.folder === "shop.test_2026-10-12_09-00-00" && p.device === "mobile")!.values.performance).toBe(50);   // a changed file is re-read
  });
  it("is empty (not an error) for a missing reports folder", async () => expect(await readHistory(join(tmpdir(), "wpi-does-not-exist-xyz"))).toEqual({ reports: [], points: [] }));
  it("is served by the API in local mode only", async () => {
    const dir = await seed();
    const local = buildApp(loadConfig({ WPI_MODE: "local", WPI_REPORTS_DIR: dir }), { logger: false });
    const r = await local.inject({ method: "GET", url: "/api/history", headers: { host: "127.0.0.1:4178" } });
    expect(r.statusCode).toBe(200); expect(r.json().reports).toHaveLength(4); expect(r.json().points.length).toBeGreaterThan(0);
    const pub = buildApp(loadConfig({ WPI_MODE: "public", WPI_REPORTS_DIR: dir }), { logger: false });
    expect((await pub.inject({ method: "GET", url: "/api/history", headers: { host: "127.0.0.1:4178" } })).statusCode).toBe(403);
    await local.close(); await pub.close();
  });
});
