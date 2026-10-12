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
      return { dir, file: join(dir, "report.html"), folder: FOLDER, failures: [] };
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
    await page.getByLabel("Device profile").selectOption("desktop");
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
    expect(received[0]).toMatchObject({ audits: ["https://mysite.test/"], lighthouse: ["https://mysite.test/"], measures: [], compares: [["https://www.mysite.com/", "https://staging.mysite.com/"]], runs: 2, profile: "desktop" });
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
