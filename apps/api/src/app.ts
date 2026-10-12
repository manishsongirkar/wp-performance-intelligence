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
import { isLoopbackHost, type Config } from "./config.js";

const auditSchema = z.object({ url: z.string().url().max(2048) });
const compareSchema = z.object({ oldUrl: z.string().url().max(2048), newUrl: z.string().url().max(2048) });
const csvSchema = z.object({ csv: z.string().min(1).max(500_000) });

const STATUS: Record<SafeFetchErrorCode, number> = {
  INVALID_URL: 400, BLOCKED_DESTINATION: 403, DNS_FAILURE: 422, TIMEOUT: 504,
  REDIRECT_ERROR: 422, TOO_LARGE: 422, NETWORK: 502, BUSY: 429
};

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** `deps` lets tests inject DNS and transport; production uses the real ones. */
export function buildApp(config: Config, deps: { resolve?: Resolver; transport?: Transport; logger?: boolean } = {}) {
  const app = Fastify({ logger: deps.logger ?? true, bodyLimit: 1_000_000 });
  const limit = createLimiter(config.maxConcurrent);
  const fetchOpts = { ...config.fetch, resolve: deps.resolve, transport: deps.transport };

  app.addHook("onRequest", async (request, reply) => {
    // Local API only: reject foreign Host headers (DNS rebinding against the API itself).
    if (isLoopbackHost(config.host)) {
      const hostName = (request.headers.host ?? "").replace(/:\d+$/, "");
      if (!isLoopbackHost(hostName)) return reply.code(403).send({ error: "Forbidden host" });
    }
    const origin = request.headers.origin;
    if (origin) {
      if (!config.corsOrigins.includes(origin)) return reply.code(403).send({ error: "Origin not allowed" });
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
