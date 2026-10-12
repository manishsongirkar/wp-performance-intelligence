import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { runLighthouse, summarizeLighthouse } from "../packages/browser-audit/src/lighthouse.js";
import { buildApp } from "../apps/api/src/app.js";
import { loadConfig } from "../apps/api/src/config.js";
import type { LighthouseRun } from "../packages/contracts/src/types.js";

const run = (perf: number | null, lcp: number | null, ok = true): LighthouseRun => ({
  ok, scores: { performance: perf, accessibility: 90, bestPractices: 100, seo: 80 },
  metrics: { fcpMs: 500, lcpMs: lcp, tbtMs: 0, cls: 0, speedIndexMs: 600, ttiMs: 700 }, opportunities: [], runWarnings: [], evidence: {}
});

describe("summarizeLighthouse", () => {
  it("uses medians over successful runs only and skips null values", () => {
    const s = summarizeLighthouse([run(90, 1000), run(70, 3000), run(80, 2000), run(null, null), run(10, 99999, false)]);
    expect(s.performanceScore).toEqual({ median: 80, min: 70, max: 90, samples: 3 });
    expect(s.lcpMs?.median).toBe(2000);
    expect(summarizeLighthouse([run(1, 1, false)])).toEqual({});
  });
});

describe("POST /api/lighthouse", () => {
  const stub = async (url: string) => ({ url, status: "complete" }) as never;
  it("is refused in public mode and validated in local mode", async () => {
    const pub = buildApp(loadConfig({ WPI_MODE: "public" }), { logger: false, lighthouse: stub });
    expect((await pub.inject({ method: "POST", url: "/api/lighthouse", payload: { url: "https://example.com/" } })).json().code).toBe("BROWSER_DISABLED");
    const loc = buildApp(loadConfig({}), { logger: false, lighthouse: stub });
    expect((await loc.inject({ method: "POST", url: "/api/lighthouse", payload: { url: "bad" } })).statusCode).toBe(400);
    expect((await loc.inject({ method: "POST", url: "/api/lighthouse", payload: { url: "https://example.com/" } })).json().result.status).toBe("complete");
  });
});

let hasBrowser = false;
try { hasBrowser = existsSync(chromium.executablePath()); } catch { /* not installed */ }
describe.skipIf(!hasBrowser)("runLighthouse (real Chromium)", () => {
  let server: http.Server; let base: string;
  beforeAll(async () => {
    server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content='width=device-width'><title>T</title></head><body><h1>Hello</h1></body></html>"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => { server.closeAllConnections(); server.close(); });

  it("returns scores, metrics and metadata", async () => {
    const m = await runLighthouse(base, { policy: { mode: "local", allowedHosts: [], privateHosts: ["127.0.0.1"] }, profile: "desktop", runs: 1 });
    expect(m).toMatchObject({ engine: "lighthouse", source: "lab", status: "complete" });
    expect(m.metadata.lighthouseVersion).toMatch(/^\d+\./);
    expect(m.runs[0]!.scores.performance).toBeGreaterThan(0);
    expect(m.runs[0]!.metrics.fcpMs).toBeGreaterThan(0);
    expect(m.summary.performanceScore?.samples).toBe(1);
    expect(m.metadata.settings).toMatchObject({ rttMs: 40, cpuSlowdownMultiplier: 1 });   // Lighthouse desktop preset = PageSpeed Insights desktop
    expect(m.runs[0]!.passedAudits).toBeGreaterThan(0);
  }, 120_000);
  it("uses PageSpeed Insights' mobile lab conditions (simulated slow 4G, 4x CPU slowdown)", async () => {
    const m = await runLighthouse(base, { policy: { mode: "local", allowedHosts: [], privateHosts: ["127.0.0.1"] }, profile: "mobile", runs: 1 });
    expect(m.metadata.throttlingMethod).toBe("simulate");
    expect(m.metadata.settings).toMatchObject({ rttMs: 150, cpuSlowdownMultiplier: 4 });
    expect(m.metadata.settings!.throughputKbps).toBeCloseTo(1638.4, 0);
    expect(m.metadata.settings!.screenWidth).toBe(412);
  }, 120_000);
  it("rejects a blocked target before launching a browser", async () => {
    await expect(runLighthouse(base, { policy: { mode: "public", allowedHosts: [], privateHosts: [] } })).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
  });
});
