import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildApp } from "../apps/api/src/app.js";
import { loadConfig } from "../apps/api/src/config.js";
import { generateReport, REPORT_FOLDER } from "../apps/api/src/report.js";
import { renderHtmlReport } from "../packages/reports/src/html.js";
import type { LighthouseMeasurement, PageAudit } from "../packages/contracts/src/types.js";

const FOLDER = "geokon.test_2026-10-12_14-30-05";
const audit: PageAudit = {
  schemaVersion: "1.0.0", url: "https://geokon.test/", fetchedAt: "2026-01-01T00:00:00Z", statusCode: 200, finalUrl: "https://geokon.test/", redirectChain: [], contentType: "text/html",
  title: "=HYPERLINK(\"http://evil\")", metaDescription: null, canonical: null, robots: "noindex", headings: { h1: ["H"], h2Count: 0, h3Count: 0 },
  images: { total: 1, missingAlt: 1, missingDimensions: 0 }, links: { total: 1, internal: 1, external: 0 }, schemaTypes: [], jsonLdBlocks: 0, limitations: [],
  findings: [{ id: "1", ruleId: "seo.robots.noindex", category: "seo", severity: "high", confidence: "high", title: "Page has a noindex directive", description: "d", url: "https://geokon.test/", evidence: [], recommendation: "r", status: "open" }]
};
const lh: LighthouseMeasurement = {
  schemaVersion: "1.0.0", source: "lab", engine: "lighthouse", url: "https://geokon.test/", finalUrl: null, measuredAt: "x", profile: "mobile", status: "complete",
  metadata: { lighthouseVersion: "12", browser: "chromium", throttlingMethod: "simulate", formFactor: "mobile", runs: 1 },
  runs: [{ ok: true, scores: { performance: 72, accessibility: 99, bestPractices: 100, seo: 66 }, metrics: { fcpMs: 1, lcpMs: 2, tbtMs: 3, cls: 0, speedIndexMs: 4, ttiMs: 5 }, opportunities: [{ id: "modern-image-formats", title: "Serve images in next-gen formats", savingsMs: 4350 }], runWarnings: [], evidence: {} }],
  summary: { performanceScore: { median: 72, min: 72, max: 72, samples: 1 }, accessibilityScore: { median: 99, min: 99, max: 99, samples: 1 }, lcpMs: { median: 12600, min: 1, max: 2, samples: 1 } }, limitations: []
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wpi-reports-"));
  await mkdir(join(dir, FOLDER), { recursive: true });
  const input = { audits: [audit], comparisons: [], measurements: [], lighthouse: [{ measurement: lh, reportFiles: [] }], failures: [] };
  await writeFile(join(dir, FOLDER, "report.html"), renderHtmlReport(input));
  await writeFile(join(dir, FOLDER, "data.json"), JSON.stringify({ ...input, generatedAt: "now" }));
  await writeFile(join(dir, FOLDER, "lighthouse-1-run1.html"), "<html>lh</html>");
  await writeFile(join(dir, FOLDER, "secret.txt"), "nope");
  await writeFile(join(dir, "outside.html"), "outside");
});
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });
const make = (env: Record<string, string> = {}, generate?: typeof generateReport) => {
  const app = buildApp(loadConfig({ WPI_MODE: "local", WPI_REPORTS_DIR: dir, ...env }), { logger: false, generate, webDir: dir }); apps.push(app); return app;
};
const H = { host: "127.0.0.1:4178" };
const get = (app: ReturnType<typeof make>, url: string) => app.inject({ method: "GET", url, headers: H });

describe("report files", () => {
  it("serves whitelisted report files only", async () => {
    const app = make();
    expect((await get(app, `/reports/${FOLDER}/report.html`)).statusCode).toBe(200);
    expect((await get(app, `/reports/${FOLDER}/lighthouse-1-run1.html`)).body).toBe("<html>lh</html>");
    for (const u of [`/reports/${FOLDER}/secret.txt`, `/reports/${FOLDER}/..%2Foutside.html`, `/reports/..%2F${FOLDER}/report.html`, `/reports/%2e%2e/outside.html`, `/reports/not-a-report/report.html`, `/reports/${FOLDER}/lighthouse-1-run1.html.bak`])
      expect((await get(app, u)).statusCode, u).toBe(404);
  });
  it("lists earlier reports newest first", async () => {
    const r = (await get(make(), "/api/reports")).json().reports;
    expect(r).toHaveLength(1); expect(r[0]).toMatchObject({ folder: FOLDER, url: `/reports/${FOLDER}/report.html` });
    expect(REPORT_FOLDER.test(r[0].folder)).toBe(true);
  });
  it("is local-mode only", async () => {
    const app = make({ WPI_MODE: "public" });
    for (const u of ["/api/jobs", "/api/reports", `/reports/${FOLDER}/report.html`, `/reports/${FOLDER}/export/json`]) expect((await get(app, u)).statusCode, u).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/jobs", payload: { audits: ["https://a.test/"] } })).json().code).toBe("LOCAL_ONLY");
  });
});

