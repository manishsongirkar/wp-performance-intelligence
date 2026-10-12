import { afterEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildApp } from "../apps/api/src/app.js";
import { loadConfig } from "../apps/api/src/config.js";
import type { Resolver, Transport } from "../packages/safe-fetch/src/index.js";

const resolve: Resolver = async (h) => ({ "site.com": ["93.184.216.34"], "bad.com": ["10.0.0.1"] }[h] ?? (() => { throw new Error("nx"); })()).map((address) => ({ address, family: 4 }));
const page = (extra = "") => `<html><head><title>T</title><meta name="description" content="d"><link rel="canonical" href="https://site.com/">${extra}</head><body><h1>H</h1></body></html>`;
const transport = (html: string, status = 200, ct = "text/html"): Transport => async () => ({ status, headers: { "content-type": ct }, destroy() {}, body: (async function* () { yield Buffer.from(html); })() });

const apps: Array<{ close(): Promise<unknown> }> = [];
const make = (env: Record<string, string> = {}, t: Transport = transport(page())) => {
  const app = buildApp(loadConfig({ WPI_MODE: "public", ...env }), { resolve, transport: t, logger: false }); apps.push(app); return app;
};
afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });
const post = (app: ReturnType<typeof make>, url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload: payload as object, headers });

describe("config", () => {
  it("applies safe defaults", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ host: "127.0.0.1", port: 4178 });
    expect(c.fetch.policy.mode).toBe("local");
  });
  it.each([{ PORT: "0" }, { PORT: "abc" }, { WPI_MODE: "dev" }, { WPI_TIMEOUT_MS: "5" }, { WPI_MAX_BYTES: "-1" }])("rejects %o", (env) => expect(() => loadConfig(env)).toThrow(/Invalid configuration/));
  it("refuses a public bind without public mode and a token", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(/WPI_MODE=public/);
    expect(() => loadConfig({ HOST: "0.0.0.0", WPI_MODE: "public" })).toThrow(/WPI_API_TOKEN/);
    expect(() => loadConfig({ HOST: "0.0.0.0", WPI_MODE: "public", WPI_API_TOKEN: "short" })).toThrow(/WPI_API_TOKEN/);
    expect(loadConfig({ HOST: "0.0.0.0", WPI_MODE: "public", WPI_API_TOKEN: "x".repeat(16) }).token).toBeTruthy();
  });
  it("drops private hosts in public mode", () => expect(loadConfig({ WPI_MODE: "public" }).fetch.policy.privateHosts).toEqual([]));
});

