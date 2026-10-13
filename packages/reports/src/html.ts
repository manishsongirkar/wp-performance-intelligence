import type { BrowserMeasurement, ComparisonResult, Finding, LighthouseMeasurement, PageAudit } from "../../contracts/src/types.js";
import { isNoindex } from "../../contracts/src/robots.js";
import { exactFixes, type ExactFixGroup } from "./exact-fixes.js";
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
  /** Per-URL facts read from the page HTML, used to detect fixes that are already applied. */
  pageSignals?: Record<string, Pick<PageAudit, "preloads" | "scripts" | "stylesheets" | "imgTags" | "preconnects">>;
  /** A previous run's data.json: enables before/after deltas. */
  baseline?: { generatedAt?: string; lighthouse: Array<{ measurement: LighthouseMeasurement }>; measurements: BrowserMeasurement[] };
  /** Command shown in the "Verify" fix; the CLI fills it in with the real arguments and baseline path. */
  rerunCommand?: string;
}

/** Every string that came from a website or an API caller goes through this. */
export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const SEVS = ["critical", "high", "medium", "low", "info"] as const;
const rank = (s: string) => SEVS.indexOf(s as (typeof SEVS)[number]);

// ---------- small building blocks ----------
function code(fix: Fix): string {
  return `<details class="fix"><summary>${esc(fix.title)}</summary>
<div class="code"><div class="code-bar"><span>${esc(fix.language)}</span><button type="button" class="copy" aria-label="Copy code to clipboard">Copy</button></div><pre><code>${esc(fix.code)}</code></pre></div>
${fix.note ? `<p class="note">${esc(fix.note)}</p>` : ""}</details>`;
}
const fixes = (list: Fix[]) => (list.length ? `<div class="fixes"><h5>Example fixes <small>generic templates, not verified against this site</small></h5>${list.map(code).join("")}</div>` : "");
const sevBadge = (s: string) => `<span class="sev sev-${esc(s)}">${esc(s)}</span>`;

function findingCard(f: Finding): string {
  const ev = f.evidence.length ? `<ul class="evidence">${f.evidence.map((e) => `<li><b>${esc(e.description)}</b>${e.value !== undefined && e.value !== null ? ` <code>${esc(e.value)}</code>` : ""}</li>`).join("")}</ul>` : "";
  return `<article class="finding b-${esc(f.severity)}" data-sev="${esc(f.severity)}" data-text="${esc(`${f.title} ${f.ruleId} ${f.description}`.toLowerCase())}">
<header>${sevBadge(f.severity)}<h4>${esc(f.title)}</h4><span class="chip">${esc(f.ruleId)}</span><span class="chip">confidence: ${esc(f.confidence)}</span></header>
<p>${esc(f.description)}</p>${ev}<div class="reco"><b>Recommendation</b> ${esc(f.recommendation)}</div>${fixes(fixesForRule(f.ruleId, { pageUrl: f.url, redirectTo: f.ruleId === "http.redirect" ? String(f.evidence[f.evidence.length - 1]?.value ?? "") : undefined }))}</article>`;
}

type Tone = "ok" | "warn" | "bad" | "neutral";
const tile = (label: string, value: string, tone: Tone) => `<div class="tile t-${tone}"><span class="ico" aria-hidden="true">${{ ok: "✓", warn: "!", bad: "✕", neutral: "i" }[tone]}</span><div><small>${esc(label)}</small><b>${esc(value) || "—"}</b></div></div>`;

function signalTiles(a: PageAudit): string {
  const h1 = a.headings.h1.length, noindex = isNoindex(a.robots);
  return `<div class="tiles">${[
    tile("HTTP status", String(a.statusCode), a.statusCode < 300 ? "ok" : a.statusCode < 400 ? "warn" : "bad"),
    tile("Title", a.title ?? "missing", a.title ? "ok" : "bad"),
    tile("Meta description", a.metaDescription ?? "missing", a.metaDescription ? "ok" : "warn"),
    tile("Canonical", a.canonical ?? "missing", a.canonical ? "ok" : "warn"),
    tile("Indexable", noindex ? `No (${a.robots})` : "Yes", noindex ? "bad" : "ok"),
    tile("H1", h1 === 1 ? a.headings.h1[0]! : `${h1} found`, h1 === 1 ? "ok" : h1 === 0 ? "bad" : "warn"),
    tile("Image alt text", `${a.images.missingAlt} of ${a.images.total} missing`, a.images.missingAlt ? "warn" : "ok"),
    tile("Structured data", a.schemaTypes.join(", ") || "none", a.schemaTypes.length ? "ok" : "neutral"),
    tile("Links", `${a.links.internal} internal · ${a.links.external} external`, "neutral"),
    ...(a.redirectChain.length ? [tile("Redirects", a.redirectChain.join(" → "), "warn")] : [])
  ].join("")}</div>`;
}

function sevCounts(sevs: string[]) {
  const c = Object.fromEntries(SEVS.map((s) => [s, 0])) as Record<string, number>;
  for (const s of sevs) c[s] = (c[s] ?? 0) + 1;
  return c;
}
const miniBadges = (sevs: string[]) => { const c = sevCounts(sevs); return SEVS.filter((s) => c[s]).map((s) => `<span class="sev sev-${s}">${c[s]} ${s}</span>`).join("") || '<span class="sev sev-ok">clean</span>'; };

// ---------- sections ----------
function auditSection(a: PageAudit, i: number): string {
  const sorted = [...a.findings].sort((x, y) => rank(x.severity) - rank(y.severity));
  const code = a.statusCode;
  return `<details class="card page" id="audit-${i}" open><summary><span class="status s-${code < 300 ? "ok" : code < 400 ? "warn" : "bad"}">${code}</span><span class="url">${esc(a.url)}</span><span class="badges">${miniBadges(a.findings.map((f) => f.severity))}</span></summary>
<div class="card-body">${signalTiles(a)}<h4 class="sub">Findings <span class="muted">(${sorted.length})</span></h4>${sorted.map(findingCard).join("") || '<p class="muted">No findings from the implemented checks.</p>'}
<p class="muted small">${a.limitations.map(esc).join(" ")}</p></div></details>`;
}

