import ExcelJS from "exceljs";
import type { PageAudit, ComparisonResult } from "../../contracts/src/types.js";

export async function createAuditWorkbook(results: Array<PageAudit | ComparisonResult>): Promise<Buffer> {
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
    if ("differences" in item) summary.addRow({ type: "Comparison", url: `${item.oldUrl} → ${item.newUrl}`, status: item.status, count: item.differences.length, date: item.comparedAt });
    else summary.addRow({ type: "Audit", url: item.url, status: item.statusCode, count: item.findings.length, date: item.fetchedAt });
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
      for (const d of item.differences) findings.addRow({ url: item.newUrl, ruleId: d.id, category: d.category, severity: d.severity, confidence: "", title: d.title, description: `Old: ${JSON.stringify(d.oldValue)} | New: ${JSON.stringify(d.newValue)}`, recommendation: d.recommendation, status: item.status });
    } else {
      for (const f of item.findings) findings.addRow({ url: f.url, ruleId: f.ruleId, category: f.category, severity: f.severity, confidence: f.confidence, title: f.title, description: f.description, recommendation: f.recommendation, status: f.status });
    }
  }
  styleHeader(findings);
  findings.autoFilter = { from: "A1", to: "I1" };
  findings.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF263449" } };
  header.height = 24;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
}
