import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auditPage } from "../../../packages/audit-core/src/audit.js";
import { comparePages } from "../../../packages/site-comparison/src/compare.js";
import { measurePage } from "../../../packages/browser-audit/src/measure.js";
import { fetchPsi, isPsiTestable } from "../../../packages/browser-audit/src/psi.js";
import { runLighthouse } from "../../../packages/browser-audit/src/lighthouse.js";
import { renderHtmlReport, type ReportInput } from "../../../packages/reports/src/html.js";
import type { Config } from "./config.js";

export interface ReportRequest {
  audits: string[];
  compares: Array<[string, string]>;
  measures: string[];
  lighthouse: string[];
  runs: number;
  profile: "desktop" | "mobile";
  /** Also query Google PageSpeed Insights for each Lighthouse URL (sends the URL to Google; public sites only). */
  psi?: boolean;
  psiApiKey?: string;
  /** Path of a previous report folder (or its data.json). */
  baselinePath?: string;
  /** Parent folder; a unique `<site>_<date-time>` folder is created inside it. */
  outDir: string;
}

export interface ReportHooks {
  onPlan?(labels: string[]): void;
  onStep?(index: number, state: "running" | "done" | "failed", error?: string): void;
  shouldCancel?(): boolean;
  /** Test seam; defaults to the real engines. */
  deps?: { auditPage: typeof auditPage; measurePage: typeof measurePage; runLighthouse: typeof runLighthouse; fetchPsi?: typeof fetchPsi };
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Folder name: site hostname + local date/time, e.g. geokon.test_2026-10-12_14-30-05 */
export function reportFolderName(siteUrl: string, now = new Date()): string {
  let host = "report";
  try { host = new URL(siteUrl).hostname; } catch { /* keep default */ }
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${host.replace(/[^a-z0-9.-]/gi, "_")}_${stamp}`;
}
export const REPORT_FOLDER = /^[A-Za-z0-9._-]+_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/;

const shq = (v: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
const message = (e: unknown) => (e instanceof Error ? e.message : "failed");

export async function loadBaseline(path: string): Promise<NonNullable<ReportInput["baseline"]>> {
  const file = (await stat(path)).isDirectory() ? join(path, "data.json") : path;
  const d = JSON.parse(await readFile(file, "utf8")) as Partial<ReportInput> & { generatedAt?: string };
  if (!Array.isArray(d.lighthouse) && !Array.isArray(d.measurements)) throw new Error("baseline has no Lighthouse or browser measurements");
  return { generatedAt: d.generatedAt, lighthouse: d.lighthouse ?? [], measurements: d.measurements ?? [] };
}

export function planSteps(r: ReportRequest): string[] {
  return [...r.audits.map((u) => `audit ${u}`), ...r.compares.map(([o, n]) => `compare ${o} vs ${n}`), ...r.measures.map((u) => `measure ${u}`), ...r.lighthouse.map((u) => `lighthouse ${u}`), ...(r.psi ? r.lighthouse.map((u) => `pagespeed insights ${u}`) : [])];
}

/** Runs every requested step, then writes report.html, data.json and the Lighthouse reports. A failing step is recorded in the report, not fatal. */
export async function generateReport(req: ReportRequest, cfg: Config["fetch"], hooks: ReportHooks = {}): Promise<{ dir: string; file: string; folder: string; failures: string[] }> {
  const d = hooks.deps ?? { auditPage, measurePage, runLighthouse, fetchPsi };
  const labels = planSteps(req);
  if (!labels.length) throw new Error("Nothing to do: add at least one URL.");
  const input: ReportInput = { audits: [], comparisons: [], measurements: [], lighthouse: [], failures: [] };
  if (req.baselinePath) input.baseline = await loadBaseline(req.baselinePath); // fail early on a bad baseline
  hooks.onPlan?.(labels);

  const files: Array<[string, string]> = [];
  const browserOk = cfg.policy.mode === "local";
  let idx = 0;
  const step = async (fn: () => Promise<void>) => {
    const i = idx++;
    if (hooks.shouldCancel?.()) { hooks.onStep?.(i, "failed", "cancelled"); throw new Error("Cancelled."); }
    hooks.onStep?.(i, "running");
    try { await fn(); hooks.onStep?.(i, "done"); }
    catch (e) { input.failures!.push(`${labels[i]}: ${message(e)}`); hooks.onStep?.(i, "failed", message(e)); }
  };

  for (const url of req.audits) await step(async () => { input.audits.push(await d.auditPage(url, cfg)); });
  for (const [o, n] of req.compares) await step(async () => {
    const [a, b] = await Promise.all([d.auditPage(o, cfg), d.auditPage(n, cfg)]);
    input.comparisons.push(comparePages(a, b));
  });
  for (const url of req.measures) await step(async () => {
    if (!browserOk) throw new Error("browser measurement requires WPI_MODE=local");
    input.measurements.push(await d.measurePage(url, { policy: cfg.policy, profile: req.profile, runs: req.runs }));
  });
  for (const [i, url] of req.lighthouse.entries()) await step(async () => {
    if (!browserOk) throw new Error("Lighthouse requires WPI_MODE=local");
    // Read the page HTML (same network policy) so the report can tell which fixes are already applied. Best effort.
    const known = input.audits.find((a) => a.url === url) ?? await d.auditPage(url, cfg).catch(() => undefined);
    if (known?.preloads) (input.pageSignals ??= {})[url] = { preloads: known.preloads };
    const m = await d.runLighthouse(url, { policy: cfg.policy, profile: req.profile, runs: req.runs, keepReports: true, whatIf: true });
    const reportFiles = (m.htmlReports ?? []).map((html, r) => { const name = `lighthouse-${i + 1}-run${r + 1}.html`; files.push([name, html]); return name; });
    delete m.htmlReports; // keep the combined report small; the full reports are separate files
    input.lighthouse.push({ measurement: m, reportFiles });
  });

  if (req.psi) for (const url of req.lighthouse) await step(async () => {
    // Local/private URLs cannot be reached by Google: report that instead of failing the step.
    if (!(await isPsiTestable(url))) { (input.psi ??= {})[url] = { error: "PageSpeed Insights can only test public URLs; this one is local or private." }; return; }
    try { (input.psi ??= {})[url] = { result: await (d.fetchPsi ?? fetchPsi)(url, { strategy: req.profile, apiKey: req.psiApiKey }) }; }
    catch (e) { (input.psi ??= {})[url] = { error: message(e) }; throw e; }
  });

  const site = req.audits[0] ?? req.compares[0]?.[1] ?? req.measures[0] ?? req.lighthouse[0]!;
  let host = "report"; try { host = new URL(site).hostname; } catch { /* default */ }
  input.title = `Report: ${host}`;
  const folder = reportFolderName(site);
  const dir = join(req.outDir, folder);
  const flags = [...req.audits.map((u) => `--audit ${shq(u)}`), ...req.compares.map(([o, n]) => `--compare ${shq(`${o},${n}`)}`), ...req.measures.map((u) => `--measure ${shq(u)}`),
    ...req.lighthouse.map((u) => `--lighthouse ${shq(u)}`), `--runs ${req.runs}`, `--profile ${req.profile}`, `--baseline ${shq(dir)}`, ...(req.psi ? ["--psi"] : [])];
  const tls = [...req.audits, ...req.measures, ...req.lighthouse].some((u) => u.startsWith("https:")) ? "NODE_USE_SYSTEM_CA=1 " : "";
  input.rerunCommand = `${tls}npm run wpi -- report ${flags.join(" ")}`;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.html"), renderHtmlReport(input));
  await writeFile(join(dir, "data.json"), JSON.stringify({ ...input, generatedAt: new Date().toISOString() }, null, 2));
  for (const [name, html] of files) await writeFile(join(dir, name), html);
  return { dir, file: join(dir, "report.html"), folder, failures: input.failures! };
}
