import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type StepState = "queued" | "running" | "done" | "failed";
interface Job { id: string; status: "queued" | "running" | "done" | "failed" | "cancelled"; createdAt: string; finishedAt?: string; title: string; steps: Array<{ label: string; state: StepState; error?: string }>; folder?: string; filePath?: string; failures?: string[]; error?: string }
interface PastReport { folder: string; createdAt: string; url: string }
interface Pair { oldUrl: string; newUrl: string }

// Same origin when served by the API; direct to the API when running `vite` on :5173.
const BASE = location.port === "5173" ? "http://127.0.0.1:4178" : "";
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "content-type": "application/json" } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const isHttp = (u: string) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ }
  };
  return <button type="button" className="btn ghost" onClick={copy}>{done ? "Copied!" : label}</button>;
}

function ExportLinks({ folder }: { folder: string }) {
  const href = (f: string) => `${BASE}/reports/${folder}/export/${f}`;
  return (
    <span className="exports" role="group" aria-label="Export this report">
      <span className="muted small">Export:</span>
      <a className="btn ghost" href={href("json")} download>JSON</a>
      <a className="btn ghost" href={href("xlsx")} download>Spreadsheet (.xlsx)</a>
      <a className="btn ghost" href={href("html")} download>HTML</a>
    </span>
  );
}

const ICON: Record<StepState, string> = { queued: "○", running: "◐", done: "✓", failed: "✕" };

function JobCard({ job, onCancel }: { job: Job; onCancel: (id: string) => void }) {
  const done = job.steps.filter((s) => s.state === "done" || s.state === "failed").length;
  const pct = job.steps.length ? Math.round((done / job.steps.length) * 100) : 0;
  const link = job.folder ? `${BASE || location.origin}/reports/${job.folder}/report.html` : "";
  const active = job.status === "queued" || job.status === "running";
  return (
    <article className={`job j-${job.status}`} aria-live="polite">
      <header>
        <strong>{job.title}</strong>
        <span className={`pill p-${job.status}`}>{job.status}</span>
        <span className="muted small">{new Date(job.createdAt).toLocaleString()}</span>
        {active && <button type="button" className="btn ghost danger" onClick={() => onCancel(job.id)}>Cancel</button>}
      </header>
      {job.steps.length > 0 && <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>}
      <ul className="steps">{job.steps.map((s, i) => <li key={i} className={`s-${s.state}`}><span className="ico" aria-hidden="true">{ICON[s.state]}</span><span className="lbl">{s.label}</span>{s.error && <em> {s.error}</em>}</li>)}</ul>
      {job.status === "queued" && <p className="muted small">Waiting for the running report to finish…</p>}
      {job.error && <p className="err">{job.error}</p>}
      {job.status === "done" && link && (
        <div className="result">
          <a className="btn primary" href={link} target="_blank" rel="noopener">Open report ↗</a>
          <input readOnly value={link} aria-label="Report link" onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={link} label="Copy link" />
          <p className="exportrow"><ExportLinks folder={job.folder!} /></p>
          {job.filePath && <p className="muted small">Saved on disk: <code>{job.filePath}</code></p>}
          {job.failures && job.failures.length > 0 && <p className="warn small">{job.failures.length} step(s) failed; details are in the report’s Failures section.</p>}
        </div>
      )}
    </article>
  );
}