function comparisonSection(c: ComparisonResult, i: number): string {
  const sorted = [...c.differences].sort((x, y) => rank(x.severity) - rank(y.severity));
  const fmt = (v: unknown) => (v === null || v === undefined ? "none" : typeof v === "string" ? v : JSON.stringify(v));
  return `<details class="card page" id="cmp-${i}" open><summary><span class="status s-neutral">⇄</span><span class="url">${esc(c.oldUrl)} <span class="muted">→</span> ${esc(c.newUrl)}</span><span class="badges">${miniBadges(c.differences.map((d) => d.severity))}</span></summary>
<div class="card-body"><p class="muted">Old is the reference and New is the candidate. Differences may be intentional; review each one.</p>
${sorted.length ? `<div class="table-wrap"><table class="diff"><thead><tr><th>Severity</th><th>Change</th><th>Old</th><th>New</th></tr></thead><tbody>${sorted.map((d) => `<tr class="finding-row" data-sev="${esc(d.severity)}" data-text="${esc(d.title.toLowerCase())}"><td>${sevBadge(d.severity)}</td><td>${esc(d.title)}</td><td><span class="old">${esc(fmt(d.oldValue))}</span></td><td><span class="new">${esc(fmt(d.newValue))}</span></td></tr>`).join("")}</tbody></table></div>` : "<p>No differences detected.</p>"}
<h4 class="sub">What to do</h4>${sorted.map((d) => `<article class="finding b-${esc(d.severity)}" data-sev="${esc(d.severity)}" data-text="${esc(d.title.toLowerCase())}"><header>${sevBadge(d.severity)}<h4>${esc(d.title)}</h4></header><div class="reco"><b>Recommendation</b> ${esc(d.recommendation)}</div>${fixes(fixesForDifference(d.title, { oldUrl: c.oldUrl, newUrl: c.newUrl, oldValue: d.oldValue, newValue: d.newValue }))}</article>`).join("")}</div></details>`;
}

// Thresholds follow web.dev "good / needs improvement" bands (lab values; Lighthouse uses the same for its colours).
const BANDS: Record<string, [number, number]> = { ttfbMs: [800, 1800], fcpMs: [1800, 3000], lcpMs: [2500, 4000], tbtMs: [200, 600], cls: [0.1, 0.25], speedIndexMs: [3400, 5800], ttiMs: [3800, 7300], domContentLoadedMs: [2000, 4000], loadMs: [3000, 6000] };
function rate(key: string, v: number): "good" | "mid" | "bad" | "na" {
  const b = BANDS[key]; if (!b) return "na";
  return v <= b[0] ? "good" : v <= b[1] ? "mid" : "bad";
}
const RATING = { good: "Good", mid: "Needs work", bad: "Poor", na: "" };
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const fmtBytes = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(2)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);

type Sum = { median: number; min: number; max: number; samples: number };
const HIGHER_BETTER = new Set(["performanceScore", "accessibilityScore", "bestPracticesScore", "seoScore"]);
/** Compares medians. Inside the old min–max range counts as noise, never as a real change. */
export function deltaInfo(key: string, cur: Sum, prev?: Sum): { cls: "good" | "bad" | "flat"; text: string } | null {
  if (!prev) return null;
  const d = cur.median - prev.median, up = HIGHER_BETTER.has(key);
  // Noise (either run set's own range) or too small to matter in practice: not a real change.
  const tiny = key === "cls" ? 0.01 : key === "transferBytes" ? 10240 : HIGHER_BETTER.has(key) ? 3 : key === "tbtMs" ? 50 : 100;
  // Noise if the new median sits inside the old runs' range, or the old median inside the new runs' range: either way the runs overlap.
  const overlaps = (cur.median >= prev.min && cur.median <= prev.max) || (prev.median >= cur.min && prev.median <= cur.max);
  if (Math.abs(d) < tiny || overlaps) return { cls: "flat", text: "≈ no clear change" };
  const better = up ? d > 0 : d < 0, abs = Math.abs(d);
  const amount = key === "cls" ? abs.toFixed(3) : up ? `${Math.round(abs)} pts` : key === "transferBytes" ? fmtBytes(abs) : fmtMs(abs);
  return { cls: better ? "good" : "bad", text: `${d > 0 ? "▲" : "▼"} ${amount} ${better ? "better" : "worse"}` };
}

function metricCard(label: string, key: string, s?: Sum, prev?: Sum): string {
  if (!s) return "";
  const r = rate(key, s.median), fmt = key === "cls" ? (n: number) => String(n) : key === "transferBytes" ? fmtBytes : fmtMs, d = deltaInfo(key, s, prev);
  return `<div class="metric m-${r}"><small>${esc(label)}</small><b>${esc(fmt(s.median))}</b><span class="range">${esc(fmt(s.min))} – ${esc(fmt(s.max))} · ${s.samples} run${s.samples > 1 ? "s" : ""}</span>${RATING[r] ? `<em>${RATING[r]}</em>` : ""}${d ? `<span class="delta d-${d.cls}" title="vs baseline median ${esc(fmt(prev!.median))}">${esc(d.text)}</span>` : ""}</div>`;
}

const gauge = (label: string, score: number | null, d?: { cls: string; text: string } | null, range?: { min: number; max: number; samples: number }) => {
  const s = score ?? 0, cls = score === null ? "na" : s >= 90 ? "good" : s >= 50 ? "mid" : "bad", C = 2 * Math.PI * 28;
  return `<div class="gauge ${cls}"><svg viewBox="0 0 64 64" width="84" height="84" role="img" aria-label="${esc(label)} score ${score ?? "not available"}"><circle cx="32" cy="32" r="28" class="track"/><circle cx="32" cy="32" r="28" class="arc" style="--len:${((s / 100) * C).toFixed(1)}" stroke-dasharray="${((s / 100) * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 32 32)"/><text x="32" y="38" text-anchor="middle">${score ?? "–"}</text></svg><div>${esc(label)}</div>${range && range.max !== range.min ? `<span class="range" title="Lowest and highest of ${range.samples} runs">${range.min}–${range.max}</span>` : ""}${d ? `<span class="delta d-${d.cls}">${esc(d.text)}</span>` : ""}</div>`;
};