describe("POST /api/audit", () => {
  it("returns an audit", async () => {
    const r = await post(make(), "/api/audit", { url: "https://site.com/" });
    expect(r.statusCode).toBe(200);
    expect(r.json().result).toMatchObject({ statusCode: 200, title: "T", finalUrl: "https://site.com/" });
  });
  it("validates input", async () => {
    expect((await post(make(), "/api/audit", { url: "nope" })).statusCode).toBe(400);
    expect((await post(make(), "/api/audit", {})).statusCode).toBe(400);
  });
  it("returns 403 for blocked destinations, without leaking internals", async () => {
    const r = await post(make(), "/api/audit", { url: "http://bad.com/" });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "Host bad.com resolves to a disallowed address.", code: "BLOCKED_DESTINATION" });
    expect((await post(make(), "/api/audit", { url: "http://169.254.169.254/" })).statusCode).toBe(403);
  });
  it("maps DNS failure and rejects file: URLs", async () => {
    expect((await post(make(), "/api/audit", { url: "http://missing.com/" })).statusCode).toBe(422);
    expect((await post(make(), "/api/audit", { url: "file:///etc/passwd" })).statusCode).toBe(400);
  });
  it("reports non-HTML and HTTP errors as audits, not crashes", async () => {
    const pdf = await post(make({}, transport("%PDF", 200, "application/pdf")), "/api/audit", { url: "https://site.com/a.pdf" });
    expect(pdf.json().result.limitations[0]).toMatch(/not HTML/);
    const nf = await post(make({}, transport("<p>x</p>", 404)), "/api/audit", { url: "https://site.com/x" });
    expect(nf.json().result.findings.some((f: any) => f.ruleId === "http.error-status")).toBe(true);
  });
  it("returns a generic 500 on unexpected failures", async () => {
    const boom: Transport = async () => { throw new Error("secret /internal/path"); };
    const r = await post(make({}, boom), "/api/audit", { url: "https://site.com/" });
    expect(r.statusCode).toBe(502); // transport errors are normalised; no raw message
    expect(r.body).not.toMatch(/secret/);
  });
  it("rejects malformed JSON with 400 and oversized bodies with 413", async () => {
    const app = make();
    expect((await app.inject({ method: "POST", url: "/api/audit", payload: "{bad", headers: { "content-type": "application/json" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/audit", payload: JSON.stringify({ url: "x".repeat(2_000_000) }), headers: { "content-type": "application/json" } })).statusCode).toBe(413);
  });
  it("sheds load beyond the concurrency cap", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    const slow: Transport = async () => { await gate; return { status: 200, headers: { "content-type": "text/html" }, destroy() {}, body: (async function* () { yield Buffer.from(page()); })() }; };
    const app = make({ WPI_MAX_CONCURRENT: "1" }, slow);
    const first = post(app, "/api/audit", { url: "https://site.com/" });
    await new Promise((r) => setTimeout(r, 20));
    expect((await post(app, "/api/audit", { url: "https://site.com/b" })).statusCode).toBe(429);
    release(); expect((await first).statusCode).toBe(200);
  });
});

describe("POST /api/compare", () => {
  it("compares two pages", async () => {
    const r = await post(make(), "/api/compare", { oldUrl: "https://site.com/a", newUrl: "https://site.com/b" });
    expect(r.statusCode).toBe(200); expect(r.json().result.status).toBe("compared");
  });
  it("fails closed if either side is blocked", async () => expect((await post(make(), "/api/compare", { oldUrl: "https://site.com/", newUrl: "http://bad.com/" })).statusCode).toBe(403));
});

describe("POST /api/import/csv", () => {
  it("parses and rejects", async () => {
    expect((await post(make(), "/api/import/csv", { csv: "url\nhttps://a.com/" })).json().result.urls).toEqual(["https://a.com/"]);
    expect((await post(make(), "/api/import/csv", { csv: "bogus\nx" })).statusCode).toBe(400);
    expect((await post(make(), "/api/import/csv", {})).statusCode).toBe(400);
  });
});

describe("POST /api/export/xlsx", () => {
  const audit = (title: string) => ({
    schemaVersion: "1.0.0", url: "https://site.com/", fetchedAt: "2026-01-01T00:00:00Z", statusCode: 200, finalUrl: "https://site.com/", contentType: "text/html",
    title, metaDescription: null, canonical: null, robots: null, headings: { h1: [], h2Count: 0, h3Count: 0 },
    images: { total: 0, missingAlt: 0, missingDimensions: 0 }, links: { total: 0, internal: 0, external: 0 }, schemaTypes: [], jsonLdBlocks: 0, limitations: [],
    findings: [{ id: "1", ruleId: "r", category: "seo", severity: "low", confidence: "high", title: "=HYPERLINK(\"http://evil\",\"x\")", description: "+cmd|' /C calc'!A0", url: "https://site.com/", evidence: [], recommendation: "@SUM(1)", status: "open" }]
  });
  it("neutralises formula injection and produces a readable workbook", async () => {
    const r = await post(make(), "/api/export/xlsx", { results: [audit("t")] });
    expect(r.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.rawPayload as unknown as ArrayBuffer);
    const row = wb.getWorksheet("Findings")!.getRow(2);
    expect(row.getCell(6).value).toBe(`'=HYPERLINK("http://evil","x")`);
    expect(row.getCell(7).value).toMatch(/^'\+cmd/);
    expect(row.getCell(8).value).toBe("'@SUM(1)");
  });
  it("rejects invalid shapes", async () => {
    for (const body of [{ results: [{ foo: 1 }] }, { results: "x" }, {}, { results: [{ ...audit("t"), statusCode: "200" }] }, { results: [{ ...audit("t"), title: "x".repeat(6000) }] }])
      expect((await post(make(), "/api/export/xlsx", body)).statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
  });
});

describe("CORS, host and auth", () => {
  const local = { WPI_MODE: "local" };
  it("allows the dashboard origin and rejects others", async () => {
    const app = make(local);
    const ok = await app.inject({ method: "OPTIONS", url: "/api/audit", headers: { origin: "http://127.0.0.1:5173", host: "127.0.0.1:4178" } });
    expect(ok.statusCode).toBe(204); expect(ok.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    const bad = await app.inject({ method: "POST", url: "/api/audit", payload: { url: "https://site.com/" }, headers: { origin: "https://evil.example", host: "127.0.0.1:4178" } });
    expect(bad.statusCode).toBe(403);
  });
  it("rejects a foreign Host header on a loopback bind (DNS rebinding)", async () => {
    const r = await make(local).inject({ method: "GET", url: "/health", headers: { host: "rebind.evil.com" } });
    expect(r.statusCode).toBe(403);
  });
  it("requires the bearer token on /api when configured", async () => {
    const app = make({ WPI_API_TOKEN: "t".repeat(20) });
    expect((await post(app, "/api/audit", { url: "https://site.com/" })).statusCode).toBe(401);
    expect((await post(app, "/api/audit", { url: "https://site.com/" }, { authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect((await post(app, "/api/audit", { url: "https://site.com/" }, { authorization: `Bearer ${"t".repeat(20)}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });
});