describe("exports", () => {
  it("downloads JSON and HTML as attachments", async () => {
    const app = make();
    const j = await get(app, `/reports/${FOLDER}/export/json`);
    expect(j.headers["content-disposition"]).toBe(`attachment; filename="${FOLDER}.json"`);
    expect(JSON.parse(j.body).audits[0].url).toBe("https://geokon.test/");
    const h = await get(app, `/reports/${FOLDER}/export/html`);
    expect(h.headers["content-type"]).toContain("text/html"); expect(h.headers["content-disposition"]).toContain(".html"); expect(h.body).toContain("<!doctype html>");
  });
  it("builds a spreadsheet with audits, performance and opportunities, with formulas neutralised", async () => {
    const r = await get(make(), `/reports/${FOLDER}/export/xlsx`);
    expect(r.statusCode).toBe(200); expect(r.headers["content-disposition"]).toContain(".xlsx");
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(expect.arrayContaining(["Summary", "Findings", "Performance", "Opportunities"]));
    const perf = wb.getWorksheet("Performance")!.getRow(2);
    expect(perf.getCell(1).value).toBe("Lighthouse (lab)"); expect(perf.getCell(5).value).toBe(72); expect(perf.getCell(11).value).toBe(12600);
    expect(wb.getWorksheet("Opportunities")!.getRow(2).getCell(3).value).toBe("modern-image-formats");
  });
  it("404s for unknown formats, folders and path tricks", async () => {
    const app = make();
    for (const u of [`/reports/${FOLDER}/export/pdf`, `/reports/nope_2026-01-01_00-00-00/export/json`, `/reports/..%2F/export/json`]) expect((await get(app, u)).statusCode, u).toBe(404);
  });
});

describe("POST /api/jobs", () => {
  const fake: typeof generateReport = async (req, _cfg, hooks) => {
    hooks?.onPlan?.(["audit https://a.test/"]); hooks?.onStep?.(0, "running"); hooks?.onStep?.(0, "done");
    return { dir: join(dir, FOLDER), file: join(dir, FOLDER, "report.html"), folder: FOLDER, failures: [] };
  };
  it("validates input", async () => {
    const app = make({}, fake);
    for (const body of [{}, { audits: [] }, { audits: ["ftp://x.test/"] }, { audits: ["nope"] }, { audits: ["https://a.test/"], runs: 9 }, { audits: ["https://a.test/"], baseline: "../etc" }, { compares: [{ oldUrl: "https://a.test/", newUrl: "file:///x" }] }, { audits: Array(21).fill("https://a.test/") }])
      expect((await app.inject({ method: "POST", url: "/api/jobs", payload: body, headers: H })).statusCode, JSON.stringify(body).slice(0, 50)).toBe(400);
  });
  it("starts a job in the background and reports progress and the report link", async () => {
    const app = make({}, fake);
    const r = await app.inject({ method: "POST", url: "/api/jobs", payload: { audits: ["https://a.test/"], lighthouse: ["https://a.test/"], compares: [{ oldUrl: "https://o.test/", newUrl: "https://n.test/" }], profile: "mobile" }, headers: H });
    expect(r.statusCode).toBe(202);
    const id = r.json().job.id;
    let job: { status: string; folder?: string } = r.json().job;
    for (let i = 0; i < 100 && job.status !== "done"; i++) { await new Promise((x) => setTimeout(x, 10)); job = (await get(app, `/api/jobs/${id}`)).json().job; }
    expect(job).toMatchObject({ status: "done", folder: FOLDER });
    expect((await get(app, "/api/jobs/does-not-exist")).statusCode).toBe(404);
    expect((await get(app, "/api/jobs")).json().jobs).toHaveLength(1);
  });
  it("rejects a foreign Origin but accepts the dashboard's own origin", async () => {
    const app = make({}, fake);
    expect((await app.inject({ method: "POST", url: "/api/jobs", payload: { audits: ["https://a.test/"] }, headers: { ...H, origin: "https://evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/jobs", payload: { audits: ["https://a.test/"] }, headers: { ...H, origin: "http://127.0.0.1:4178" } })).statusCode).toBe(202);
  });
});
