import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { auditPage } from "../../../packages/audit-core/src/audit.js";
import { parseUrlCsv } from "../../../packages/url-import/src/csv.js";
import { comparePages } from "../../../packages/site-comparison/src/compare.js";
import { createAuditWorkbook } from "../../../packages/reports/src/xlsx.js";
import type { ComparisonResult, PageAudit } from "../../../packages/contracts/src/types.js";
import { exportSchema } from "../../../packages/contracts/src/schemas.js";
import { createLimiter, SafeFetchError, type SafeFetchErrorCode, type Resolver, type Transport } from "../../../packages/safe-fetch/src/index.js";
import { measurePage } from "../../../packages/browser-audit/src/measure.js";
import { runLighthouse } from "../../../packages/browser-audit/src/lighthouse.js";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { createJobManager } from "./jobs.js";
import { generateReport, REPORT_FOLDER } from "./report.js";
import { isLoopbackHost, type Config } from "./config.js";

const auditSchema = z.object({ url: z.string().url().max(2048) });
const compareSchema = z.object({ oldUrl: z.string().url().max(2048), newUrl: z.string().url().max(2048) });
const measureSchema = z.object({ url: z.string().url().max(2048), profile: z.enum(["desktop", "mobile"]).default("desktop"), runs: z.number().int().min(1).max(5).default(3) });
const urlList = z.array(z.string().url().max(2048).refine((u) => /^https?:\/\//i.test(u), "Only http(s) URLs")).max(20).default([]);
const jobSchema = z.object({
  audits: urlList, measures: urlList, lighthouse: urlList,
  compares: z.array(z.object({ oldUrl: z.string().url().max(2048), newUrl: z.string().url().max(2048) }).refine((p) => /^https?:\/\//i.test(p.oldUrl) && /^https?:\/\//i.test(p.newUrl), "Only http(s) URLs")).max(10).default([]),
  runs: z.number().int().min(1).max(5).default(3),
  profile: z.enum(["desktop", "mobile"]).default("desktop"),
  baseline: z.string().regex(REPORT_FOLDER).optional(),
  psi: z.boolean().default(false)
}).refine((j) => j.audits.length + j.compares.length + j.measures.length + j.lighthouse.length > 0, "Add at least one URL.");
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml" };
const REPORT_FILE = /^(report\.html|data\.json|lighthouse-\d+-run\d+\.html)$/;
const csvSchema = z.object({ csv: z.string().min(1).max(500_000) });

const STATUS: Record<SafeFetchErrorCode, number> = {
  INVALID_URL: 400, BLOCKED_DESTINATION: 403, DNS_FAILURE: 422, TIMEOUT: 504,
  REDIRECT_ERROR: 422, TOO_LARGE: 422, NETWORK: 502, BUSY: 429
};

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** `deps` lets tests inject DNS and transport; production uses the real ones. */
export function buildApp(config: Config, deps: { resolve?: Resolver; transport?: Transport; logger?: boolean; measure?: typeof measurePage; lighthouse?: typeof runLighthouse; generate?: typeof generateReport; webDir?: string } = {}) {
  const app = Fastify({ logger: deps.logger ?? true, bodyLimit: 1_000_000 });
  const limit = createLimiter(config.maxConcurrent);
  const browserLimit = createLimiter(1); // one browser job at a time
  const measure = deps.measure ?? measurePage;
  const lh = deps.lighthouse ?? runLighthouse;
  const fetchOpts = { ...config.fetch, resolve: deps.resolve, transport: deps.transport };

  app.addHook("onRequest", async (request, reply) => {
    // Local API only: reject foreign Host headers (DNS rebinding against the API itself).
    if (isLoopbackHost(config.host)) {
      const hostName = (request.headers.host ?? "").replace(/:\d+$/, "");
      if (!isLoopbackHost(hostName)) return reply.code(403).send({ error: "Forbidden host" });
    }
    const origin = request.headers.origin;
    if (origin) {
      const sameOrigin = origin === `http://${request.headers.host}`; // the UI served by this API itself
      if (!sameOrigin && !config.corsOrigins.includes(origin)) return reply.code(403).send({ error: "Origin not allowed" });
      reply.header("access-control-allow-origin", origin).header("vary", "Origin");
      if (request.method === "OPTIONS") {
        return reply.header("access-control-allow-methods", "GET,POST").header("access-control-allow-headers", "content-type,authorization").code(204).send();
      }
    }
    if (config.token && request.url.startsWith("/api/")) {
      const auth = request.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), config.token)) return reply.code(401).send({ error: "Unauthorized" });
    }
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: error.message });
    request.log.error({ err: error }, "Unhandled error");
    return reply.code(500).send({ error: "Internal server error" });
  });

  const failure = (request: { log: { warn: Function } }, reply: { code(n: number): { send(b: unknown): unknown } }, error: unknown) => {
    if (error instanceof SafeFetchError) {
      request.log.warn({ code: error.code }, "Fetch rejected");
      return reply.code(STATUS[error.code]).send({ error: error.message, code: error.code });
    }
    throw error; // handled as a generic 500 by the error handler
  };

  app.get("/health", async () => ({ ok: true, name: "wp-performance-intelligence", version: "0.1.0" }));

  app.post("/api/audit", async (request, reply) => {
    const parsed = auditSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    try { return { result: await limit(() => auditPage(parsed.data.url, fetchOpts)) }; }
    catch (error) { return failure(request, reply, error); }
  });

  app.post("/api/compare", async (request, reply) => {
    const parsed = compareSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    try {
      const [oldAudit, newAudit] = await limit(() => Promise.all([auditPage(parsed.data.oldUrl, fetchOpts), auditPage(parsed.data.newUrl, fetchOpts)]), 2);
      return { result: comparePages(oldAudit, newAudit) };
    } catch (error) { return failure(request, reply, error); }
  });

  app.post("/api/measure", async (request, reply) => {
    const parsed = measureSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    // The browser resolves DNS itself (no address pinning), so it is trusted-local only.
    if (config.fetch.policy.mode !== "local") return reply.code(403).send({ error: "Browser measurement is only available in local mode.", code: "BROWSER_DISABLED" });
    try {
      return { result: await browserLimit(() => measure(parsed.data.url, { policy: config.fetch.policy, profile: parsed.data.profile, runs: parsed.data.runs, resolve: deps.resolve })) };
    } catch (error) { return failure(request, reply, error); }
  });

  app.post("/api/lighthouse", async (request, reply) => {
    const parsed = measureSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    if (config.fetch.policy.mode !== "local") return reply.code(403).send({ error: "Lighthouse is only available in local mode.", code: "BROWSER_DISABLED" });
    try {
      return { result: await browserLimit(() => lh(parsed.data.url, { policy: config.fetch.policy, profile: parsed.data.profile, runs: parsed.data.runs, resolve: deps.resolve })) };
    } catch (error) { return failure(request, reply, error); }
  });

  // ---- background report jobs (local mode only: they drive a browser and write to disk) ----
  const generate = deps.generate ?? generateReport;
  const jobs = createJobManager((req, hooks) => generate(req, config.fetch, hooks));
  const localOnly = (reply: { code(n: number): { send(b: unknown): unknown } }) => reply.code(403).send({ error: "Report jobs are only available in local mode.", code: "LOCAL_ONLY" });
  const isLocal = config.fetch.policy.mode === "local";

  app.post("/api/jobs", async (request, reply) => {
    if (!isLocal) return localOnly(reply);
    const parsed = jobSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    const j = parsed.data;
    const first = j.audits[0] ?? j.compares[0]?.newUrl ?? j.measures[0] ?? j.lighthouse[0]!;
    const job = jobs.submit({
      audits: j.audits, measures: j.measures, lighthouse: j.lighthouse, compares: j.compares.map((p) => [p.oldUrl, p.newUrl] as [string, string]),
      runs: j.runs, profile: j.profile, outDir: config.reportsDir, psi: j.psi && j.lighthouse.length > 0, psiApiKey: config.psiApiKey, baselinePath: j.baseline ? join(config.reportsDir, j.baseline) : undefined
    }, new URL(first).hostname);
    if (!job) return reply.code(429).send({ error: "Too many queued reports; wait for one to finish.", code: "BUSY" });
    return reply.code(202).send({ job });
  });
  app.get("/api/jobs", async (_req, reply) => (isLocal ? { jobs: jobs.list() } : localOnly(reply)));
  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    if (!isLocal) return localOnly(reply);
    const job = jobs.get(request.params.id);
    return job ? { job } : reply.code(404).send({ error: "Job not found" });
  });
  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (request, reply) => {
    if (!isLocal) return localOnly(reply);
    return jobs.cancel(request.params.id) ? { ok: true } : reply.code(409).send({ error: "Job is not running or queued." });
  });
  app.get("/api/reports", async (_req, reply) => {
    if (!isLocal) return localOnly(reply);
    const found: Array<{ folder: string; createdAt: string; url: string }> = [];
    try {
      for (const name of await readdir(config.reportsDir)) {
        if (!REPORT_FOLDER.test(name)) continue;
        try { const st = await stat(join(config.reportsDir, name, "report.html")); found.push({ folder: name, createdAt: st.mtime.toISOString(), url: `/reports/${name}/report.html` }); } catch { /* not a report */ }
      }
    } catch { /* reports dir missing: no reports yet */ }
    return { reports: found.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50) };
  });
  // Serves only report files from folders that match the generated naming pattern: no traversal, fixed file whitelist.
  app.get<{ Params: { folder: string; file: string } }>("/reports/:folder/:file", async (request, reply) => {
    if (!isLocal) return localOnly(reply);
    const { folder, file } = request.params;
    if (!REPORT_FOLDER.test(folder) || !REPORT_FILE.test(file)) return reply.code(404).send({ error: "Not found" });
    try {
      const body = await readFile(join(config.reportsDir, folder, file));
      return reply.header("content-type", MIME[extname(file)] ?? "application/octet-stream").header("x-content-type-options", "nosniff").header("cache-control", "no-store").send(body);
    } catch { return reply.code(404).send({ error: "Not found" }); }
  });

  // Downloads: the report's own files, or a spreadsheet built from its data.json.
  app.get<{ Params: { folder: string; format: string } }>("/reports/:folder/export/:format", async (request, reply) => {
    if (!isLocal) return localOnly(reply);
    const { folder, format } = request.params;
    if (!REPORT_FOLDER.test(folder) || !["json", "xlsx", "html"].includes(format)) return reply.code(404).send({ error: "Not found" });
    const dir = join(config.reportsDir, folder);
    const send = (body: Buffer | string, type: string, ext: string) =>
      reply.header("content-type", type).header("content-disposition", `attachment; filename="${folder}.${ext}"`).header("x-content-type-options", "nosniff").send(body);
    try {
      if (format === "html") return send(await readFile(join(dir, "report.html")), MIME[".html"]!, "html");
      const raw = await readFile(join(dir, "data.json"));
      if (format === "json") return send(raw, MIME[".json"]!, "json");
      const data = JSON.parse(raw.toString("utf8")) as { audits?: unknown[]; comparisons?: unknown[]; lighthouse?: unknown[]; measurements?: unknown[] };
      const rows = exportSchema.safeParse({ results: [...(data.audits ?? []), ...(data.comparisons ?? [])] });
      if (!rows.success) return reply.code(422).send({ error: "This report's data cannot be exported to a spreadsheet." });
      const xlsx = await createAuditWorkbook(rows.data.results as Array<PageAudit | ComparisonResult>, { lighthouse: data.lighthouse as never, measurements: data.measurements as never });
      return send(xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx");
    } catch { return reply.code(404).send({ error: "Report not found" }); }
  });

  // ---- the dashboard (built Vite output), served by the same origin so no CORS is needed ----
  const webDir = deps.webDir ?? join(import.meta.dirname, "../../web/dist");
  const sendWeb = async (rel: string, reply: { code(n: number): { send(b: unknown): unknown }; header(k: string, v: string): unknown }) => {
    const full = normalize(join(webDir, rel));
    if (!full.startsWith(webDir + sep)) return reply.code(404).send({ error: "Not found" });
    try { const body = await readFile(full); reply.header("content-type", MIME[extname(full)] ?? "application/octet-stream"); reply.header("x-content-type-options", "nosniff"); return (reply as unknown as { send(b: unknown): unknown }).send(body); }
    catch { return reply.code(404).send({ error: "Dashboard not built. Run: npm run build" }); }
  };
  app.get("/", (_req, reply) => sendWeb("index.html", reply));
  app.get<{ Params: { file: string } }>("/assets/:file", (request, reply) => (/^[\w.-]+$/.test(request.params.file) ? sendWeb(`assets/${request.params.file}`, reply) : reply.code(404).send({ error: "Not found" })));

  app.post("/api/import/csv", async (request, reply) => {
    const parsed = csvSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    try { return { result: parseUrlCsv(parsed.data.csv) }; }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "CSV parsing failed" }); }
  });

  app.post("/api/export/xlsx", async (request, reply) => {
    const parsed = exportSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
    const workbook = await createAuditWorkbook(parsed.data.results as Array<PageAudit | ComparisonResult>);
    return reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", 'attachment; filename="wpi-audit-report.xlsx"')
      .send(workbook);
  });

  return app;
}
