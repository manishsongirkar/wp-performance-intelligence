import { parseArgs } from "node:util";
import { loadConfig, loadDotEnv } from "./config.js";
import { generateReport, reportFolderName } from "./report.js";

export { reportFolderName };

export const REPORT_USAGE = `  wpi report [--audit URL]... [--compare OLD,NEW]... [--measure URL]... [--lighthouse URL]...
             [--runs 1-5] [--profile desktop|mobile] [--out DIR] [--baseline DIR|data.json] [--psi]
  Writes <DIR or ~/Desktop>/<site>_<YYYY-MM-DD_HH-mm-ss>/report.html (+ Lighthouse reports).
  --psi: also query Google PageSpeed Insights for each --lighthouse URL (sends the URL to Google; public sites only;
         set WPI_PSI_API_KEY to avoid quota errors).
  --baseline: a previous report folder; the new report shows before/after deltas.`;

export async function runReport(argv: string[]): Promise<string> {
  const { values } = parseArgs({ args: argv, options: {
    audit: { type: "string", multiple: true }, compare: { type: "string", multiple: true }, measure: { type: "string", multiple: true },
    lighthouse: { type: "string", multiple: true }, baseline: { type: "string" }, psi: { type: "boolean" }, runs: { type: "string", default: "3" }, profile: { type: "string", default: "desktop" }, out: { type: "string" }
  } });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 5) throw new Error("--runs must be an integer from 1 to 5.");
  if (values.profile !== "desktop" && values.profile !== "mobile") throw new Error("--profile must be desktop or mobile.");
  const compares = (values.compare ?? []).map((p) => { const [o, n, ...rest] = p.split(","); if (!o || !n || rest.length) throw new Error(`--compare expects OLD,NEW (got "${p}").`); return [o, n] as [string, string]; });
  loadDotEnv();
  const config = loadConfig();
  const { file } = await generateReport(
    { audits: values.audit ?? [], compares, measures: values.measure ?? [], lighthouse: values.lighthouse ?? [], runs, profile: values.profile, psi: values.psi, psiApiKey: config.psiApiKey, baselinePath: values.baseline, outDir: values.out ?? config.reportsDir },
    config.fetch, { onStep: (i, state) => { if (state === "running") console.log(`- step ${i + 1}`); } }
  );
  return file;
}
