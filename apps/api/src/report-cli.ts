import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { auditPage } from "../../../packages/audit-core/src/audit.js";
import { comparePages } from "../../../packages/site-comparison/src/compare.js";
import { measurePage } from "../../../packages/browser-audit/src/measure.js";
import { runLighthouse } from "../../../packages/browser-audit/src/lighthouse.js";
import { renderHtmlReport, type ReportInput } from "../../../packages/reports/src/html.js";
import { loadConfig, loadDotEnv } from "./config.js";

export const REPORT_USAGE = `  wpi report [--audit URL]... [--compare OLD,NEW]... [--measure URL]... [--lighthouse URL]...
             [--runs 1-5] [--profile desktop|mobile] [--out DIR] [--baseline DIR|data.json]
  Writes <DIR or ~/Desktop>/<site>_<YYYY-MM-DD_HH-mm-ss>/report.html (+ Lighthouse reports).
  --baseline: a previous report folder; the new report shows before/after deltas.`;

const pad = (n: number) => String(n).padStart(2, "0");
/** Folder name: site hostname + local date/time, e.g. geokon.test_2026-10-12_14-30-05 */
export function reportFolderName(siteUrl: string, now = new Date()): string {
  let host = "report";
  try { host = new URL(siteUrl).hostname; } catch { /* keep default */ }
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${host.replace(/[^a-z0-9.-]/gi, "_")}_${stamp}`;
}

const shq = (v: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
async function loadBaseline(path: string): Promise<NonNullable<ReportInput["baseline"]>> {
  const file = (await stat(path)).isDirectory() ? join(path, "data.json") : path;
  const d = JSON.parse(await readFile(file, "utf8")) as Partial<ReportInput> & { generatedAt?: string };
  if (!Array.isArray(d.lighthouse) && !Array.isArray(d.measurements)) throw new Error("baseline has no Lighthouse or browser measurements");
  return { generatedAt: d.generatedAt, lighthouse: d.lighthouse ?? [], measurements: d.measurements ?? [] };
}

const message = (e: unknown) => (e instanceof Error ? e.message : "failed");

export async function runReport(argv: string[]): Promise<string> {
  const { values } = parseArgs({ args: argv, options: {
    audit: { type: "string", multiple: true }, compare: { type: "string", multiple: true }, measure: { type: "string", multiple: true },
    lighthouse: { type: "string", multiple: true }, baseline: { type: "string" }, runs: { type: "string", default: "3" }, profile: { type: "string", default: "desktop" }, out: { type: "string" }
  } });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error("--runs must be an integer from 1 to 5.");
  if (values.profile !== "desktop" && values.profile !== "mobile") throw new Error("--profile must be desktop or mobile.");
  const pairs = (values.compare ?? []).map((p) => { const [o, n, ...rest] = p.split(","); if (!o || !n || rest.length) throw new Error(`--compare expects OLD,NEW (got "${p}").`); return [o, n] as const; });
  const audits = values.audit ?? [], measures = values.measure ?? [], lights = values.lighthouse ?? [];
  if (!audits.length && !pairs.length && !measures.length && !lights.length) throw new Error("Nothing to do. Pass at least one of --audit, --compare, --measure, --lighthouse.");

  loadDotEnv();
  const { fetch: fetchCfg } = loadConfig();
  const profile = values.profile;
  const input: ReportInput = { audits: [], comparisons: [], measurements: [], lighthouse: [], failures: [] };
  if (values.baseline) input.baseline = await loadBaseline(values.baseline); // fail early on a bad path
  const files: Array<[string, string]> = [];
  const step = async (label: string, fn: () => Promise<void>) => { console.log(`- ${label}`); try { await fn(); } catch (e) { input.failures!.push(`${label}: ${message(e)}`); } };

  for (const url of audits) await step(`audit ${url}`, async () => { input.audits.push(await auditPage(url, fetchCfg)); });
  for (const [o, n] of pairs) await step(`compare ${o} vs ${n}`, async () => {
    const [a, b] = await Promise.all([auditPage(o, fetchCfg), auditPage(n, fetchCfg)]);
    input.comparisons.push(comparePages(a, b));
  });
  const browserOk = fetchCfg.policy.mode === "local";
  for (const url of measures) await step(`measure ${url}`, async () => {
    if (!browserOk) throw new Error("browser measurement requires WPI_MODE=local");
    input.measurements.push(await measurePage(url, { policy: fetchCfg.policy, profile, runs }));
  });
  for (const [i, url] of lights.entries()) await step(`lighthouse ${url}`, async () => {
    if (!browserOk) throw new Error("Lighthouse requires WPI_MODE=local");
    const m = await runLighthouse(url, { policy: fetchCfg.policy, profile, runs, keepReports: true });
    const reportFiles = (m.htmlReports ?? []).map((html, r) => { const name = `lighthouse-${i + 1}-run${r + 1}.html`; files.push([name, html]); return name; });
    delete m.htmlReports; // keep the combined report small; the full reports are separate files
    input.lighthouse.push({ measurement: m, reportFiles });
  });

  const site = audits[0] ?? pairs[0]?.[1] ?? measures[0] ?? lights[0]!;
  input.title = `Report: ${new URL(site).hostname}`;
  const dir = join(values.out ?? join(homedir(), "Desktop"), reportFolderName(site));
  const flags = [...audits.map((u) => `--audit ${shq(u)}`), ...pairs.map(([o, n]) => `--compare ${shq(`${o},${n}`)}`), ...measures.map((u) => `--measure ${shq(u)}`),
    ...lights.map((u) => `--lighthouse ${shq(u)}`), `--runs ${runs}`, `--profile ${profile}`, `--baseline ${shq(dir)}`];
  const tls = [...audits, ...measures, ...lights].some((u) => u.startsWith("https:")) ? "NODE_USE_SYSTEM_CA=1 " : "";
  input.rerunCommand = `${tls}pnpm wpi report ${flags.join(" ")}`;
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "report.html"), renderHtmlReport(input));
  await writeFile(join(dir, "data.json"), JSON.stringify({ ...input, generatedAt: new Date().toISOString() }, null, 2));
  for (const [name, html] of files) await writeFile(join(dir, name), html);
  return join(dir, "report.html");
}
