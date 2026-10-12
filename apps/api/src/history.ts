import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { REPORT_FOLDER } from "./report.js";

export interface HistoryPoint {
  folder: string;
  /** ISO time of the report. */
  at: string;
  url: string;
  device: "mobile" | "desktop" | null;
  kind: "lighthouse" | "browser" | "audit";
  values: Record<string, number | null>;
}
export interface HistoryReport {
  folder: string;
  at: string;
  title: string;
  reportUrl: string;
  urls: string[];
  /** Counts of what was run, e.g. { lighthouse: 2, browser: 1, audit: 2, comparisons: 0 }. */
  tools: Record<"lighthouse" | "browser" | "audit" | "comparisons", number>;
  failures: number;
  /** Headline numbers for the list: Lighthouse Performance per URL and device. */
  headline: Array<{ url: string; device: "mobile" | "desktop"; performance: number | null }>;
}

const MAX_BYTES = 25_000_000;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");
const device = (v: unknown): "mobile" | "desktop" | null => (v === "mobile" || v === "desktop" ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const median = (summary: Record<string, unknown>, key: string) => num(rec(summary[key]).median);

/** Parses one data.json defensively: it is only a file on disk, so every field is type-checked and nothing is trusted. */
export function parseReport(folder: string, raw: unknown, fallbackAt: string): { report: HistoryReport; points: HistoryPoint[] } {
  const d = rec(raw);
  const at = typeof d.generatedAt === "string" && !Number.isNaN(Date.parse(d.generatedAt)) ? new Date(d.generatedAt).toISOString() : fallbackAt;
  const points: HistoryPoint[] = [];
  const headline: HistoryReport["headline"] = [];
  const urls = new Set<string>();

  for (const l of arr(d.lighthouse)) {
    const m = rec(rec(l).measurement), url = str(m.url), dev = device(m.profile), s = rec(m.summary);
    if (!url) continue;
    urls.add(url);
    const performance = median(s, "performanceScore");
    points.push({ folder, at, url, device: dev, kind: "lighthouse", values: {
      performance, accessibility: median(s, "accessibilityScore"), bestPractices: median(s, "bestPracticesScore"), seo: median(s, "seoScore"),
      fcpMs: median(s, "fcpMs"), lcpMs: median(s, "lcpMs"), tbtMs: median(s, "tbtMs"), cls: median(s, "cls"), speedIndexMs: median(s, "speedIndexMs")
    } });
    if (dev) headline.push({ url, device: dev, performance });
  }
  for (const b of arr(d.measurements)) {
    const m = rec(b), url = str(m.url), s = rec(m.summary);
    if (!url) continue;
    urls.add(url);
    points.push({ folder, at, url, device: device(m.profile), kind: "browser", values: {
      ttfbMs: median(s, "ttfbMs"), fcpMs: median(s, "fcpMs"), lcpMs: median(s, "lcpMs"), cls: median(s, "cls"), loadMs: median(s, "loadMs"), transferBytes: median(s, "transferBytes")
    } });
  }
  for (const a of arr(d.audits)) {
    const p = rec(a), url = str(p.url);
    if (!url) continue;
    urls.add(url);
    const sev = (name: string) => arr(p.findings).filter((f) => rec(f).severity === name).length;
    points.push({ folder, at, url, device: null, kind: "audit", values: { issues: arr(p.findings).length, criticalHigh: sev("critical") + sev("high"), missingAlt: num(rec(p.images).missingAlt) } });
  }
  for (const c of arr(d.comparisons)) { urls.add(str(rec(c).newUrl)); }
  urls.delete("");

  return {
    points,
    report: {
      folder, at, title: str(d.title, 200) || folder, reportUrl: `/reports/${folder}/report.html`, urls: [...urls].slice(0, 20),
      tools: { lighthouse: arr(d.lighthouse).length, browser: arr(d.measurements).length, audit: arr(d.audits).length, comparisons: arr(d.comparisons).length },
      failures: arr(d.failures).length, headline: headline.slice(0, 12)
    }
  };
}

const cache = new Map<string, ReturnType<typeof parseReport>>();

/** Reads every saved report folder (newest `limit`), cached by file size and modification time. Unreadable or hostile files are skipped, never fatal. */
export async function readHistory(dir: string, limit = 60): Promise<{ reports: HistoryReport[]; points: HistoryPoint[] }> {
  let names: string[] = [];
  try { names = (await readdir(dir)).filter((n) => REPORT_FOLDER.test(n)); } catch { return { reports: [], points: [] }; }
  const found: Array<{ name: string; mtime: Date }> = [];
  for (const name of names) { try { found.push({ name, mtime: (await stat(join(dir, name, "report.html"))).mtime }); } catch { /* not a report */ } }
  found.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const reports: HistoryReport[] = [], points: HistoryPoint[] = [];
  for (const { name, mtime } of found.slice(0, limit)) {
    const fallback = mtime.toISOString();
    let parsed: ReturnType<typeof parseReport> | undefined;
    try {
      const st = await stat(join(dir, name, "data.json"));
      const key = `${dir}|${name}|${st.size}|${st.mtimeMs}`;
      parsed = cache.get(key);
      if (!parsed && st.size <= MAX_BYTES) { parsed = parseReport(name, JSON.parse(await readFile(join(dir, name, "data.json"), "utf8")), fallback); cache.set(key, parsed); }
    } catch { /* missing or malformed data.json: still list the report, without graph points */ }
    parsed ??= parseReport(name, {}, fallback);
    reports.push(parsed.report); points.push(...parsed.points);
  }
  reports.sort((a, b) => b.at.localeCompare(a.at));
  points.sort((a, b) => a.at.localeCompare(b.at));
  if (cache.size > 500) cache.clear();
  return { reports, points };
}
