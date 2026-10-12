import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "./config.js";
import { generateReport, normalizeProfiles, reportFolderName, type Profile } from "./report.js";

export { reportFolderName };

export const REPORT_USAGE = `  wpi report [--audit URL]... [--compare OLD,NEW]... [--measure URL]... [--lighthouse URL]...
             [--runs 1-5] [--profile desktop|mobile]... [--out DIR] [--baseline DIR|data.json]
  Writes <DIR or ~/Desktop>/<site>_<YYYY-MM-DD_HH-mm-ss>/report.html (+ Lighthouse reports).
  --profile may be repeated (or "both") to test mobile and desktop in one report; the default is desktop.
  --baseline: a previous report folder; the new report shows before/after deltas.`;

export async function runReport(argv: string[]): Promise<string> {
  const { values } = parseArgs({ args: argv, options: {
    audit: { type: "string", multiple: true }, compare: { type: "string", multiple: true }, measure: { type: "string", multiple: true },
    lighthouse: { type: "string", multiple: true }, baseline: { type: "string" }, runs: { type: "string", default: "3" }, profile: { type: "string", multiple: true }, out: { type: "string" }
  } });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error("--runs must be an integer from 1 to 5.");
  // Repeat --profile (or use "both") to test mobile and desktop in one report. Default: desktop.
  const requested = (values.profile ?? ["desktop"]).flatMap((p) => (p === "both" ? ["mobile", "desktop"] : [p]));
  const bad = requested.find((p) => p !== "desktop" && p !== "mobile");
  if (bad) throw new Error(`--profile must be desktop, mobile or both (got "${bad}").`);
  const profiles = normalizeProfiles(requested as Profile[]);
  const compares = (values.compare ?? []).map((p) => { const [o, n, ...rest] = p.split(","); if (!o || !n || rest.length) throw new Error(`--compare expects OLD,NEW (got "${p}").`); return [o, n] as [string, string]; });
  loadDotEnv();
  const config = loadConfig();
  const { file, failures, stepCount } = await generateReport(
    { audits: values.audit ?? [], compares, measures: values.measure ?? [], lighthouse: values.lighthouse ?? [], runs, profiles, baselinePath: values.baseline, outDir: values.out ?? config.reportsDir },
    config.fetch, { onStep: (i, state) => { if (state === "running") console.log(`- step ${i + 1}`); } }
  );
  if (stepCount > 0 && failures.length >= stepCount) { process.exitCode = 1; console.error(`Every check failed (first: ${failures[0]}). The report only lists the failures.`); }
  return file;
}