const PHASE_CLS: Record<string, string> = { "TTFB": "ph1", "Load Delay": "ph2", "Load Time": "ph3", "Render Delay": "ph4" };
/** LCP phase breakdown (as in Lighthouse / PageSpeed Insights) and the measured what-if experiment. */
function lcpBreakdown(m: LighthouseMeasurement): string {
  const phases = m.runs.find((r) => r.ok)?.lcpPhases ?? [], total = phases.reduce((a, p) => a + p.ms, 0);
  const exp = m.experiments?.[0];
  if (!total && !exp) return "";
  const lcp = m.summary.lcpMs?.median;
  const observed = !!lcp && total > 0 && lcp > 1.5 * total;       // Lighthouse 13 reports the unthrottled run; its phases then add up to less than the throttled LCP
  return `<h4 class="sub">Where does the LCP time go? <small class="muted">${observed ? `phases observed in the unthrottled test (${fmtMs(total)} in total); the LCP above, ${fmtMs(lcp!)}, is simulated on a slow connection` : "LCP phases, first run"}</small></h4>
${total ? `<div class="phases" role="img" aria-label="LCP phases">${phases.map((p) => `<span class="${PHASE_CLS[p.phase] ?? "ph1"}" style="flex:${Math.max(p.ms, 1)}" title="${esc(p.phase)} ${fmtMs(p.ms)}"></span>`).join("")}</div>
<div class="legend">${phases.map((p) => `<span><i class="${PHASE_CLS[p.phase] ?? "ph1"}"></i>${esc(p.phase)} ${fmtMs(p.ms)} (${Math.round((p.ms / total) * 100)}%)</span>`).join("")}</div>` : ""}
${exp ? `<div class="reco"><b>Measured what-if</b> ${esc(exp.description)} Simulated LCP: <b>${exp.lcpMs === null ? "?" : fmtMs(exp.lcpMs)}</b> vs ${exp.baselineLcpMs === null ? "?" : fmtMs(exp.baselineLcpMs)} now${exp.performanceScore !== null && exp.baselinePerformance !== null ? `; Performance ${exp.performanceScore} vs ${exp.baselinePerformance}` : ""}.
<details class="fix"><summary>${exp.blocked.length} blocked images</summary><ul class="diag">${exp.blocked.map((u) => `<li><code>${esc(u)}</code></li>`).join("")}</ul></details></div>` : ""}`;
}

function diagnosticsBlock(m: LighthouseMeasurement): string {
  const run = m.runs.find((r) => r.ok), d = run?.diagnostics ?? [];
  if (!d.length && run?.passedAudits === undefined) return "";
  return `<h4 class="sub">Diagnostics <small class="muted">as in PageSpeed Insights${run?.passedAudits !== undefined ? ` · ${run.passedAudits} passed audits` : ""}</small></h4>
${d.length ? `<ul class="diag">${d.map((x) => `<li><span class="dot ${x.score !== null && x.score < 0.5 ? "bad" : "mid"}"></span><b>${esc(x.title)}</b>${x.displayValue ? ` <span class="muted">— ${esc(x.displayValue)}</span>` : ""} <span class="chip">${esc(x.id)}</span></li>`).join("")}</ul>` : '<p class="muted small">No failing diagnostics.</p>'}`;
}

/** A generic template is shown for an opportunity only when no exact group already speaks to it (an exact group may rightly say "already applied"). */
const COVERED: Record<string, RegExp> = {
  "modern-image-formats": /^Images/, "uses-optimized-images": /^Images/, "uses-responsive-images": /^Images/, "offscreen-images": /^Images/,
  "render-blocking-resources": /^FCP/, "server-response-time": /^FCP/, "unused-css-rules": /^Unused CSS/, "unused-javascript": /^Unused JavaScript/, "prioritize-lcp-image": /^LCP/
};
const coveredByExact = (id: string, groups: ExactFixGroup[]) => { const re = COVERED[id]; return !!re && groups.some((g) => re.test(g.area)); };

/** Why a local Lighthouse score can differ from pagespeed.web.dev, shown with this run's own numbers. */
export function spreadNote(m: LighthouseMeasurement): string {
  const p = m.summary.performanceScore, spread = p ? p.max - p.min : 0, bench = m.metadata.benchmarkIndex;
  const warn = p && p.samples > 1 && spread >= 10
    ? `<div class="reco warnbox"><b>Scores vary between runs</b> Performance ranged from ${p.min} to ${p.max} over ${p.samples} runs (median ${p.median}). PageSpeed Insights tests once, so its score can land anywhere in a range like this. Judge changes by the median of several runs, not one run.</div>` : "";
  const fast = bench && bench > 2000 ? ` This machine's CPU benchmark is ${bench}; PageSpeed Insights' servers typically score about 500–900, so JavaScript-heavy pages usually look better here than on PageSpeed.` : bench ? ` This machine's CPU benchmark is ${bench} (PageSpeed Insights' servers typically score about 500–900).` : "";
  return `${warn}<details class="why-psi"><summary>Why can this differ from pagespeed.web.dev?</summary><ul>
<li><b>Same engine and conditions:</b> Lighthouse ${esc(m.metadata.lighthouseVersion)}, ${esc(m.profile)} emulation with simulated throttling, as PageSpeed Insights uses.</li>
<li><b>One run vs a median:</b> PageSpeed Insights runs the test once; this report uses the median of ${m.runs.filter((r) => r.ok).length} run(s).</li>
<li><b>Different machine and network:</b> PageSpeed Insights tests from Google's data centres, so the distance to your server and its response time differ.${fast}</li>
<li><b>Lighthouse version:</b> a different version can score the same page differently; PageSpeed Insights updates its version regularly.</li>
<li><b>Caches and variance:</b> CDN or page-cache state and server load change from minute to minute. Typical differences are 5–10 points; compare medians over time rather than single numbers.</li></ul></details>`;
}

