import type { BrowserMeasurement, ComparisonResult, Finding, LighthouseMeasurement, PageAudit } from "../../contracts/src/types.js";
import { fixesForDifference, fixesForRule, type Fix } from "./fixes.js";

export interface ReportInput {
  title?: string;
  generatedAt?: string;
  audits: PageAudit[];
  comparisons: ComparisonResult[];
  measurements: BrowserMeasurement[];
  /** `reportFiles` are relative links to Lighthouse's own standalone HTML reports, one per run. */
  lighthouse: Array<{ measurement: LighthouseMeasurement; reportFiles: string[] }>;
  failures?: string[];
}

/** Every string that came from a website or an API caller goes through this. */
export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

function code(fix: Fix): string {
  return `<details class="fix"><summary>${esc(fix.title)}</summary>
<div class="code"><div class="code-bar"><span>${esc(fix.language)}</span><button type="button" class="copy" aria-label="Copy code to clipboard">Copy</button></div><pre><code>${esc(fix.code)}</code></pre></div>
${fix.note ? `<p class="note">${esc(fix.note)}</p>` : ""}</details>`;
}
const fixes = (list: Fix[]) => (list.length ? `<div class="fixes"><h5>Example fixes <small>(generic templates, not verified against this site)</small></h5>${list.map(code).join("")}</div>` : "");
const sev = (s: string) => `<span class="sev sev-${esc(s)}">${esc(s)}</span>`;
const kv = (rows: Array<[string, unknown]>) => `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v === null || v === undefined || v === "" ? '<em class="muted">none</em>' : esc(v)}</td></tr>`).join("")}</table>`;

function finding(f: Finding): string {
  const ev = f.evidence.length ? `<ul class="evidence">${f.evidence.map((e) => `<li><b>${esc(e.description)}</b>${e.value !== undefined && e.value !== null ? `: <code>${esc(e.value)}</code>` : ""}</li>`).join("")}</ul>` : "";
  return `<article class="finding"><header>${sev(f.severity)} <h4>${esc(f.title)}</h4> <span class="muted">${esc(f.ruleId)} · confidence ${esc(f.confidence)}</span></header>
<p>${esc(f.description)}</p>${ev}<p><b>Recommendation:</b> ${esc(f.recommendation)}</p>${fixes(fixesForRule(f.ruleId))}</article>`;
}

function auditSection(a: PageAudit, i: number): string {
  const sorted = [...a.findings].sort((x, y) => SEV_ORDER.indexOf(x.severity) - SEV_ORDER.indexOf(y.severity));
  return `<section class="card" id="audit-${i}"><h3>${esc(a.url)}</h3>
${kv([["HTTP status", a.statusCode], ["Final URL", a.finalUrl], ["Redirects", a.redirectChain.join(" → ")], ["Title", a.title], ["Meta description", a.metaDescription], ["Canonical", a.canonical], ["Robots", a.robots],
  ["H1", a.headings.h1.join(" | ")], ["Headings (H2 / H3)", `${a.headings.h2Count} / ${a.headings.h3Count}`], ["Images (total / missing alt / no dimensions)", `${a.images.total} / ${a.images.missingAlt} / ${a.images.missingDimensions}`],
  ["Links (internal / external)", `${a.links.internal} / ${a.links.external}`], ["Schema types", a.schemaTypes.join(", ")]])}
<h4>Findings (${sorted.length})</h4>${sorted.map(finding).join("") || '<p class="muted">No findings from the implemented checks.</p>'}
<p class="muted small">${a.limitations.map(esc).join(" ")}</p></section>`;
}

function comparisonSection(c: ComparisonResult, i: number): string {
  const sorted = [...c.differences].sort((x, y) => SEV_ORDER.indexOf(x.severity) - SEV_ORDER.indexOf(y.severity));
  const fmt = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  return `<section class="card" id="cmp-${i}"><h3>${esc(c.oldUrl)} <span class="muted">vs</span> ${esc(c.newUrl)}</h3>
