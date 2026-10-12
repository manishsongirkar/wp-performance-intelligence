import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Finding = { title: string; severity: string; recommendation: string };
type Audit = { url: string; statusCode: number; title: string | null; findings: Finding[]; limitations: string[] };
function App() {
  const [url, setUrl] = useState("");
  const [oldUrl, setOldUrl] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function call(path: string, body: unknown) {
    setBusy(true); setError(""); setResult(null);
    try {
      const response = await fetch(`http://127.0.0.1:4178${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Request failed");
      setResult(data.result);
    } catch (e) { setError(e instanceof Error ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }
  return <main className="shell">
    <header className="topbar"><div className="brand-mark">W</div><div><strong>WP Performance Intelligence</strong><div className="muted small">Performance · SEO · Migration safety</div></div><span className="pill">Local MVP</span></header>
    <section className="hero"><div className="eyebrow">WEBSITE CHANGE INTELLIGENCE</div><h1>Find what changed.<br/><span>Know what to fix.</span></h1><p>Audit rendered HTML, compare old and new pages, and turn detectable differences into actionable findings.</p></section>
    <section className="grid">
      <article className="panel"><div className="panel-icon">↗</div><h2>Audit a URL</h2><p className="muted">Inspect metadata, headings, images, links and structured data.</p><form onSubmit={e => { e.preventDefault(); void call("/api/audit", { url }); }}><label>Website URL</label><input required type="url" placeholder="https://staging.example.com/page/" value={url} onChange={e=>setUrl(e.target.value)}/><button disabled={busy}>{busy ? "Running…" : "Run audit"}</button></form></article>
      <article className="panel"><div className="panel-icon">⇄</div><h2>Compare old vs. new</h2><p className="muted">Highlight changes to canonical, robots, schema, headings and links.</p><form onSubmit={e => { e.preventDefault(); void call("/api/compare", { oldUrl, newUrl }); }}><label>Old site URL</label><input required type="url" placeholder="https://old.example.com/" value={oldUrl} onChange={e=>setOldUrl(e.target.value)}/><label>New site URL</label><input required type="url" placeholder="https://new.example.com/" value={newUrl} onChange={e=>setNewUrl(e.target.value)}/><button disabled={busy}>{busy ? "Comparing…" : "Compare pages"}</button></form></article>
      <article className="panel full"><div className="panel-icon">▤</div><h2>Import multiple URLs</h2><p className="muted">Paste CSV with a <code>url</code> column or <code>old_url,new_url</code> mapping.</p><textarea rows={4} value={csv} onChange={e=>setCsv(e.target.value)} placeholder={"old_url,new_url,group\\nhttps://old.example.com/,https://new.example.com/,home"} /><button className="secondary" disabled={busy || !csv.trim()} onClick={()=>void call("/api/import/csv", { csv })}>Validate CSV</button></article>
    </section>
    {error && <div className="error">{error}</div>}
    {result && <section className="results"><div className="results-head"><h2>Results</h2><button className="secondary" onClick={()=>navigator.clipboard.writeText(JSON.stringify(result,null,2))}>Copy JSON</button></div><pre>{JSON.stringify(result, null, 2)}</pre></section>}
    <footer>Early MVP · HTML audit and migration comparison only. Lighthouse/browser metrics, persistent history, secure public hosting and approved code patches are not implemented yet.</footer>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
