import type { UrlPair } from "../../contracts/src/types.js";

/** RFC 4180-style parser: quoted fields may contain commas, quotes ("") and newlines. */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') value += ch;
      else if (text[i + 1] === '"') { value += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && value.trim() === "") { quoted = true; value = ""; }
    else if (ch === ",") { row.push(value.trim()); value = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(value.trim()); rows.push(row); row = []; value = "";
    } else value += ch;
  }
  if (quoted) throw new Error("CSV contains an unclosed quoted field.");
  row.push(value.trim()); rows.push(row);
  return rows.filter((r) => r.some((c) => c));
}

export function parseUrlCsv(csv: string): { mode: "urls" | "pairs"; urls: string[]; pairs: UrlPair[]; errors: string[] } {
  const parsedRows = parseCsvRows(csv.replace(/^\uFEFF/, ""));
  if (parsedRows.length < 2) throw new Error("CSV must contain a header and at least one data row.");
  const headers = parsedRows[0]!.map((h) => h.toLowerCase());
  const errors: string[] = [];
  const rows = parsedRows.slice(1).map((cells, index) => ({ cells, rowNumber: index + 2 }));
  const oldIndex = headers.indexOf("old_url");
  const newIndex = headers.indexOf("new_url");
  const urlIndex = headers.indexOf("url");
  const groupIndex = headers.indexOf("group");
  const priorityIndex = headers.indexOf("priority");

  if (oldIndex >= 0 && newIndex >= 0) {
    const pairs: UrlPair[] = [];
    for (const row of rows) {
      const oldUrl = row.cells[oldIndex] ?? "";
      const newUrl = row.cells[newIndex] ?? "";
      if (!oldUrl || !newUrl) { errors.push(`Row ${row.rowNumber}: old_url and new_url are required.`); continue; }
      if (!isHttpUrl(oldUrl) || !isHttpUrl(newUrl)) { errors.push(`Row ${row.rowNumber}: URLs must use http:// or https://.`); continue; }
      pairs.push({
        oldUrl, newUrl,
        group: groupIndex >= 0 ? row.cells[groupIndex] : undefined,
        priority: priorityIndex >= 0 ? row.cells[priorityIndex] : undefined,
        rowNumber: row.rowNumber
      });
    }
    return { mode: "pairs", urls: [], pairs, errors };
  }
  if (urlIndex >= 0) {
    const urls: string[] = [];
    for (const row of rows) {
      const url = row.cells[urlIndex] ?? "";
      if (!url) { errors.push(`Row ${row.rowNumber}: url is required.`); continue; }
      if (!isHttpUrl(url)) { errors.push(`Row ${row.rowNumber}: URL must use http:// or https://.`); continue; }
      urls.push(url);
    }
    return { mode: "urls", urls: [...new Set(urls)], pairs: [], errors };
  }
  throw new Error("CSV header must include either `url` or both `old_url` and `new_url`.");
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}
