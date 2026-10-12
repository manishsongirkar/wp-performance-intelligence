import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { buildApp } from "../apps/api/src/app.js";
import { loadConfig } from "../apps/api/src/config.js";
import type { generateReport, ReportRequest } from "../apps/api/src/report.js";
import { renderHtmlReport } from "../packages/reports/src/html.js";

let hasBrowser = false;
try { hasBrowser = existsSync(chromium.executablePath()); } catch { /* not installed */ }
const FOLDER = "mysite.test_2026-10-12_14-30-05";

describe.skipIf(!hasBrowser)("web interface (real built UI, headless Chromium)", () => {
  let base: string; let browser: Browser; let close: () => Promise<unknown>;
  const received: ReportRequest[] = []; let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));

  beforeAll(async () => {
    const webDir = await mkdtemp(join(tmpdir(), "wpi-web-"));
    await build({ root: join(import.meta.dirname, "../apps/web"), configFile: false, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
    const reports = await mkdtemp(join(tmpdir(), "wpi-reports-"));
    // A fake engine: same contract as generateReport, but slow and with no browser.
    const fake: typeof generateReport = async (req, _cfg, hooks) => {
      received.push(req);
      hooks?.onPlan?.(["audit https://mysite.test/", "lighthouse https://mysite.test/"]);
      hooks?.onStep?.(0, "running"); hooks?.onStep?.(0, "done"); hooks?.onStep?.(1, "running");
      await gate;
      hooks?.onStep?.(1, "done");
      const dir = join(reports, FOLDER); await mkdir(dir, { recursive: true });
      const input = { audits: [], comparisons: [], measurements: [], lighthouse: [], failures: [], title: "Report: mysite.test" };
      await writeFile(join(dir, "report.html"), renderHtmlReport(input)); await writeFile(join(dir, "data.json"), JSON.stringify({ ...input, generatedAt: "now" }));
      return { dir, file: join(dir, "report.html"), folder: FOLDER, failures: [], stepCount: 1 };
    };
    const app = buildApp(loadConfig({ WPI_MODE: "local", WPI_REPORTS_DIR: reports }), { logger: false, generate: fake, webDir });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    close = () => app.close();
    browser = await chromium.launch(); // headless
  }, 60_000);
  afterAll(async () => { await browser?.close(); await close?.(); });

  it("runs a report in the background and shows the link, copy and export options below the form", async () => {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/");

    const run = page.getByRole("button", { name: "Run report" });
    expect(await run.isDisabled()).toBe(true);                                   // nothing entered yet
    await page.getByLabel("URLs (one per line)").fill("https://mysite.test/\nnot a url");
    expect(await run.isDisabled()).toBe(true);                                   // invalid URL blocks the run
    await expect.poll(() => page.getByRole("alert").textContent()).toContain("not a url");
    await page.getByLabel("URLs (one per line)").fill("https://mysite.test/");
    await page.getByRole("button", { name: "+ Add comparison" }).click();
    await page.getByLabel("Old URL 1").fill("https://www.mysite.com/");
    await page.getByLabel("New URL 1").fill("https://staging.mysite.com/");
    await page.getByLabel("Runs per page").selectOption("2");
    await page.getByLabel("Mobile").uncheck();                                    // default is Mobile only
    await page.getByLabel("Desktop").check();
    expect(await run.isEnabled()).toBe(true);
    await run.click();

    // Running in the background: progress shows, and the page stays usable.
    const job = page.locator(".job");
    await expect.poll(() => job.locator(".pill").textContent()).toBe("running");
    expect(await job.locator("ul.steps li").count()).toBe(2);
    expect(await page.locator(".result").count()).toBe(0);                       // no link until it is done
    release();

    // Finished: link, copy, exports.
    await job.locator(".result").waitFor({ timeout: 10_000 });
    const link = await job.getByRole("link", { name: /Open report/ }).getAttribute("href");
    expect(link).toBe(`${base}/reports/${FOLDER}/report.html`);
    await job.getByRole("button", { name: "Copy link" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

    for (const [name, type] of [["JSON", "application/json"], ["Spreadsheet (.xlsx)", "spreadsheetml"], ["HTML", "text/html"]] as const) {
      const href = await job.getByRole("link", { name, exact: true }).getAttribute("href");
      const res = await page.request.get(new URL(href!, base).href);
      expect(res.status(), name).toBe(200); expect(res.headers()["content-type"], name).toContain(type);
      expect(res.headers()["content-disposition"]).toContain("attachment");
    }
    const report = await context.newPage();
    await report.goto(link!);
    expect(await report.title()).toBe("Report: mysite.test");

    // What the UI sent to the API.
    expect(received[0]).toMatchObject({ audits: ["https://mysite.test/"], lighthouse: ["https://mysite.test/"], measures: [], compares: [["https://www.mysite.com/", "https://staging.mysite.com/"]], runs: 2, profiles: ["desktop"] });
    // It appears in "Earlier reports" and can be used as a baseline.
    await page.reload();
    await page.getByRole("button", { name: "Use as baseline" }).click();
    expect(await page.getByLabel("Compare with a previous report").inputValue()).toBe(FOLDER);
    expect(errors).toEqual([]);
  }, 60_000);

  it("separate URL lists per tool when 'same URLs' is unchecked", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(base + "/");
    await page.getByLabel("Use the same URLs for every check").uncheck();
    await page.getByLabel("Lighthouse URLs").fill("https://only-lh.test/");
    await page.getByLabel("Browser measurement URLs").fill("https://only-browser.test/");
    expect(await page.getByRole("button", { name: "Run report" }).isEnabled()).toBe(true);
    expect(await page.getByText("2 checks").count()).toBe(1);
  }, 30_000);
});

describe.skipIf(!hasBrowser)("device profile checkboxes (real built UI)", () => {
  it("lets you choose mobile, desktop or both, and requires one for browser checks", async () => {
    const webDir = await mkdtemp(join(tmpdir(), "wpi-web-"));
    await build({ root: join(import.meta.dirname, "../apps/web"), configFile: false, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
    const sent: unknown[] = [];
    const app = buildApp(loadConfig({ WPI_MODE: "local", WPI_REPORTS_DIR: await mkdtemp(join(tmpdir(), "wpi-r-")) }), {
      logger: false, webDir, generate: (async (req: ReportRequest) => { sent.push(req); throw new Error("stop"); }) as never
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(base + "/");
      expect(await page.locator("select#profile").count()).toBe(0);                       // the dropdown is gone
      expect(await page.getByLabel("Mobile").isChecked()).toBe(true);                     // default
      expect(await page.getByLabel("Desktop").isChecked()).toBe(false);
      await page.getByLabel("URLs (one per line)").fill("https://a.test/");
      const run = page.getByRole("button", { name: "Run report" });
      await expect.poll(() => page.getByText(/2 checks/).count()).toBe(1);                // audit + Lighthouse x 1 device
      await page.getByLabel("Desktop").check();
      await expect.poll(() => page.getByText(/3 checks/).count()).toBe(1);                // audit + Lighthouse x 2 devices
      await page.getByLabel("Mobile").uncheck(); await page.getByLabel("Desktop").uncheck();
      expect(await run.isDisabled()).toBe(true);
      await expect.poll(() => page.getByRole("alert").textContent()).toContain("Select at least one device");
      await page.getByLabel("HTML audit").check(); await page.getByLabel("Lighthouse").uncheck();
      expect(await run.isEnabled()).toBe(true);                                           // audit-only needs no device
      await page.getByLabel("Lighthouse").check(); await page.getByLabel("Mobile").check(); await page.getByLabel("Desktop").check();
      await run.click();
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0]).toMatchObject({ profiles: ["mobile", "desktop"], audits: ["https://a.test/"], lighthouse: ["https://a.test/"] });
    } finally { await browser.close(); await app.close(); }
  }, 60_000);
});

describe.skipIf(!hasBrowser)("dashboard interactions (real UI, regressions found in review)", () => {
  let browser: Browser; let webDir: string;
  beforeAll(async () => {
    webDir = await mkdtemp(join(tmpdir(), "wpi-web-"));
    await build({ root: join(import.meta.dirname, "../apps/web"), configFile: false, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => { await browser?.close(); });

  /** A fresh API per test (one job at a time, so tests must not share a queue). Jobs wait on `release` and honour cancel. */
  async function serve() {
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const slow = (async (_req: ReportRequest, _cfg: unknown, hooks?: { onPlan?(l: string[]): void; onStep?(i: number, s: string): void; shouldCancel?(): boolean }) => {
      hooks?.onPlan?.(["audit https://x.test/"]); hooks?.onStep?.(0, "running");
      await gate;
      if (hooks?.shouldCancel?.()) throw new Error("Cancelled.");
      return { dir: "", file: "", folder: "x.test_2026-01-01_00-00-00", failures: [], stepCount: 1 };
    }) as never;
    const app = buildApp(loadConfig({ WPI_MODE: "local", WPI_REPORTS_DIR: await mkdtemp(join(tmpdir(), "wpi-r-")) }), { logger: false, webDir, generate: slow });
    await app.listen({ host: "127.0.0.1", port: 0 });
    return { base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, release: () => release(), close: async () => { release(); await app.close(); } };
  }
  const auditOnly = async (page: import("playwright").Page) => {
    await page.getByLabel("URLs (one per line)").fill("https://x.test/");
    await page.getByLabel("HTML audit").check(); await page.getByLabel("Lighthouse").uncheck();
  };

  it("typing keeps focus and every character (the textarea used to remount after one key)", async () => {
    const s = await serve(); const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(s.base + "/");
      const box = page.getByLabel("URLs (one per line)");
      await box.pressSequentially("https://abc.test/page", { delay: 5 });
      expect(await box.inputValue()).toBe("https://abc.test/page");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("urls");
    } finally { await s.close(); }
  }, 30_000);

  it("shows server-rule problems before submitting (limits, half-filled pairs) and keeps Run disabled", async () => {
    const s = await serve(); const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(s.base + "/");
      const run = page.getByRole("button", { name: "Run report" });
      await page.getByLabel("URLs (one per line)").fill(Array.from({ length: 21 }, (_, i) => `https://a${i}.test/`).join("\n"));
      expect(await run.isDisabled()).toBe(true);
      await expect.poll(() => page.getByRole("alert").first().textContent()).toContain("At most 20 URLs per list");
      await page.getByLabel("URLs (one per line)").fill("https://ok.test/");
      expect(await run.isEnabled()).toBe(true);
      await page.getByRole("button", { name: "+ Add comparison" }).click();
      await page.getByLabel("Old URL 1").fill("https://old.test/");
      expect(await run.isDisabled()).toBe(true);
      await expect.poll(() => page.getByRole("alert").first().textContent()).toContain("Fill in both the old and the new URL");
    } finally { await s.close(); }
  }, 30_000);

  it("clears a connection error once the API is reachable again", async () => {
    const s = await serve(); const page = await (await browser.newContext()).newPage();
    try {
      await page.route("**/api/history", (r) => r.abort());
      await page.route("**/api/jobs", (r) => (r.request().method() === "GET" ? r.abort() : r.continue()));
      await page.goto(s.base + "/");
      await expect.poll(() => page.getByText(/Cannot load reports/).count()).toBe(1);
      await page.unroute("**/api/jobs"); await page.unroute("**/api/history");
      await auditOnly(page);
      await page.getByRole("button", { name: "Run report" }).click();                       // triggers a refresh that now succeeds
      await expect.poll(() => page.getByText(/Cannot load reports/).count()).toBe(0);
    } finally { await s.close(); }
  }, 30_000);

  it("Cancel works on a running job (it used to fail with HTTP 400 and leave an error on screen)", async () => {
    const s = await serve(); const page = await (await browser.newContext()).newPage();
    try {
      await page.goto(s.base + "/");
      await auditOnly(page);
      await page.getByRole("button", { name: "Run report" }).click();
      const job = page.locator(".job").first();
      await expect.poll(() => job.locator(".pill").textContent()).toBe("running");
      await job.getByRole("button", { name: "Cancel" }).click();
      await page.waitForTimeout(300);
      expect(await page.getByRole("alert").count()).toBe(0);                                // no error from the cancel request itself
      s.release();                                                                          // the running step ends; the cancel is honoured
      await expect.poll(() => job.locator(".pill").textContent(), { timeout: 10_000 }).toBe("cancelled");
    } finally { await s.close(); }
  }, 40_000);
});


describe.skipIf(!hasBrowser)("progress charts and report history (real UI, seeded reports)", () => {
  let base: string; let browser: Browser; let close: () => Promise<unknown>;
  const U1 = "https://shop.test/", U2 = "https://shop.test/about/";
  const lh = (url: string, profile: string, perf: number, lcp: number) => ({ measurement: { url, profile, summary: { performanceScore: { median: perf }, accessibilityScore: { median: 99 }, bestPracticesScore: { median: 100 }, seoScore: { median: 66 }, lcpMs: { median: lcp }, fcpMs: { median: 1200 }, tbtMs: { median: 0 }, cls: { median: 0 }, speedIndexMs: { median: 2000 } } }, reportFiles: [] });
  const seed = async (dir: string, folder: string, at: string, perf: number) => {
    await mkdir(join(dir, folder), { recursive: true });
    const input = { audits: [], comparisons: [], measurements: [], lighthouse: [], failures: [], title: `Report ${folder}` };
    await writeFile(join(dir, folder, "report.html"), renderHtmlReport(input));
    await writeFile(join(dir, folder, "data.json"), JSON.stringify({
      generatedAt: at, title: `Report ${folder}`,
      lighthouse: [lh(U1, "mobile", perf, 4000 - perf * 20), lh(U1, "desktop", perf + 10, 1500), lh(U2, "mobile", perf - 10, 5000 - perf * 20)],
      measurements: [{ url: U1, profile: "mobile", summary: { ttfbMs: { median: 400 }, lcpMs: { median: 480 }, transferBytes: { median: 3_800_000 } } }],
      audits: [{ url: U1, findings: [{ severity: "high" }], images: { missingAlt: 2 } }], comparisons: [], failures: []
    }));
  };
  beforeAll(async () => {
    const webDir = await mkdtemp(join(tmpdir(), "wpi-web-")); const reports = await mkdtemp(join(tmpdir(), "wpi-r-"));
    await build({ root: join(import.meta.dirname, "../apps/web"), configFile: false, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
    await seed(reports, "shop.test_2026-10-10_09-00-00", "2026-10-10T09:00:00.000Z", 60);
    await seed(reports, "shop.test_2026-10-11_09-00-00", "2026-10-11T09:00:00.000Z", 75);
    await seed(reports, "shop.test_2026-10-12_09-00-00", "2026-10-12T09:00:00.000Z", 90);
    const app = buildApp(loadConfig({ WPI_MODE: "local", WPI_REPORTS_DIR: reports }), { logger: false, webDir });
    await app.listen({ host: "127.0.0.1", port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`; close = () => app.close(); browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => { await browser?.close(); await close?.(); });

  it("shows a chart for every measured point by default, one line per URL and device, with the latest value and trend", async () => {
    const page = await (await browser.newContext()).newPage(); const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/");
    await expect.poll(() => page.locator("[data-chart]").count()).toBe(15);                   // 9 Lighthouse + 3 browser + 3 audit charts
    const perf = page.locator('[data-chart="lh-performance"]');
    expect(await perf.locator("polyline").count()).toBe(3);                                    // shop.test mobile + desktop, /about/ mobile
    expect(await perf.locator("circle.pt").count()).toBe(9);                                   // 3 reports x 3 lines
    expect(await perf.locator("polyline[stroke-dasharray]").count()).toBe(1);                  // desktop is dashed
    const legend = await perf.locator(".legend2").innerText();
    expect(legend).toContain("shop.test · Mobile"); expect(legend).toContain("90"); expect(legend).toContain("▲ 15");   // latest score and change since the previous report
    expect(await perf.locator("svg").getAttribute("aria-label")).toContain("Lighthouse · Performance score over time");
    expect(await page.locator('[data-chart="au-issues"] polyline').count()).toBe(1);
    expect(errors).toEqual([]);
  }, 40_000);

  it("filters by URL and device, and a hover tooltip shows the value, date and the click action", async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(base + "/"); await page.locator("[data-chart]").first().waitFor();
    const perf = page.locator('[data-chart="lh-performance"]');
    await page.getByRole("button", { name: "Desktop", exact: true }).click();                  // hide desktop
    await expect.poll(() => perf.locator("polyline").count()).toBe(2);
    await page.getByRole("button", { name: "shop.test/about", exact: true }).click();          // hide the /about/ page
    await expect.poll(() => perf.locator("polyline").count()).toBe(1);
    await page.getByRole("button", { name: "Mobile", exact: true }).click();                   // nothing left for Lighthouse; the audit (no device) stays
    await expect.poll(() => page.locator('[data-chart="lh-performance"]').count()).toBe(0);
    expect(await page.locator('[data-chart="au-issues"]').count()).toBe(1);
    for (const n of ["Mobile", "Desktop", "shop.test/about"]) await page.getByRole("button", { name: n, exact: true }).click();
    await expect.poll(() => perf.locator("polyline").count()).toBe(3);
    await perf.locator("circle.pt").last().hover();
    const tip = page.locator(".tip");
    await expect.poll(() => tip.count()).toBe(1);
    expect(await tip.innerText()).toMatch(/Click to open this report/);
  }, 40_000);

  it("clicking a point, or its keyboard Enter, opens that report", async () => {
    const ctxt = await browser.newContext(); const page = await ctxt.newPage();
    await page.goto(base + "/"); await page.locator("[data-chart]").first().waitFor();
    const [popup] = await Promise.all([ctxt.waitForEvent("page"), page.locator('[data-chart="lh-performance"] circle.pt').first().click()]);
    await popup.waitForLoadState();
    expect(popup.url()).toMatch(/\/reports\/shop\.test_2026-10-1\d_09-00-00\/report\.html$/);
    const [kb] = await Promise.all([ctxt.waitForEvent("page"), (async () => { await page.locator('[data-chart="lh-performance"] circle.pt').last().focus(); await page.keyboard.press("Enter"); })()]);
    await kb.waitForLoadState(); expect(kb.url()).toContain("/reports/shop.test_2026-10-");
  }, 40_000);

  it("lists reports newest first with a View details button that opens the old report, plus exports and baseline", async () => {
    const ctxt = await browser.newContext(); const page = await ctxt.newPage();
    await page.goto(base + "/"); await page.locator(".hrow").first().waitFor();
    const rows = page.locator(".hrow");
    expect(await rows.count()).toBe(3);
    expect(await rows.first().innerText()).toContain("Report shop.test_2026-10-12_09-00-00");
    expect(await rows.first().innerText()).toMatch(/M 90/); expect(await rows.first().innerText()).toMatch(/D 100/);          // headline scores per device
    const old = rows.nth(2);
    const [popup] = await Promise.all([ctxt.waitForEvent("page"), old.getByRole("link", { name: /View details/ }).click()]);
    await popup.waitForLoadState();
    expect(popup.url()).toMatch(/shop\.test_2026-10-10_09-00-00\/report\.html$/); expect(await popup.title()).toBe("Report shop.test_2026-10-10_09-00-00");
    expect(await old.getByRole("link", { name: "JSON" }).getAttribute("href")).toContain("/export/json");
    await old.getByRole("button", { name: "Use as baseline" }).click();
    expect(await page.getByLabel("Compare with a previous report").inputValue()).toBe("shop.test_2026-10-10_09-00-00");
  }, 40_000);
});