function App() {
  const [same, setSame] = useState(true);
  const [urls, setUrls] = useState("");
  const [tools, setTools] = useState({ audit: true, measure: false, lighthouse: true });
  const [audits, setAudits] = useState("");
  const [measures, setMeasures] = useState("");
  const [lights, setLights] = useState("");
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [runs, setRuns] = useState(3);
  const [profile, setProfile] = useState<"desktop" | "mobile">("mobile");
  const [baseline, setBaseline] = useState("");
  const [psi, setPsi] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [past, setPast] = useState<PastReport[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [j, r] = await Promise.all([api<{ jobs: Job[] }>("/api/jobs"), api<{ reports: PastReport[] }>("/api/reports")]);
      setJobs(j.jobs); setPast(r.reports);
    } catch (e) { setError(e instanceof Error ? e.message : "Cannot reach the API."); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const anyActive = jobs.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => { if (!anyActive) return; const t = setInterval(() => void refresh(), 1500); return () => clearInterval(t); }, [anyActive, refresh]);

  const request = useMemo(() => {
    const list = lines(urls);
    return {
      audits: same ? (tools.audit ? list : []) : lines(audits),
      measures: same ? (tools.measure ? list : []) : lines(measures),
      lighthouse: same ? (tools.lighthouse ? list : []) : lines(lights),
      compares: pairs.filter((p) => p.oldUrl.trim() || p.newUrl.trim()).map((p) => ({ oldUrl: p.oldUrl.trim(), newUrl: p.newUrl.trim() })),
      runs, profile, psi, ...(baseline ? { baseline } : {})
    };
  }, [same, urls, tools, audits, measures, lights, pairs, runs, profile, baseline, psi]);

  const bad = [...request.audits, ...request.measures, ...request.lighthouse, ...request.compares.flatMap((p) => [p.oldUrl, p.newUrl])].filter((u) => !isHttp(u));
  const total = request.audits.length + request.measures.length + request.lighthouse.length + request.compares.length;
  const canRun = total > 0 && bad.length === 0 && !busy;

  async function run(e: React.FormEvent) {
    e.preventDefault(); setError(""); setBusy(true);
    try { await api("/api/jobs", { method: "POST", body: JSON.stringify(request) }); await refresh(); document.getElementById("jobs")?.scrollIntoView({ behavior: "smooth" }); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not start the report."); }
    finally { setBusy(false); }
  }
  async function cancel(id: string) { try { await api(`/api/jobs/${id}/cancel`, { method: "POST" }); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : "Cancel failed."); } }
  async function importCsv(file: File) {
    setError("");
    try {
      const { result } = await api<{ result: { mode: "urls" | "pairs"; urls: string[]; pairs: Array<{ oldUrl: string; newUrl: string }>; errors: string[] } }>("/api/import/csv", { method: "POST", body: JSON.stringify({ csv: await file.text() }) });
      if (result.mode === "urls") { setSame(true); setUrls(result.urls.join("\n")); } else setPairs(result.pairs.map((p) => ({ oldUrl: p.oldUrl, newUrl: p.newUrl })));
      if (result.errors.length) setError(`CSV: ${result.errors.length} row(s) skipped. ${result.errors[0]}`);
    } catch (e) { setError(e instanceof Error ? e.message : "CSV import failed."); }
  }
  const setPair = (i: number, patch: Partial<Pair>) => setPairs((p) => p.map((x, n) => (n === i ? { ...x, ...patch } : x)));

  const List = ({ id, label, value, set, hint }: { id: string; label: string; value: string; set: (v: string) => void; hint?: string }) => (
    <div className="field"><label htmlFor={id}>{label}</label><textarea id={id} rows={4} value={value} onChange={(e) => set(e.target.value)} placeholder={"https://example.com/\nhttps://example.com/about/"} spellCheck={false} />{hint && <small className="muted">{hint}</small>}</div>
  );

  return (
    <>
      <div className="hero"><div className="wrap"><div className="eyebrow">WP Performance Intelligence</div><h1>Run a performance &amp; SEO report</h1><p>Choose what to check. The report runs in the background; the link appears below when it is ready.</p></div></div>
      <main className="wrap">
        <form className="card" onSubmit={run}>
          <h2>1. Pages</h2>
          <label className="check"><input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} /> Use the same URLs for every check</label>
          {same ? (
            <>
              <List id="urls" label="URLs (one per line)" value={urls} set={setUrls} hint="LocalWP sites such as https://mysite.test/ work in local mode." />
              <fieldset className="tools"><legend>Run on these URLs</legend>
                <label className="check"><input type="checkbox" checked={tools.audit} onChange={(e) => setTools({ ...tools, audit: e.target.checked })} /> HTML audit <small>SEO, headings, images, schema</small></label>
                <label className="check"><input type="checkbox" checked={tools.lighthouse} onChange={(e) => setTools({ ...tools, lighthouse: e.target.checked })} /> Lighthouse <small>scores, metrics, exact fixes</small></label>
                <label className="check"><input type="checkbox" checked={tools.measure} onChange={(e) => setTools({ ...tools, measure: e.target.checked })} /> Browser measurement <small>LCP element, slow resources</small></label>
              </fieldset>
            </>
          ) : (
            <div className="grid3"><List id="a" label="HTML audit URLs" value={audits} set={setAudits} /><List id="l" label="Lighthouse URLs" value={lights} set={setLights} /><List id="m" label="Browser measurement URLs" value={measures} set={setMeasures} /></div>
          )}
          <div className="csv"><label className="btn ghost">Import CSV…<input type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importCsv(f); e.target.value = ""; }} /></label><small className="muted">A <code>url</code> column fills the list; <code>old_url,new_url</code> fills the comparison.</small></div>

          <h2>2. Compare old vs new <small className="muted">(optional)</small></h2>
          {pairs.map((p, i) => (
            <div className="pair" key={i}>
              <input aria-label={`Old URL ${i + 1}`} placeholder="Old / production URL" value={p.oldUrl} onChange={(e) => setPair(i, { oldUrl: e.target.value })} />
              <span aria-hidden="true">→</span>
              <input aria-label={`New URL ${i + 1}`} placeholder="New / staging URL" value={p.newUrl} onChange={(e) => setPair(i, { newUrl: e.target.value })} />
              <button type="button" className="btn ghost danger" aria-label={`Remove pair ${i + 1}`} onClick={() => setPairs(pairs.filter((_, n) => n !== i))}>✕</button>
            </div>
          ))}
          <button type="button" className="btn ghost" onClick={() => setPairs([...pairs, { oldUrl: "", newUrl: "" }])}>+ Add comparison</button>

          <h2>3. Options</h2>
          <div className="opts">
            <div className="field"><label htmlFor="profile">Device profile</label><select id="profile" value={profile} onChange={(e) => setProfile(e.target.value as "desktop" | "mobile")}><option value="mobile">Mobile</option><option value="desktop">Desktop</option></select></div>
            <div className="field"><label htmlFor="runs">Runs per page</label><select id="runs" value={runs} onChange={(e) => setRuns(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}{n === 3 ? " (recommended)" : n === 1 ? " (noisy)" : ""}</option>)}</select></div>
            <div className="field"><label htmlFor="baseline">Compare with a previous report</label><select id="baseline" value={baseline} onChange={(e) => setBaseline(e.target.value)}><option value="">None</option>{past.map((r) => <option key={r.folder} value={r.folder}>{r.folder}</option>)}</select></div>
          </div>

          <label className="check psi"><input type="checkbox" checked={psi} onChange={(e) => setPsi(e.target.checked)} /> Also compare with Google PageSpeed Insights <small>adds Google’s score and real-user (field) data; sends the URL to Google; public sites only, not LocalWP</small></label>
          {bad.length > 0 && <p className="err" role="alert">Not a valid http(s) URL: {bad.slice(0, 3).join(", ")}{bad.length > 3 ? "…" : ""}</p>}
          {error && <p className="err" role="alert">{error}</p>}
          <div className="actions"><button type="submit" className="btn primary big" disabled={!canRun}>{busy ? "Starting…" : "Run report"}</button><span className="muted small">{total} check{total === 1 ? "" : "s"} · about 1–2 minutes per page with 3 runs</span></div>
        </form>

        <section id="jobs"><h2 className="sec">Reports</h2>
          {jobs.length === 0 && <p className="muted">No reports started in this session yet.</p>}
          {jobs.map((j) => <JobCard key={j.id} job={j} onCancel={cancel} />)}
        </section>

        {past.length > 0 && <section><h2 className="sec">Earlier reports <small className="muted">saved on disk</small></h2>
          <ul className="past">{past.map((r) => <li key={r.folder}><a href={`${BASE}${r.url}`} target="_blank" rel="noopener">{r.folder}</a><span className="muted small">{new Date(r.createdAt).toLocaleString()}</span><ExportLinks folder={r.folder} /><button type="button" className="btn ghost" onClick={() => { setBaseline(r.folder); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Use as baseline</button></li>)}</ul></section>}
        <footer>Lab data from a local browser, not field Core Web Vitals. Reports are saved to your reports folder (default: Desktop).</footer>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