function exactBlock(groups: ExactFixGroup[]): string {
  if (!groups.length) return "";
  return `<div class="exact"><h4 class="sub">Exact fixes for this page <small class="muted">generated from the measured evidence above; untested until you apply them and re-run</small></h4>
${groups.map((g) => `<details class="exact-group" open><summary><span class="area">${esc(g.area)}</span><span class="measured">${esc(g.measured)}</span></summary>${g.applied?.length ? `<ul class="applied">${g.applied.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}${g.note ? `<p class="note">${esc(g.note)}</p>` : ""}${g.fixes.map(code).join("")}</details>`).join("")}</div>`;
}

/** Facts read from the page HTML, from the HTML audit if it ran, else from the background page fetch. */
function pageFacts(input: ReportInput, url: string) {
  const f = input.audits.find((a) => a.url === url) ?? input.pageSignals?.[url];
  return { preloads: f?.preloads, scripts: f?.scripts, stylesheets: f?.stylesheets, imgTags: f?.imgTags, preconnects: f?.preconnects };
}

function lighthouseSection(l: { measurement: LighthouseMeasurement; reportFiles: string[] }, i: number, input: ReportInput): string {
  const m = l.measurement, s = m.summary, med = (k: string) => s[k]?.median ?? null;
  const prev = input.baseline?.lighthouse.find((b) => b.measurement.url === m.url && b.measurement.profile === m.profile)?.measurement.summary;
  const dl = (k: string) => (s[k] ? deltaInfo(k, s[k]!, prev?.[k]) : null);
  const opps = m.runs.find((r) => r.ok)?.opportunities ?? [], max = Math.max(1, ...opps.map((o) => o.savingsMs));
  const br = input.measurements.find((x) => x.url === m.url && x.profile === m.profile);
  const exact = exactFixes({
    pageUrl: m.url, ...pageFacts(input, m.url), lcpPhases: m.runs.find((r) => r.ok)?.lcpPhases, lcpDiscovery: m.runs.find((r) => r.ok)?.lcpDiscovery, networkTree: m.runs.find((r) => r.ok)?.networkTree, experiments: m.experiments, viewportWidth: m.metadata.settings?.screenWidth, evidence: m.runs.find((r) => r.ok)?.evidence ?? {}, rerunCommand: input.rerunCommand,
    metrics: { lcpMs: s.lcpMs?.median, fcpMs: s.fcpMs?.median, tbtMs: s.tbtMs?.median, cls: s.cls?.median, ttfbMs: br?.summary.ttfbMs?.median },
    lcpElement: br?.runs.find((r) => r.ok)?.lcpElement
  });
  return `<details class="card page" id="lh-${i}" open><summary><span class="status s-neutral">LH</span><span class="url">${esc(m.url)}</span><span class="badges"><span class="chip">${esc(m.profile)}</span></span></summary><div class="card-body">
<div class="gauges">${gauge("Performance", med("performanceScore"), dl("performanceScore"), s.performanceScore)}${gauge("Accessibility", med("accessibilityScore"), dl("accessibilityScore"), s.accessibilityScore)}${gauge("Best Practices", med("bestPracticesScore"), dl("bestPracticesScore"), s.bestPracticesScore)}${gauge("SEO", med("seoScore"), dl("seoScore"), s.seoScore)}</div>
${spreadNote(m)}
<div class="metrics">${metricCard("First Contentful Paint", "fcpMs", s.fcpMs, prev?.fcpMs)}${metricCard("Largest Contentful Paint", "lcpMs", s.lcpMs, prev?.lcpMs)}${metricCard("Total Blocking Time", "tbtMs", s.tbtMs, prev?.tbtMs)}${metricCard("Cumulative Layout Shift", "cls", s.cls, prev?.cls)}${metricCard("Speed Index", "speedIndexMs", s.speedIndexMs, prev?.speedIndexMs)}</div>
<p class="muted small">Median of ${m.runs.filter((r) => r.ok).length}/${m.runs.length} successful run(s). Lighthouse ${esc(m.metadata.lighthouseVersion)}, ${esc(m.metadata.browser)}, throttling: ${esc(m.metadata.throttlingMethod)}${m.metadata.settings ? ` (RTT ${m.metadata.settings.rttMs ?? "?"} ms, ${m.metadata.settings.throughputKbps ?? "?"} Kbps, CPU ${m.metadata.settings.cpuSlowdownMultiplier ?? "?"}× slower, screen ${m.metadata.settings.screenWidth ?? "?"}×${m.metadata.settings.screenHeight ?? "?"})` : ""} — the same conditions PageSpeed Insights uses for its ${esc(m.profile)} lab test. Lab data, not field data.${prev ? " Deltas compare medians with the baseline; changes inside the baseline's min–max range are treated as noise." : ""}</p>
${l.reportFiles.length ? `<p class="links">Full Lighthouse report: ${l.reportFiles.map((f, n) => `<a class="btn" href="${esc(f)}">Run ${n + 1} ↗</a>`).join(" ")}</p>` : ""}
${lcpBreakdown(m)}
${diagnosticsBlock(m)}
${exactBlock(exact)}
${opps.length ? `<h4 class="sub">Lighthouse opportunities</h4>${opps.map((o) => `<article class="finding b-medium" data-sev="medium" data-text="${esc(`${o.title} ${o.id}`.toLowerCase())}"><header><h4>${esc(o.title)}</h4><span class="chip">${esc(o.id)}</span></header><div class="savings"><span style="width:${Math.round((o.savingsMs / max) * 100)}%"></span><em>est. ${fmtMs(o.savingsMs)} saved (simulated)</em></div>${fixes(coveredByExact(o.id, exact) ? [] : fixesForRule(o.id, { pageUrl: m.url }))}</article>`).join("")}` : ""}
<p class="muted small">${m.limitations.map(esc).join(" ")}</p></div></details>`;
}

/** LCP image status for the browser section: same state-aware logic as the Lighthouse section, never a generic template. */
function lcpStatusForBrowser(m: BrowserMeasurement, first: BrowserMeasurement["runs"][number] | undefined, input: ReportInput): string {
  const lh = input.lighthouse.find((l) => l.measurement.url === m.url && l.measurement.profile === m.profile)?.measurement;
  const run = lh?.runs.find((r) => r.ok);
  const group = exactFixes({
    pageUrl: m.url, ...pageFacts(input, m.url), evidence: run?.evidence ?? {}, lcpPhases: run?.lcpPhases, lcpDiscovery: run?.lcpDiscovery, experiments: lh?.experiments,
    viewportWidth: lh?.metadata.settings?.screenWidth ?? m.metadata.viewport.width, metrics: { lcpMs: m.summary.lcpMs?.median }, lcpElement: first?.lcpElement
  }).find((g) => g.area.startsWith("LCP"));
  if (!group) return "";
  if (lh) return `${group.applied?.length ? `<ul class="applied">${group.applied.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}${group.fixes.length ? '<p class="muted small">Fixes for the LCP image are listed under “Exact fixes” in the Lighthouse section above.</p>' : ""}`;
  return exactBlock([group]);
}

