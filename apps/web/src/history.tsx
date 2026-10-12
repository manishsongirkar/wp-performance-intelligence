import React, { useMemo, useState } from "react";

export interface HistoryPoint { folder: string; at: string; url: string; device: "mobile" | "desktop" | null; kind: "lighthouse" | "browser" | "audit"; values: Record<string, number | null> }
export interface HistoryReport {
  folder: string; at: string; title: string; reportUrl: string; urls: string[];
  tools: { lighthouse: number; browser: number; audit: number; comparisons: number }; failures: number;
  headline: Array<{ url: string; device: "mobile" | "desktop"; performance: number | null }>;
}

type Unit = "score" | "ms" | "cls" | "bytes" | "count";
interface Spec { id: string; title: string; kind: HistoryPoint["kind"]; key: string; unit: Unit; /** Rating bands (web.dev). */ good?: number; poor?: number; higherBetter?: boolean }

// One chart per measured point. Bands are the same Good / Needs improvement / Poor limits Lighthouse and PageSpeed Insights use.
const SCORE = { unit: "score" as const, good: 90, poor: 50, higherBetter: true };
export const SPECS: Spec[] = [
  { id: "lh-performance", title: "Lighthouse · Performance score", kind: "lighthouse", key: "performance", ...SCORE },
  { id: "lh-accessibility", title: "Lighthouse · Accessibility score", kind: "lighthouse", key: "accessibility", ...SCORE },
  { id: "lh-best", title: "Lighthouse · Best Practices score", kind: "lighthouse", key: "bestPractices", ...SCORE },
  { id: "lh-seo", title: "Lighthouse · SEO score", kind: "lighthouse", key: "seo", ...SCORE },
  { id: "lh-lcp", title: "Lighthouse · Largest Contentful Paint", kind: "lighthouse", key: "lcpMs", unit: "ms", good: 2500, poor: 4000 },
  { id: "lh-fcp", title: "Lighthouse · First Contentful Paint", kind: "lighthouse", key: "fcpMs", unit: "ms", good: 1800, poor: 3000 },
  { id: "lh-tbt", title: "Lighthouse · Total Blocking Time", kind: "lighthouse", key: "tbtMs", unit: "ms", good: 200, poor: 600 },
  { id: "lh-cls", title: "Lighthouse · Cumulative Layout Shift", kind: "lighthouse", key: "cls", unit: "cls", good: 0.1, poor: 0.25 },
  { id: "lh-si", title: "Lighthouse · Speed Index", kind: "lighthouse", key: "speedIndexMs", unit: "ms", good: 3400, poor: 5800 },
  { id: "br-lcp", title: "Browser · Largest Contentful Paint", kind: "browser", key: "lcpMs", unit: "ms", good: 2500, poor: 4000 },
  { id: "br-ttfb", title: "Browser · Time to first byte", kind: "browser", key: "ttfbMs", unit: "ms", good: 800, poor: 1800 },
  { id: "br-weight", title: "Browser · Page weight", kind: "browser", key: "transferBytes", unit: "bytes" },
  { id: "au-issues", title: "HTML audit · Issues found", kind: "audit", key: "issues", unit: "count" },
  { id: "au-high", title: "HTML audit · Critical + high issues", kind: "audit", key: "criticalHigh", unit: "count" },
  { id: "au-alt", title: "HTML audit · Images missing alt", kind: "audit", key: "missingAlt", unit: "count" }
];

const PALETTE = ["#4f46e5", "#06b6d4", "#f59e0b", "#10b981", "#ec4899", "#8b5cf6", "#ef4444", "#14b8a6", "#84cc16", "#f97316"];
const DEVICE_LABEL = { mobile: "Mobile", desktop: "Desktop" } as const;

