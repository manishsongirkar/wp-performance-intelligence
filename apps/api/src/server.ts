import Fastify from "fastify";
import { z } from "zod";
import { auditPage } from "../../../packages/audit-core/src/audit.js";
import { parseUrlCsv } from "../../../packages/url-import/src/csv.js";
import { comparePages } from "../../../packages/site-comparison/src/compare.js";
import { createAuditWorkbook } from "../../../packages/reports/src/xlsx.js";

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 4178);
const allowedHosts = (process.env.WPI_ALLOWED_HOSTS ?? "").split(",").map((v) => v.trim()).filter(Boolean);

const auditSchema = z.object({ url: z.string().url() });
const compareSchema = z.object({ oldUrl: z.string().url(), newUrl: z.string().url() });
const csvSchema = z.object({ csv: z.string().min(1).max(500_000) });
const exportSchema = z.object({ results: z.array(z.unknown()).max(5000) });

app.get("/health", async () => ({ ok: true, name: "wp-performance-intelligence", version: "0.1.0" }));

app.post("/api/audit", async (request, reply) => {
  const parsed = auditSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    const result = await auditPage(parsed.data.url, { allowedHosts: allowedHosts.length ? allowedHosts : undefined });
    return { result };
  } catch (error) {
    request.log.warn({ err: error }, "Audit failed");
    return reply.code(422).send({ error: error instanceof Error ? error.message : "Audit failed" });
  }
});

app.post("/api/compare", async (request, reply) => {
  const parsed = compareSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    const [oldAudit, newAudit] = await Promise.all([
      auditPage(parsed.data.oldUrl, { allowedHosts: allowedHosts.length ? allowedHosts : undefined }),
      auditPage(parsed.data.newUrl, { allowedHosts: allowedHosts.length ? allowedHosts : undefined })
    ]);
    return { result: comparePages(oldAudit, newAudit) };
  } catch (error) {
    request.log.warn({ err: error }, "Comparison failed");
    return reply.code(422).send({ error: error instanceof Error ? error.message : "Comparison failed" });
  }
});

app.post("/api/import/csv", async (request, reply) => {
  const parsed = csvSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
  try {
    return { result: parseUrlCsv(parsed.data.csv) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : "CSV parsing failed" });
  }
});

app.post("/api/export/xlsx", async (request, reply) => {
  const parsed = exportSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "Invalid request", details: parsed.error.flatten() });
  // Export route accepts only server-generated result objects in a future authenticated release.
  // Current MVP validates the request shape but does not trust client-provided values for audit decisions.
  const workbook = await createAuditWorkbook(parsed.data.results as never[]);
  return reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    .header("content-disposition", 'attachment; filename="wpi-audit-report.xlsx"')
    .send(workbook);
});

app.listen({ host, port }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