function measurementSection(m: BrowserMeasurement, i: number, input: ReportInput): string {
  const s = m.summary, p = input.baseline?.measurements.find((b) => b.url === m.url && b.profile === m.profile)?.summary ?? {}, first = m.runs.find((r) => r.ok), slow = first?.slowestResources ?? [], max = Math.max(1, ...slow.map((r) => r.durationMs));
  return `<details class="card page" id="br-${i}" open><summary><span class="status s-neutral">BR</span><span class="url">${esc(m.url)}</span><span class="badges"><span class="chip">${esc(m.profile)}</span><span class="chip">${esc(m.status)}</span></span></summary><div class="card-body">
<p class="muted small">${esc(m.metadata.browser)} · viewport ${m.metadata.viewport.width}×${m.metadata.viewport.height} · no throttling · cold cache per run · lab data.</p>
<div class="metrics">${metricCard("TTFB", "ttfbMs", s.ttfbMs, p.ttfbMs)}${metricCard("First Contentful Paint", "fcpMs", s.fcpMs, p.fcpMs)}${metricCard("Largest Contentful Paint", "lcpMs", s.lcpMs, p.lcpMs)}${metricCard("Cumulative Layout Shift", "cls", s.cls, p.cls)}${metricCard("DOMContentLoaded", "domContentLoadedMs", s.domContentLoadedMs, p.domContentLoadedMs)}${metricCard("Load", "loadMs", s.loadMs, p.loadMs)}${metricCard("Transfer size", "transferBytes", s.transferBytes, p.transferBytes)}</div>
${first?.lcpElement ? `<div class="reco"><b>LCP element (measured)</b> <code>${esc(first.lcpElement.tag)}</code>${first.lcpElement.url ? ` <code>${esc(first.lcpElement.url)}</code>` : ""}</div>${lcpStatusForBrowser(m, first, input)}` : ""}
${slow.length ? `<h4 class="sub">Slowest resources</h4><div class="bars">${slow.map((r) => `<div class="bar-row"><span class="bar-label"><span class="chip">${esc(r.type)}</span> ${esc(r.url)}</span><span class="bar"><span style="width:${Math.max(3, Math.round((r.durationMs / max) * 100))}%"></span></span><span class="bar-val">${r.durationMs} ms · ${fmtBytes(r.transferBytes)}</span></div>`).join("")}</div>` : ""}
<p class="muted small">${m.limitations.map(esc).join(" ")}</p></div></details>`;
}