<p class="muted">Old = reference, New = candidate. ${sorted.length} difference(s). Differences may be intentional; review each one.</p>
${sorted.length ? `<div class="table-wrap"><table class="diff"><thead><tr><th>Severity</th><th>Change</th><th>Old</th><th>New</th></tr></thead><tbody>${sorted.map((d) => `<tr><td>${sev(d.severity)}</td><td>${esc(d.title)}</td><td>${esc(fmt(d.oldValue))}</td><td>${esc(fmt(d.newValue))}</td></tr>`).join("")}</tbody></table></div>` : "<p>No differences detected.</p>"}
${sorted.map((d) => `<article class="finding"><header>${sev(d.severity)} <h4>${esc(d.title)}</h4></header><p><b>Recommendation:</b> ${esc(d.recommendation)}</p>${fixes(fixesForDifference(d.title))}</article>`).join("")}</section>`;
}

const gauge = (label: string, score: number | null) => {
  const s = score ?? 0, cls = score === null ? "na" : s >= 90 ? "good" : s >= 50 ? "mid" : "bad", C = 2 * Math.PI * 28;
  return `<div class="gauge ${cls}"><svg viewBox="0 0 64 64" width="72" height="72" role="img" aria-label="${esc(label)} ${score ?? "n/a"}"><circle cx="32" cy="32" r="28" class="track"/><circle cx="32" cy="32" r="28" class="arc" stroke-dasharray="${((s / 100) * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 32 32)"/><text x="32" y="38" text-anchor="middle">${score ?? "–"}</text></svg><div>${esc(label)}</div></div>`;
};

function lighthouseSection(l: { measurement: LighthouseMeasurement; reportFiles: string[] }, i: number): string {
  const m = l.measurement, s = m.summary;
  const med = (k: string) => s[k]?.median ?? null;
  const row = (label: string, k: string, unit: string) => s[k] ? `<tr><td>${label}</td><td>${s[k]!.median}${unit}</td><td>${s[k]!.min}–${s[k]!.max}${unit}</td><td>${s[k]!.samples}</td></tr>` : "";
  const opps = m.runs.find((r) => r.ok)?.opportunities ?? [];
  return `<section class="card" id="lh-${i}"><h3>Lighthouse · ${esc(m.url)} <span class="muted">(${esc(m.profile)})</span></h3>
<div class="gauges">${gauge("Performance", med("performanceScore"))}${gauge("Accessibility", med("accessibilityScore"))}${gauge("Best Practices", med("bestPracticesScore"))}${gauge("SEO", med("seoScore"))}</div>
<p class="muted">Median of ${m.runs.filter((r) => r.ok).length}/${m.runs.length} successful run(s). Lighthouse ${esc(m.metadata.lighthouseVersion)}, ${esc(m.metadata.browser)}, throttling: ${esc(m.metadata.throttlingMethod)}. Lab data, not field data.</p>
<div class="table-wrap"><table class="diff"><thead><tr><th>Metric</th><th>Median</th><th>Range</th><th>Runs</th></tr></thead><tbody>
${row("First Contentful Paint", "fcpMs", " ms")}${row("Largest Contentful Paint", "lcpMs", " ms")}${row("Total Blocking Time", "tbtMs", " ms")}${row("Cumulative Layout Shift", "cls", "")}${row("Speed Index", "speedIndexMs", " ms")}${row("Time to Interactive", "ttiMs", " ms")}</tbody></table></div>
${l.reportFiles.length ? `<p>Full Lighthouse report: ${l.reportFiles.map((f, n) => `<a href="${esc(f)}">run ${n + 1}</a>`).join(" · ")}</p>` : ""}
${opps.length ? `<h4>Top opportunities</h4>${opps.map((o) => `<article class="finding"><header><h4>${esc(o.title)}</h4> <span class="muted">${esc(o.id)} · est. savings ${o.savingsMs} ms (simulated)</span></header>${fixes(fixesForRule(o.id))}</article>`).join("")}` : ""}
${fixesForRule("lcp-image").length ? fixes(fixesForRule("lcp-image")) : ""}
<p class="muted small">${m.limitations.map(esc).join(" ")}</p></section>`;
}

function measurementSection(m: BrowserMeasurement, i: number): string {
  const row = (label: string, k: string, unit: string) => { const v = (m.summary as Record<string, { median: number; min: number; max: number; samples: number }>)[k]; return v ? `<tr><td>${label}</td><td>${v.median}${unit}</td><td>${v.min}–${v.max}${unit}</td><td>${v.samples}</td></tr>` : ""; };
  const first = m.runs.find((r) => r.ok);
  return `<section class="card" id="br-${i}"><h3>Browser measurement · ${esc(m.url)} <span class="muted">(${esc(m.profile)})</span></h3>