export function formatValue(unit: Unit, v: number): string {
  switch (unit) {
    case "score": return String(Math.round(v));
    case "ms": return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`;
    case "cls": return String(Math.round(v * 1000) / 1000);
    case "bytes": return v >= 1048576 ? `${(v / 1048576).toFixed(2)} MB` : v >= 1024 ? `${Math.round(v / 1024)} KB` : `${Math.round(v)} B`;
    default: return String(Math.round(v));
  }
}
const shortUrl = (u: string) => { try { const x = new URL(u); return `${x.host}${x.pathname === "/" ? "" : x.pathname.replace(/\/$/, "")}`; } catch { return u; } };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

interface Series { key: string; label: string; color: string; dashed: boolean; points: Array<{ folder: string; at: string; v: number }> }

/** Which side of a rating band a value falls in. */
export function rating(spec: Spec, v: number): "good" | "mid" | "bad" | null {
  if (spec.good === undefined || spec.poor === undefined) return null;
  if (spec.higherBetter) return v >= spec.good ? "good" : v >= spec.poor ? "mid" : "bad";
  return v <= spec.good ? "good" : v <= spec.poor ? "mid" : "bad";
}

function LineChart({ spec, series, onOpen }: { spec: Spec; series: Series[]; onOpen: (folder: string) => void }) {
  const [hover, setHover] = useState<{ s: Series; p: Series["points"][number]; x: number; y: number } | null>(null);
  const W = 560, H = 210, L = 46, R = 12, T = 10, B = 28;
  const times = [...new Set(series.flatMap((s) => s.points.map((p) => p.at)))].sort();          // one x position per report
  const all = series.flatMap((s) => s.points.map((p) => p.v));
  const max = spec.unit === "score" ? 100 : Math.max(spec.poor ? spec.poor * 1.15 : 0, ...all, spec.unit === "count" ? 5 : 0) * (spec.poor ? 1 : 1.15) || 1;
  const x = (at: string) => (times.length <= 1 ? (L + W - R) / 2 : L + (times.indexOf(at) / (times.length - 1)) * (W - L - R));
  const y = (v: number) => T + (1 - Math.min(v, max) / max) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelAt = times.length <= 5 ? times.map((_, i) => i) : [0, Math.floor((times.length - 1) / 3), Math.floor(((times.length - 1) * 2) / 3), times.length - 1];
  const band = (from: number, to: number, cls: string) => <rect key={cls} x={L} width={W - L - R} y={y(Math.max(from, to))} height={Math.abs(y(from) - y(to))} className={`band ${cls}`} />;
  const bands = spec.good === undefined || spec.poor === undefined ? null : spec.higherBetter
    ? [band(spec.good, max, "b-good"), band(spec.poor, spec.good, "b-mid"), band(0, spec.poor, "b-bad")]
    : [band(0, spec.good, "b-good"), band(spec.good, spec.poor, "b-mid"), band(spec.poor, max, "b-bad")];
  const summary = series.map((s) => `${s.label}: ${s.points.map((p) => formatValue(spec.unit, p.v)).join(", ")}`).join("; ");
  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${spec.title} over time. ${summary}`}>
        {bands}
        {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" /><text x={L - 6} y={y(t) + 4} textAnchor="end" className="axis">{formatValue(spec.unit, t)}</text></g>)}
        {labelAt.map((i) => <text key={i} x={x(times[i]!)} y={H - 8} textAnchor={i === 0 && times.length > 1 ? "start" : i === times.length - 1 && times.length > 1 ? "end" : "middle"} className="axis">{when(times[i]!)}</text>)}
        {series.map((s) => (
          <g key={s.key}>
            <polyline fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? "5 4" : undefined} points={s.points.map((p) => `${x(p.at)},${y(p.v)}`).join(" ")} />
            {s.points.map((p) => (
              <circle key={p.folder} cx={x(p.at)} cy={y(p.v)} r={5} fill={s.color} stroke="var(--card)" strokeWidth={2} className="pt" tabIndex={0} role="link"
                aria-label={`${s.label}, ${when(p.at)}: ${formatValue(spec.unit, p.v)}. Open this report`}
                onMouseEnter={() => setHover({ s, p, x: x(p.at), y: y(p.v) })} onFocus={() => setHover({ s, p, x: x(p.at), y: y(p.v) })} onBlur={() => setHover(null)}
                onClick={() => onOpen(p.folder)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(p.folder); } }} />
            ))}
          </g>
        ))}
      </svg>
      {hover && (
        <div className="tip" role="status" style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%` }}>
          <b>{hover.s.label}</b><span>{when(hover.p.at)}</span><strong>{formatValue(spec.unit, hover.p.v)}</strong><em>Click to open this report</em>
        </div>
      )}
    </div>
  );
}

function Legend({ spec, series }: { spec: Spec; series: Series[] }) {
  return (
    <ul className="legend2">
      {series.map((s) => {
        const last = s.points[s.points.length - 1]!, prev = s.points[s.points.length - 2];
        const d = prev ? last.v - prev.v : 0;
        const better = spec.unit === "score" ? d > 0 : d < 0;                  // for counts and times lower is better
        return (
          <li key={s.key}>
            <i style={{ borderTopColor: s.color, borderTopStyle: s.dashed ? "dashed" : "solid" }} />
            <span className="lbl">{s.label}</span>
            <b className={`r-${rating(spec, last.v) ?? "na"}`}>{formatValue(spec.unit, last.v)}</b>
            {prev && d !== 0 && <span className={`trend ${better ? "up" : "down"}`} title="Change since the previous report">{d > 0 ? "▲" : "▼"} {formatValue(spec.unit, Math.abs(d))}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function HistorySection({ reports, points, base, onBaseline }: { reports: HistoryReport[]; points: HistoryPoint[]; base: string; onBaseline: (folder: string) => void }) {
  const [urlOff, setUrlOff] = useState<Set<string>>(new Set());
  const [devOff, setDevOff] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(8);
  const open = (folder: string) => window.open(`${base}/reports/${folder}/report.html`, "_blank", "noopener");

  const urls = useMemo(() => [...new Set(points.map((p) => p.url))].sort(), [points]);
  const colorOf = useMemo(() => {
    const keys = [...new Set(points.map((p) => `${p.url}|${p.device ?? "-"}`))].sort();
    return (k: string) => PALETTE[keys.indexOf(k) % PALETTE.length]!;
  }, [points]);

  const charts = useMemo(() => SPECS.map((spec) => {
    const byKey = new Map<string, Series>();
    for (const p of points) {
      const v = p.values[spec.key];
      if (p.kind !== spec.kind || v === null || v === undefined || urlOff.has(p.url) || (p.device && devOff.has(p.device))) continue;
      const key = `${p.url}|${p.device ?? "-"}`;
      const s = byKey.get(key) ?? { key, label: `${shortUrl(p.url)}${p.device ? ` · ${DEVICE_LABEL[p.device]}` : ""}`, color: colorOf(key), dashed: p.device === "desktop", points: [] };
      s.points.push({ folder: p.folder, at: p.at, v }); byKey.set(key, s);
    }
    return { spec, series: [...byKey.values()].map((s) => ({ ...s, points: s.points.sort((a, b) => a.at.localeCompare(b.at)) })) };
  }).filter((c) => c.series.length), [points, urlOff, devOff, colorOf]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => { const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); setter(n); };

  if (reports.length === 0) return <section id="history"><h2 className="sec">Progress over time</h2><p className="muted">Run your first report. Its results, and every later report, will be charted here.</p></section>;
  return (
    <section id="history">
      <h2 className="sec">Progress over time <small className="muted">every tested point, from your saved reports</small></h2>
      <div className="card hist-controls" role="group" aria-label="Filter the charts">
        <div className="chips"><span className="muted small">URLs</span>{urls.map((u) => <button key={u} type="button" className="fchip" aria-pressed={!urlOff.has(u)} onClick={() => toggle(urlOff, setUrlOff, u)}>{shortUrl(u)}</button>)}</div>
        <div className="chips"><span className="muted small">Devices</span>{(["mobile", "desktop"] as const).map((d) => <button key={d} type="button" className="fchip" aria-pressed={!devOff.has(d)} onClick={() => toggle(devOff, setDevOff, d)}>{DEVICE_LABEL[d]}</button>)}<span className="muted small">Solid line = mobile, dashed = desktop. Click a point to open that report.</span></div>
      </div>
      {reports.length === 1 && <p className="muted small">Only one report so far: run more reports over time to see a trend.</p>}
      {charts.length === 0 && <p className="muted">Nothing to chart with the current filters.</p>}
      <div className="charts">
        {charts.map(({ spec, series }) => (
          <article className="card chart-card" key={spec.id} data-chart={spec.id}>
            <h3>{spec.title}</h3>
            <LineChart spec={spec} series={series} onOpen={open} />
            <Legend spec={spec} series={series} />
          </article>
        ))}
      </div>

      <h2 className="sec">Report history <small className="muted">saved on disk</small></h2>
      <ul className="hlist">
        {reports.slice(0, shown).map((r) => (
          <li key={r.folder} className="card hrow">
            <div className="hmain">
              <strong>{r.title}</strong> <span className="muted small">{new Date(r.at).toLocaleString()}</span>
              <div className="chips">
                {r.tools.lighthouse > 0 && <span className="chip">Lighthouse ×{r.tools.lighthouse}</span>}
                {r.tools.browser > 0 && <span className="chip">Browser ×{r.tools.browser}</span>}
                {r.tools.audit > 0 && <span className="chip">Audit ×{r.tools.audit}</span>}
                {r.tools.comparisons > 0 && <span className="chip">Comparison ×{r.tools.comparisons}</span>}
                {r.failures > 0 && <span className="chip warnchip">{r.failures} failed step(s)</span>}
              </div>
              <div className="chips">{r.urls.slice(0, 3).map((u) => <span key={u} className="chip url">{shortUrl(u)}</span>)}{r.urls.length > 3 && <span className="chip">+{r.urls.length - 3} more</span>}</div>
              {r.headline.length > 0 && <div className="chips">{r.headline.map((h) => <span key={`${h.url}${h.device}`} className={`score s-${h.performance === null ? "na" : h.performance >= 90 ? "good" : h.performance >= 50 ? "mid" : "bad"}`} title={`${shortUrl(h.url)} · ${DEVICE_LABEL[h.device]}`}>{DEVICE_LABEL[h.device][0]} {h.performance === null ? "–" : Math.round(h.performance)}</span>)}</div>}
            </div>
            <div className="hactions">
              <a className="btn primary" href={`${base}${r.reportUrl}`} target="_blank" rel="noopener">View details ↗</a>
              <span className="exports" role="group" aria-label="Export this report">
                <a className="btn ghost" href={`${base}/reports/${r.folder}/export/json`} download>JSON</a>
                <a className="btn ghost" href={`${base}/reports/${r.folder}/export/xlsx`} download>.xlsx</a>
                <a className="btn ghost" href={`${base}/reports/${r.folder}/export/html`} download>HTML</a>
              </span>
              <button type="button" className="btn ghost" onClick={() => onBaseline(r.folder)}>Use as baseline</button>
            </div>
          </li>
        ))}
      </ul>
      {reports.length > shown && <button type="button" className="btn ghost" onClick={() => setShown(shown + 10)}>Show {Math.min(10, reports.length - shown)} more</button>}
    </section>
  );
}