// ---------- page chrome ----------
const LIGHT = "--bg:#f4f6fb;--fg:#1b2333;--muted:#64708a;--card:#fff;--line:#e3e8f2;--soft:#eef2fb;--brand:#4f46e5;--brand2:#06b6d4;--code:#161b26;--codefg:#e6e9f2;--shadow:0 1px 3px rgba(20,30,60,.08),0 6px 18px rgba(20,30,60,.05)";
const DARK = "--bg:#0f131c;--fg:#e6e9f2;--muted:#97a1b8;--card:#171c28;--line:#2a3142;--soft:#1e2433;--brand:#818cf8;--brand2:#22d3ee;--code:#0b0e15;--codefg:#e6e9f2;--shadow:0 1px 3px rgba(0,0,0,.4)";
const CSS = `:root{${LIGHT};--good:#0cce6b;--mid:#ffa400;--bad:#ff4e42;--c-critical:#b91c1c;--c-high:#ea580c;--c-medium:#d97706;--c-low:#2563eb;--c-info:#64748b}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}:root[data-theme=dark]{${DARK}}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:120px}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--brand)}main{max-width:1080px;margin:0 auto;padding:0 16px 48px}.muted{color:var(--muted)}.small{font-size:12px}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9em;background:var(--soft);padding:1px 5px;border-radius:4px;word-break:break-all}
.hero{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;padding:34px 16px 70px}.hero-in{max-width:1080px;margin:0 auto}.hero h1{margin:0 0 4px;font-size:clamp(22px,4vw,32px)}.hero p{margin:0;opacity:.9;max-width:760px}.hero .eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.85}
.bar-top{position:sticky;top:0;z-index:20;background:var(--card);border-bottom:1px solid var(--line);box-shadow:var(--shadow)}.bar-in{max-width:1080px;margin:0 auto;padding:8px 16px;display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.bar-in nav{display:flex;flex-wrap:wrap;gap:4px;flex:1}.bar-in nav a{text-decoration:none;color:var(--fg);padding:5px 12px;border-radius:16px;font-size:14px}.bar-in nav a:hover{background:var(--soft)}.bar-in nav a.active{background:var(--brand);color:#fff}
.icon-btn{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:5px 10px;cursor:pointer;font:inherit;font-size:13px}.icon-btn:hover{background:var(--soft)}
.toolbar{max-width:1080px;margin:0 auto;padding:0 16px 8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}.toolbar input{flex:1 1 200px;min-width:0;padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit;font-size:14px}
.fchip{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:16px;padding:3px 11px;font-size:13px;cursor:pointer}.fchip[aria-pressed=true]{background:var(--brand);border-color:var(--brand);color:#fff}.fchip i{font-style:normal;opacity:.75;margin-left:4px}
.dash{margin-top:-46px;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stat{background:var(--card);border-radius:12px;padding:14px 16px;box-shadow:var(--shadow);border-top:4px solid var(--brand)}.stat b{display:block;font-size:28px;line-height:1.1}.stat.s-crit{border-color:var(--c-critical)}.stat.s-med{border-color:var(--c-medium)}.stat.s-low{border-color:var(--c-low)}.stat span{color:var(--muted);font-size:13px}
.panel{background:var(--card);border-radius:12px;padding:16px;margin:16px 0;box-shadow:var(--shadow)}.panel h2,h2.sec{margin:0 0 10px;font-size:18px}h2.sec{margin:32px 0 8px}
.sevbar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--soft)}.sevbar span{display:block;min-width:4px}.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;font-size:13px}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px}
.top-issues{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.issue{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:10px;padding:6px 10px;font-size:13px;cursor:pointer;display:flex;gap:8px;align-items:center}.issue:hover{border-color:var(--brand)}
.bg-critical{background:var(--c-critical)}.bg-high{background:var(--c-high)}.bg-medium{background:var(--c-medium)}.bg-low{background:var(--c-low)}.bg-info{background:var(--c-info)}
.sev{display:inline-block;padding:1px 9px;border-radius:10px;font-size:11px;font-weight:700;color:#fff;text-transform:uppercase;letter-spacing:.03em;white-space:nowrap}.sev-critical{background:var(--c-critical)}.sev-high{background:var(--c-high)}.sev-medium{background:var(--c-medium)}.sev-low{background:var(--c-low)}.sev-info{background:var(--c-info)}.sev-ok{background:var(--good);color:#04371c}
.chip{display:inline-block;background:var(--soft);color:var(--muted);border-radius:10px;padding:1px 9px;font-size:12px}
.card{background:var(--card);border-radius:12px;margin:14px 0;box-shadow:var(--shadow);overflow:hidden}.card>summary{list-style:none;cursor:pointer;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:14px 16px}.card>summary::-webkit-details-marker{display:none}.card>summary::after{content:"▾";margin-left:auto;color:var(--muted);transition:transform .2s}.card:not([open])>summary::after{transform:rotate(-90deg)}
.card .url{font-weight:600;word-break:break-all;flex:1 1 260px}.badges{display:flex;gap:6px;flex-wrap:wrap}.card-body{padding:4px 16px 16px;border-top:1px solid var(--line)}.sub{margin:18px 0 6px;font-size:15px}
.status{min-width:42px;text-align:center;border-radius:8px;padding:2px 8px;font-weight:700;font-size:13px;color:#fff}.s-ok{background:var(--good);color:#04371c}.s-warn{background:var(--mid);color:#3a2800}.s-bad{background:var(--bad)}.s-neutral{background:var(--brand)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;margin-top:12px}.tile{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;background:var(--soft);border-left:4px solid var(--c-info)}.tile small{display:block;color:var(--muted);font-size:12px}.tile b{font-weight:600;word-break:break-word;font-size:14px}
.tile .ico{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:12px;font-weight:700;background:var(--c-info)}.t-ok{border-color:var(--good)}.t-ok .ico{background:var(--good);color:#04371c}.t-warn{border-color:var(--mid)}.t-warn .ico{background:var(--mid);color:#3a2800}.t-bad{border-color:var(--bad)}.t-bad .ico{background:var(--bad)}
.finding{border:1px solid var(--line);border-left:5px solid var(--c-info);border-radius:10px;padding:12px 14px;margin:10px 0;background:var(--card)}.b-critical{border-left-color:var(--c-critical)}.b-high{border-left-color:var(--c-high)}.b-medium{border-left-color:var(--c-medium)}.b-low{border-left-color:var(--c-low)}
.finding header{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.finding h4{margin:0;font-size:15px}.finding p{margin:8px 0}.evidence{margin:6px 0;padding-left:18px;font-size:13px;color:var(--muted)}
.reco{background:var(--soft);border-radius:8px;padding:8px 12px;margin:8px 0;font-size:14px}.reco b{display:inline-block;margin-right:6px;color:var(--brand)}
.fixes h5{margin:12px 0 4px;font-size:13px}.fixes h5 small{font-weight:400;color:var(--muted);margin-left:6px}.fix{border:1px solid var(--line);border-radius:8px;margin:6px 0;padding:0 10px}.fix summary{cursor:pointer;padding:8px 0;font-size:14px}.fix[open]{background:var(--soft)}.fix .note{font-size:13px;color:var(--muted);margin:6px 0 10px}
.code{background:var(--code);color:var(--codefg);border-radius:8px;margin:6px 0;overflow:hidden}.code-bar{display:flex;justify-content:space-between;align-items:center;padding:4px 10px;font:12px ui-monospace,monospace;background:rgba(255,255,255,.07);color:#aab4cc;text-transform:uppercase}
.code pre{margin:0;padding:12px;overflow-x:auto;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}.code code{background:none;padding:0;word-break:normal}.copy{font:12px system-ui;background:var(--brand);color:#fff;border:0;border-radius:6px;padding:4px 12px;cursor:pointer}.copy:hover{filter:brightness(1.1)}.copy.done{background:var(--good);color:#04371c}.copy:focus-visible,.fchip:focus-visible,.icon-btn:focus-visible,.issue:focus-visible{outline:2px solid var(--brand2);outline-offset:2px}
.gauges{display:flex;flex-wrap:wrap;gap:22px;margin:14px 0}.gauge{text-align:center;font-size:13px;font-weight:600}.gauge circle{fill:none;stroke-width:5;stroke-linecap:round}.gauge .track{stroke:var(--line)}.gauge.good .arc{stroke:var(--good)}.gauge.mid .arc{stroke:var(--mid)}.gauge.bad .arc{stroke:var(--bad)}.gauge text{fill:var(--fg);font-size:20px;font-weight:700}.gauge .arc{animation:draw .9s ease-out}@keyframes draw{from{stroke-dasharray:0 200}}
.metrics{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}.metric{background:var(--soft);border-radius:10px;padding:10px 12px;border-top:4px solid var(--c-info);position:relative}.metric small{color:var(--muted);font-size:12px;display:block}.metric b{font-size:21px;display:block}.metric .range{font-size:11px;color:var(--muted)}.metric em{position:absolute;top:8px;right:10px;font-style:normal;font-size:11px;font-weight:700}
.m-good{border-color:var(--good)}.m-good em{color:var(--good)}.m-mid{border-color:var(--mid)}.m-mid em{color:var(--mid)}.m-bad{border-color:var(--bad)}.m-bad em{color:var(--bad)}
.savings{position:relative;background:var(--soft);border-radius:6px;height:22px;margin:8px 0;overflow:hidden}.savings span{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,var(--brand),var(--brand2));opacity:.55}.savings em{position:relative;font-style:normal;font-size:12px;padding:0 8px;line-height:22px}
.bars{display:grid;gap:8px}.bar-row{display:grid;grid-template-columns:minmax(0,2fr) minmax(80px,1fr) auto;gap:10px;align-items:center;font-size:13px}.bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar{background:var(--soft);border-radius:5px;height:10px;overflow:hidden}.bar span{display:block;height:100%;background:linear-gradient(90deg,var(--brand),var(--brand2))}.bar-val{color:var(--muted);white-space:nowrap}
.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;word-break:break-word}th{font-size:12px;text-transform:uppercase;color:var(--muted);letter-spacing:.04em}.old{background:rgba(255,78,66,.14);padding:1px 6px;border-radius:5px}.new{background:rgba(12,206,107,.16);padding:1px 6px;border-radius:5px}
.btn{display:inline-block;text-decoration:none;background:var(--brand);color:#fff;border-radius:8px;padding:5px 12px;font-size:13px;margin-right:6px}.btn:hover{filter:brightness(1.1)}
.fail{border-left:5px solid var(--bad)}.hidden{display:none!important}.empty{display:none;text-align:center;color:var(--muted);padding:24px}.toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%) translateY(20px);background:#111827;color:#fff;padding:8px 16px;border-radius:20px;font-size:13px;opacity:0;transition:.25s;pointer-events:none;z-index:50}.toast.show{opacity:1;transform:translateX(-50%)}
.delta{display:inline-block;margin-top:4px;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700}.d-good{background:rgba(12,206,107,.18);color:#0a7d42}.d-bad{background:rgba(255,78,66,.18);color:#c0392b}.d-flat{background:var(--soft);color:var(--muted)}
.exact{margin-top:8px}.exact-group{border:1px solid var(--line);border-left:5px solid var(--brand);border-radius:10px;margin:10px 0;padding:0 12px 6px;background:var(--card)}.exact-group>summary{cursor:pointer;padding:10px 0;display:flex;flex-wrap:wrap;gap:4px 12px;align-items:baseline}.area{font-weight:700}.measured{color:var(--muted);font-size:13px}
.applied{list-style:none;margin:6px 0;padding:0;display:flex;flex-wrap:wrap;gap:6px}.applied li{background:rgba(12,206,107,.16);color:#0a7d42;border-radius:12px;padding:2px 10px;font-size:12px;font-weight:600}.applied li::before{content:"✓ "}
.range{display:block;font-size:11px;color:var(--muted);font-weight:400}.warnbox{border-left:4px solid var(--mid)}.why-psi{margin:10px 0;font-size:13px}.why-psi summary{cursor:pointer;color:var(--brand)}.why-psi ul{margin:6px 0 0 18px;padding:0}.why-psi li{margin:3px 0}
.diag{list-style:none;margin:6px 0;padding:0}.diag li{padding:5px 0;border-bottom:1px solid var(--line);font-size:14px}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:var(--mid)}.dot.bad{background:var(--bad)}
.phases{display:flex;height:16px;border-radius:8px;overflow:hidden;background:var(--soft)}.phases span{display:block;min-width:3px}.ph1{background:#6366f1}.ph2{background:#f59e0b}.ph3{background:#10b981}.ph4{background:#ec4899}.legend i.ph1,.legend i.ph2,.legend i.ph3,.legend i.ph4{display:inline-block}
footer{color:var(--muted);font-size:12px;text-align:center;padding:24px 0}
@media(max-width:640px){.bar-row{grid-template-columns:1fr}.bar{display:none}.gauges{justify-content:space-around}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media print{.bar-top,.toolbar,.copy,.icon-btn{display:none}.hero{background:#fff;color:#000;padding:0}body{background:#fff}.card{box-shadow:none;border:1px solid #ccc}}`;

