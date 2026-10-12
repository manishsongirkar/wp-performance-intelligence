import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { auditPage } from "../../../packages/audit-core/src/audit.js";
import { comparePages } from "../../../packages/site-comparison/src/compare.js";
import { measurePage } from "../../../packages/browser-audit/src/measure.js";
import { runLighthouse } from "../../../packages/browser-audit/src/lighthouse.js";
import { renderHtmlReport, type ReportInput } from "../../../packages/reports/src/html.js";
import type { Config } from "./config.js";
import type { BrowserMeasurement } from "../../../packages/contracts/src/types.js";

export type Profile = "desktop" | "mobile";
/** Unique, in report order (mobile first). */
export const normalizeProfiles = (p: Profile[]): Profile[] => (["mobile", "desktop"] as Profile[]).filter((x) => p.includes(x));

export interface ReportRequest {
  audits: string[];
  compares: Array<[string, string]>;
  measures: string[];
  lighthouse: string[];
  runs: number;
  /** Device profiles for browser measurement and Lighthouse. Each URL is tested once per profile. */
  profiles: Profile[];
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
  deps?: { auditPage: typeof auditPage; measurePage: typeof measurePage; runLighthouse: typeof runLighthouse };
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
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, "utf8")); } catch { throw new Error("baseline is not valid JSON"); }
  const d = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (!d) throw new Error("baseline is not a report");
  // The file is only JSON on disk: keep entries that have the shape the renderer reads and drop the rest, so a hand-edited or
  // old data.json cannot crash the report after all the (slow) checks have already run.
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const okMeasure = (m: unknown) => obj(m) && typeof m.url === "string" && typeof m.profile === "string" && obj(m.summary);
  const lighthouse = (Array.isArray(d.lighthouse) ? d.lighthouse : []).filter((l) => obj(l) && okMeasure(l.measurement)) as unknown as NonNullable<ReportInput["baseline"]>["lighthouse"];
  const measurements = (Array.isArray(d.measurements) ? d.measurements : []).filter(okMeasure) as unknown as BrowserMeasurement[];
  if (!lighthouse.length && !measurements.length) throw new Error("baseline has no Lighthouse or browser measurements");
  return { generatedAt: typeof d.generatedAt === "string" ? d.generatedAt.slice(0, 40) : undefined, lighthouse, measurements };
}

const profiles = (r: ReportRequest) => normalizeProfiles(r.profiles);

export function planSteps(r: ReportRequest): string[] {
  return [...r.audits.map((u) => `audit ${u}`), ...r.compares.map(([o, n]) => `compare ${o} vs ${n}`), ...r.measures.flatMap((u) => profiles(r).map((p) => `measure ${u} (${p})`)), ...r.lighthouse.flatMap((u) => profiles(r).map((p) => `lighthouse ${u} (${p})`))];
}

/** Runs every requested step, then writes report.html, data.json and the Lighthouse reports. A failing step is recorded in the report, not fatal. */
export async function generateReport(req: ReportRequest, cfg: Config["fetch"], hooks: ReportHooks = {}): Promise<{ dir: string; file: string; folder: string; failures: string[]; stepCount: number }> {
  const d = hooks.deps ?? { auditPage, measurePage, runLighthouse };
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
  // Read the page HTML once per URL (same network policy) so the report can tell which fixes are already applied. Best effort.
  const collectSignals = async (url: string) => {
    if (input.pageSignals?.[url]) return;
    const known = input.audits.find((a) => a.url === url) ?? await d.auditPage(url, cfg).catch(() => undefined);
    if (known) (input.pageSignals ??= {})[url] = { preloads: known.preloads, scripts: known.scripts, stylesheets: known.stylesheets, imgTags: known.imgTags, preconnects: known.preconnects };
  };
  // Order matters: it must match planSteps(). URL-outer, profile-inner, so a URL's mobile and desktop results sit together.
  for (const url of req.measures) for (const profile of profiles(req)) await step(async () => {
    if (!browserOk) throw new Error("browser measurement requires WPI_MODE=local");
    await collectSignals(url);
    input.measurements.push(await d.measurePage(url, { policy: cfg.policy, profile, runs: req.runs }));
  });
  for (const [i, url] of req.lighthouse.entries()) for (const profile of profiles(req)) await step(async () => {
    if (!browserOk) throw new Error("Lighthouse requires WPI_MODE=local");
    await collectSignals(url);
    const m = await d.runLighthouse(url, { policy: cfg.policy, profile, runs: req.runs, keepReports: true, whatIf: true });
    const reportFiles = (m.htmlReports ?? []).map((html, r) => { const name = `lighthouse-${i + 1}-${profile}-run${r + 1}.html`; files.push([name, html]); return name; });
    delete m.htmlReports; // keep the combined report small; the full reports are separate files
    input.lighthouse.push({ measurement: m, reportFiles });
  });

  const site = req.audits[0] ?? req.compares[0]?.[1] ?? req.measures[0] ?? req.lighthouse[0]!;
  let host = "report"; try { host = new URL(site).hostname; } catch { /* default */ }
  input.title = `Report: ${host}`;
  // Never overwrite an earlier report (names have one-second resolution): move forward a second until the folder is free.
  let when = new Date(), folder = reportFolderName(site, when);
  for (let i = 0; i < 300 && existsSync(join(req.outDir, folder)); i++) { when = new Date(when.getTime() + 1000); folder = reportFolderName(site, when); }
  const dir = join(req.outDir, folder);
  const flags = [...req.audits.map((u) => `--audit ${shq(u)}`), ...req.compares.map(([o, n]) => `--compare ${shq(`${o},${n}`)}`), ...req.measures.map((u) => `--measure ${shq(u)}`),
    ...req.lighthouse.map((u) => `--lighthouse ${shq(u)}`), `--runs ${req.runs}`, ...profiles(req).map((p) => `--profile ${p}`), `--baseline ${shq(dir)}`];
  const tls = [...req.audits, ...req.measures, ...req.lighthouse].some((u) => u.startsWith("https:")) ? "NODE_USE_SYSTEM_CA=1 " : "";
  input.rerunCommand = `${tls}npm run wpi -- report ${flags.join(" ")}`;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.html"), renderHtmlReport(input));
  await writeFile(join(dir, "data.json"), JSON.stringify({ ...input, generatedAt: new Date().toISOString() }, null, 2));
  for (const [name, html] of files) await writeFile(join(dir, name), html);
  return { dir, file: join(dir, "report.html"), folder, failures: input.failures!, stepCount: labels.length };
}