<p class="muted">${esc(m.status)} · ${esc(m.metadata.browser)} · viewport ${m.metadata.viewport.width}×${m.metadata.viewport.height} · no throttling · cold cache per run · lab data.</p>
<div class="table-wrap"><table class="diff"><thead><tr><th>Metric</th><th>Median</th><th>Range</th><th>Runs</th></tr></thead><tbody>
${row("TTFB", "ttfbMs", " ms")}${row("First Contentful Paint", "fcpMs", " ms")}${row("Largest Contentful Paint", "lcpMs", " ms")}${row("Cumulative Layout Shift", "cls", "")}${row("DOMContentLoaded", "domContentLoadedMs", " ms")}${row("Load", "loadMs", " ms")}${row("Transfer size", "transferBytes", " B")}</tbody></table></div>
${first?.lcpElement ? `<p><b>LCP element (measured):</b> <code>${esc(first.lcpElement.tag)}</code>${first.lcpElement.url ? ` <code>${esc(first.lcpElement.url)}</code>` : ""}</p>${fixesForRule("lcp-image").length ? fixes(fixesForRule("lcp-image")) : ""}` : ""}
${first?.slowestResources.length ? `<h4>Slowest resources</h4><div class="table-wrap"><table class="diff"><tbody>${first.slowestResources.map((r) => `<tr><td>${esc(r.type)}</td><td>${esc(r.url)}</td><td>${r.durationMs} ms</td><td>${r.transferBytes} B</td></tr>`).join("")}</tbody></table></div>` : ""}
<p class="muted small">${m.limitations.map(esc).join(" ")}</p></section>`;
}

const CSS = `:root{--bg:#fff;--fg:#212529;--muted:#6c757d;--card:#f8f9fa;--line:#dee2e6;--code:#1e2227;--codefg:#e8eaed;--good:#0c6;--mid:#fa3;--bad:#f33}
@media(prefers-color-scheme:dark){:root{--bg:#16181b;--fg:#e8eaed;--muted:#9aa0a6;--card:#1f2226;--line:#3c4043}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:16px}h1{margin:.2em 0}h3{word-break:break-all}.muted{color:var(--muted)}.small{font-size:12px}
nav{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}nav a{color:inherit}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:16px 0}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}.stat b{font-size:24px;display:block}
.sev{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;color:#fff;text-transform:uppercase}.sev-critical{background:#b00020}.sev-high{background:#e8590c}.sev-medium{background:#f08c00;color:#000}.sev-low{background:#1971c2}.sev-info{background:#6c757d}
.finding{border-top:1px solid var(--line);padding-top:8px;margin-top:12px}.finding header{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.finding h4{margin:0}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}.kv th{width:34%;font-weight:600}.table-wrap{overflow-x:auto}
.code{background:var(--code);color:var(--codefg);border-radius:6px;margin:8px 0;overflow:hidden}.code-bar{display:flex;justify-content:space-between;align-items:center;padding:4px 10px;font:12px monospace;background:#2b3036;color:#aab}
.code pre{margin:0;padding:10px;overflow-x:auto;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace}.copy{font:12px system-ui;background:#3b82f6;color:#fff;border:0;border-radius:4px;padding:3px 10px;cursor:pointer}.copy:focus-visible{outline:2px solid #fff}
.fix summary{cursor:pointer;margin:6px 0}.note{font-size:13px;color:var(--muted)}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92em}
.gauges{display:flex;flex-wrap:wrap;gap:20px;margin:8px 0}.gauge{text-align:center;font-size:13px}.gauge circle{fill:none;stroke-width:5}.track{stroke:var(--line)}.gauge.good .arc{stroke:var(--good)}.gauge.mid .arc{stroke:var(--mid)}.gauge.bad .arc{stroke:var(--bad)}.gauge text{fill:var(--fg);font-size:20px;font-weight:600}
@media print{.copy{display:none}.fix:not([open]) pre{display:block}}`;

// Copy via the async clipboard API, with a textarea fallback for http:// and file:// pages.
const JS = `document.addEventListener('click',function(e){var b=e.target.closest('.copy');if(!b)return;var t=b.closest('.code').querySelector('code').textContent;
function done(ok){b.textContent=ok?'Copied!':'Copy failed';setTimeout(function(){b.textContent='Copy'},1500)}
function fb(){var a=document.createElement('textarea');a.value=t;a.style.position='fixed';a.style.opacity='0';document.body.appendChild(a);a.select();var ok=false;try{ok=document.execCommand('copy')}catch(x){}document.body.removeChild(a);done(ok)}
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(function(){done(true)},fb)}else fb()});`;

export function renderHtmlReport(input: ReportInput): string {
  const all = [...input.audits.flatMap((a) => a.findings.map((f) => f.severity)), ...input.comparisons.flatMap((c) => c.differences.map((d) => d.severity))];
  const count = (s: string) => all.filter((x) => x === s).length;
  const title = input.title ?? "WP Performance Intelligence report";
  const nav = [input.audits.length && '<a href="#audits">Audits</a>', input.comparisons.length && '<a href="#comparisons">Comparisons</a>', (input.measurements.length || input.lighthouse.length) && '<a href="#performance">Performance</a>', input.failures?.length && '<a href="#failures">Failures</a>'].filter(Boolean).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main>
<h1>${esc(title)}</h1><p class="muted">Generated ${esc(input.generatedAt ?? new Date().toISOString())}. Findings come from fetched HTML and lab measurements; example fixes are generic templates and have not been verified against your code.</p>
<div class="summary"><div class="stat"><b>${input.audits.length}</b>pages audited</div><div class="stat"><b>${input.comparisons.length}</b>comparisons</div><div class="stat"><b>${count("critical") + count("high")}</b>critical + high</div><div class="stat"><b>${count("medium")}</b>medium</div><div class="stat"><b>${count("low") + count("info")}</b>low + info</div></div>
<nav>${nav}</nav>
${input.failures?.length ? `<section class="card" id="failures"><h2>Failures</h2><ul>${input.failures.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></section>` : ""}
${input.audits.length ? `<h2 id="audits">Page audits</h2>${input.audits.map(auditSection).join("")}` : ""}
${input.comparisons.length ? `<h2 id="comparisons">Old vs new comparison</h2>${input.comparisons.map(comparisonSection).join("")}` : ""}
${input.measurements.length || input.lighthouse.length ? `<h2 id="performance">Performance (lab data)</h2>${input.lighthouse.map(lighthouseSection).join("")}${input.measurements.map(measurementSection).join("")}` : ""}
</main><script>${JS}</script></body></html>`;
}