// Copy via the async clipboard API, with a textarea fallback for http:// and file:// pages.
const JS = `(function(){var D=document,R=D.documentElement,$=function(s,e){return Array.prototype.slice.call((e||D).querySelectorAll(s))};
var toast=D.getElementById('toast');function say(t){toast.textContent=t;toast.classList.add('show');clearTimeout(say.t);say.t=setTimeout(function(){toast.classList.remove('show')},1600)}
try{var th=localStorage.getItem('wpi-theme');if(th)R.setAttribute('data-theme',th)}catch(e){}
D.getElementById('theme').addEventListener('click',function(){var cur=R.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'),n=cur==='dark'?'light':'dark';R.setAttribute('data-theme',n);try{localStorage.setItem('wpi-theme',n)}catch(e){}});
D.addEventListener('click',function(e){var b=e.target.closest('.copy');if(!b)return;var t=b.closest('.code').querySelector('code').textContent;
function done(ok){b.textContent=ok?'Copied!':'Copy failed';b.classList.toggle('done',ok);say(ok?'Copied to clipboard':'Copy failed');setTimeout(function(){b.textContent='Copy';b.classList.remove('done')},1500)}
function fb(){var a=D.createElement('textarea');a.value=t;a.style.position='fixed';a.style.opacity='0';D.body.appendChild(a);a.select();var ok=false;try{ok=D.execCommand('copy')}catch(x){}D.body.removeChild(a);done(ok)}
if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t).then(function(){done(true)},fb)}else fb()});
var chips=$('.fchip[data-sev]'),q=D.getElementById('q'),count=D.getElementById('count'),none=D.getElementById('none'),active={};
function reset(){chips.forEach(function(c){active[c.dataset.sev]=true;c.setAttribute('aria-pressed','true')})}reset();
function apply(){var term=q.value.trim().toLowerCase(),shown=0,all=0;$('[data-sev][data-text]').forEach(function(el){var ok=active[el.dataset.sev]&&(!term||el.dataset.text.indexOf(term)>-1);el.classList.toggle('hidden',!ok);all++;if(ok)shown++});
if(count)count.textContent='Showing '+shown+' of '+all+' items';if(none)none.style.display=(all&&!shown)?'block':'none'}
chips.forEach(function(c){c.addEventListener('click',function(){var s=c.dataset.sev,solo=chips.every(function(x){return x.dataset.sev===s?active[s]:!active[x.dataset.sev]});
if(solo){reset()}else{chips.forEach(function(x){active[x.dataset.sev]=x.dataset.sev===s;x.setAttribute('aria-pressed',String(x.dataset.sev===s))})}apply()})});
q.addEventListener('input',apply);
D.getElementById('reset').addEventListener('click',function(){reset();q.value='';apply()});
$('[data-rule]').forEach(function(b){b.addEventListener('click',function(){q.value=b.dataset.rule;apply();q.scrollIntoView({block:'center'})})});
function fixes(open){$('details.fix').forEach(function(d){d.open=open})}
D.getElementById('expand').addEventListener('click',function(){fixes(true)});D.getElementById('collapse').addEventListener('click',function(){fixes(false)});
var links=$('.bar-in nav a'),secs=$('[data-spy]');if('IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting)links.forEach(function(a){a.classList.toggle('active',a.getAttribute('href')==='#'+en.target.id)})})},{rootMargin:'-30% 0px -60% 0px'});secs.forEach(function(s){io.observe(s)})}
})();`;

