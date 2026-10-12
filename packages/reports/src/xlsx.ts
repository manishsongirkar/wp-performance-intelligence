import ExcelJS from "exceljs";
import type { PageAudit, ComparisonResult, LighthouseMeasurement, BrowserMeasurement } from "../../contracts/src/types.js";

/** Neutralises spreadsheet formula injection: text starting with = + - @ or a control char is prefixed with an apostrophe. */
export function safeCell(value: unknown): unknown {
  return typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
const safeRow = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, safeCell(v)]));

/** Performance data as stored in a report's data.json; read defensively because the file is just JSON on disk. */
export interface PerformanceExport { lighthouse?: Array<{ measurement?: LighthouseMeasurement }>; measurements?: BrowserMeasurement[] }

export async function createAuditWorkbook(results: Array<PageAudit | ComparisonResult>, perf: PerformanceExport = {}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "WP Performance Intelligence";
  workbook.created = new Date();
  const summary = workbook.addWorksheet("Summary");
  summary.columns = [
    { header: "Type", key: "type", width: 18 },
    { header: "URL", key: "url", width: 48 },
    { header: "Status", key: "status", width: 16 },
    { header: "Findings / Differences", key: "count", width: 22 },
    { header: "Generated At", key: "date", width: 28 }
  ];
  for (const item of results) {
    if ("differences" in item) summary.addRow(safeRow({ type: "Comparison", url: `${item.oldUrl} → ${item.newUrl}`, status: item.status, count: item.differences.length, date: item.comparedAt }));
    else summary.addRow(safeRow({ type: "Audit", url: item.url, status: item.statusCode, count: item.findings.length, date: item.fetchedAt }));
  }
  styleHeader(summary);

  const findings = workbook.addWorksheet("Findings");
  findings.columns = [
    { header: "URL", key: "url", width: 48 },
    { header: "Rule ID", key: "ruleId", width: 30 },
    { header: "Category", key: "category", width: 18 },
    { header: "Severity", key: "severity", width: 14 },
    { header: "Confidence", key: "confidence", width: 14 },
    { header: "Finding", key: "title", width: 36 },
    { header: "Description", key: "description", width: 60 },
    { header: "Recommendation", key: "recommendation", width: 70 },
    { header: "Status", key: "status", width: 16 }
  ];
  for (const item of results) {
    if ("differences" in item) {
      for (const d of item.differences) findings.addRow(safeRow({ url: item.newUrl, ruleId: d.id, category: d.category, severity: d.severity, confidence: "", title: d.title, description: `Old: ${JSON.stringify(d.oldValue)} | New: ${JSON.stringify(d.newValue)}`, recommendation: d.recommendation, status: item.status }));
    } else {
      for (const f of item.findings) findings.addRow(safeRow({ url: f.url, ruleId: f.ruleId, category: f.category, severity: f.severity, confidence: f.confidence, title: f.title, description: f.description, recommendation: f.recommendation, status: f.status }));
    }
  }
  styleHeader(findings);
  findings.autoFilter = { from: "A1", to: "I1" };
  findings.views = [{ state: "frozen", ySplit: 1 }];
  addPerformanceSheets(workbook, perf);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF263449" } };
  header.height = 24;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}

const med = (summary: Record<string, { median?: number } | undefined> | undefined, key: string) => {
  const v = summary?.[key]?.median;
  return typeof v === "number" ? v : null;
};

function addPerformanceSheets(workbook: ExcelJS.Workbook, perf: PerformanceExport): void {
  const lh = (perf.lighthouse ?? []).map((l) => l.measurement).filter((m): m is LighthouseMeasurement => !!m);
  const br = perf.measurements ?? [];
  if (!lh.length && !br.length) return;
  const sheet = workbook.addWorksheet("Performance");
  sheet.columns = [
    { header: "Source", key: "source", width: 16 }, { header: "URL", key: "url", width: 48 }, { header: "Profile", key: "profile", width: 10 }, { header: "Runs", key: "runs", width: 8 },
    { header: "Performance", key: "perf", width: 12 }, { header: "Accessibility", key: "a11y", width: 13 }, { header: "Best practices", key: "bp", width: 14 }, { header: "SEO", key: "seo", width: 8 },
    { header: "TTFB (ms)", key: "ttfb", width: 11 }, { header: "FCP (ms)", key: "fcp", width: 10 }, { header: "LCP (ms)", key: "lcp", width: 10 }, { header: "TBT (ms)", key: "tbt", width: 10 },
    { header: "CLS", key: "cls", width: 8 }, { header: "Speed Index (ms)", key: "si", width: 16 }, { header: "TTI (ms)", key: "tti", width: 10 }, { header: "Load (ms)", key: "load", width: 10 }, { header: "Transfer (bytes)", key: "bytes", width: 16 }
  ];
  for (const m of lh) {
    const s = m.summary;
    sheet.addRow(safeRow({ source: "Lighthouse (lab)", url: m.url, profile: m.profile, runs: m.runs.filter((r) => r.ok).length, perf: med(s, "performanceScore"), a11y: med(s, "accessibilityScore"), bp: med(s, "bestPracticesScore"), seo: med(s, "seoScore"),
      fcp: med(s, "fcpMs"), lcp: med(s, "lcpMs"), tbt: med(s, "tbtMs"), cls: med(s, "cls"), si: med(s, "speedIndexMs"), tti: med(s, "ttiMs") }));
  }
  for (const m of br) {
    const s = m.summary as Record<string, { median?: number } | undefined>;
    sheet.addRow(safeRow({ source: "Browser (lab)", url: m.url, profile: m.profile, runs: m.runs.filter((r) => r.ok).length, ttfb: med(s, "ttfbMs"), fcp: med(s, "fcpMs"), lcp: med(s, "lcpMs"),
      cls: med(s, "cls"), load: med(s, "loadMs"), bytes: med(s, "transferBytes") }));
  }
  styleHeader(sheet);

  const opps = workbook.addWorksheet("Opportunities");
  opps.columns = [{ header: "URL", key: "url", width: 48 }, { header: "Profile", key: "profile", width: 10 }, { header: "Audit", key: "id", width: 30 }, { header: "Title", key: "title", width: 44 }, { header: "Est. savings (ms, simulated)", key: "ms", width: 26 }];
  for (const m of lh) for (const o of m.runs.find((r) => r.ok)?.opportunities ?? []) opps.addRow(safeRow({ url: m.url, profile: m.profile, id: o.id, title: o.title, ms: o.savingsMs }));
  styleHeader(opps);
}