function baselinePanel(input: ReportInput): string {
  const base = input.baseline;
  if (!base) return "";
  let good = 0, bad = 0, flat = 0;
  for (const l of input.lighthouse) {
    const prev = base.lighthouse.find((b) => b.measurement.url === l.measurement.url && b.measurement.profile === l.measurement.profile)?.measurement.summary;
    for (const [k, v] of Object.entries(l.measurement.summary)) { const d = deltaInfo(k, v, prev?.[k]); if (d) d.cls === "good" ? good++ : d.cls === "bad" ? bad++ : flat++; }
  }
  return `<div class="panel"><h2>Compared with previous run${base.generatedAt ? ` <span class="muted small">${esc(base.generatedAt)}</span>` : ""}</h2><div class="legend"><span class="delta d-good">${good} metrics better</span><span class="delta d-bad">${bad} worse</span><span class="delta d-flat">${flat} within noise</span></div>
<p class="muted small">Based on medians; a change smaller than the baseline's own run-to-run range is not counted as real.</p></div>`;
}

export function renderHtmlReport(input: ReportInput): string {
  const sevs = [...input.audits.flatMap((a) => a.findings.map((f) => f.severity)), ...input.comparisons.flatMap((c) => c.differences.map((d) => d.severity))];
  const counts = sevCounts(sevs), total = sevs.length;
  const title = input.title ?? "WP Performance Intelligence report";
  const byRule = new Map<string, { title: string; severity: string; n: number }>();
  for (const f of input.audits.flatMap((a) => a.findings)) { const e = byRule.get(f.ruleId); if (e) e.n++; else byRule.set(f.ruleId, { title: f.title, severity: f.severity, n: 1 }); }
  const top = [...byRule.entries()].sort((a, b) => rank(a[1].severity) - rank(b[1].severity) || b[1].n - a[1].n).slice(0, 8);
  const hasPerf = input.measurements.length || input.lighthouse.length;
  const nav = [['overview', "Overview", true], ["failures", "Failures", input.failures?.length], ["audits", "Audits", input.audits.length], ["comparisons", "Comparisons", input.comparisons.length], ["performance", "Performance", hasPerf]]
    .filter((n) => n[2]).map((n) => `<a href="#${n[0]}">${n[1]}</a>`).join("");
  const stat = (n: number, label: string, cls = "") => `<div class="stat ${cls}"><b>${n}</b><span>${label}</span></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<div class="hero"><div class="hero-in"><div class="eyebrow">WP Performance Intelligence</div><h1>${esc(title)}</h1><p>Generated ${esc(input.generatedAt ?? new Date().toISOString())}. Findings come from fetched HTML and lab measurements. Fixes under “Exact fixes” are generated from this run’s measured evidence; the other examples are generic templates. No fix is verified until you apply it and re-run the report.</p></div></div>
<div class="bar-top"><div class="bar-in"><nav aria-label="Report sections">${nav}</nav><button class="icon-btn" id="theme" type="button" aria-label="Toggle light and dark theme">◐ Theme</button></div>
<div class="toolbar"><input id="q" type="search" placeholder="Search findings, rules, URLs…" aria-label="Search findings">
${SEVS.map((s) => `<button type="button" class="fchip" data-sev="${s}" aria-pressed="true">${s}<i>${counts[s]}</i></button>`).join("")}
<button type="button" class="icon-btn" id="reset">Reset</button><button type="button" class="icon-btn" id="expand">Expand fixes</button><button type="button" class="icon-btn" id="collapse">Collapse fixes</button><span class="muted small" id="count" role="status"></span></div></div>
<main>
<section class="dash" id="overview" data-spy>${stat(input.audits.length, "pages audited")}${stat(input.comparisons.length, "comparisons")}${stat(counts.critical + counts.high, "critical + high", "s-crit")}${stat(counts.medium, "medium", "s-med")}${stat(counts.low + counts.info, "low + info", "s-low")}</section>
${total ? `<div class="panel"><h2>Issue breakdown</h2><div class="sevbar" role="img" aria-label="Severity distribution">${SEVS.filter((s) => counts[s]).map((s) => `<span class="bg-${s}" style="flex:${counts[s]}" title="${counts[s]} ${s}"></span>`).join("")}</div>
<div class="legend">${SEVS.filter((s) => counts[s]).map((s) => `<span><i class="bg-${s}"></i>${counts[s]} ${s}</span>`).join("")}</div>
${top.length ? `<div class="top-issues" aria-label="Most common issues, click to filter">${top.map(([rule, e]) => `<button type="button" class="issue" data-rule="${esc(rule)}">${sevBadge(e.severity)}<span>${esc(e.title)}</span><span class="chip">×${e.n}</span></button>`).join("")}</div>` : ""}</div>` : ""}
${baselinePanel(input)}
${input.failures?.length ? `<section id="failures" data-spy><h2 class="sec">Failures</h2><div class="panel fail"><ul>${input.failures.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></div></section>` : ""}
${input.audits.length ? `<section id="audits" data-spy><h2 class="sec">Page audits</h2>${input.audits.map(auditSection).join("")}</section>` : ""}
${input.comparisons.length ? `<section id="comparisons" data-spy><h2 class="sec">Old vs new comparison</h2>${input.comparisons.map(comparisonSection).join("")}</section>` : ""}
${hasPerf ? `<section id="performance" data-spy><h2 class="sec">Performance <span class="muted small">lab data, not field Core Web Vitals</span></h2>${input.lighthouse.map((l, i) => lighthouseSection(l, i, input)).join("")}${input.measurements.map((m, i) => measurementSection(m, i, input)).join("")}</section>` : ""}
<div class="empty" id="none">No items match the current filters. <button class="icon-btn" type="button" onclick="document.getElementById('reset').click()">Reset filters</button></div>
<footer>WP Performance Intelligence · rating colours follow the web.dev "good / needs improvement / poor" bands</footer></main>
<div class="toast" id="toast" role="status" aria-live="polite"></div><script>${JS}</script></body></html>`;
}
