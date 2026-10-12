import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measurePage, median, summarize } from "../packages/browser-audit/src/measure.js";
import { buildApp } from "../apps/api/src/app.js";
import { loadConfig } from "../apps/api/src/config.js";
import type { BrowserRun } from "../packages/contracts/src/types.js";
import type { NetworkPolicy } from "../packages/safe-fetch/src/index.js";

const run = (o: Partial<BrowserRun> = {}): BrowserRun => ({ ok: true, httpStatus: 200, ttfbMs: 10, fcpMs: 100, lcpMs: 200, lcpElement: null, cls: 0, domContentLoadedMs: 50, loadMs: 80, requestCount: 1, transferBytes: 1000, slowestResources: [], blockedRequests: 0, ...o });

describe("summarize", () => {
  it("computes median/min/max over successful runs only", () => {
    const s = summarize([run({ lcpMs: 100 }), run({ lcpMs: 300 }), run({ lcpMs: 200 }), run({ ok: false, lcpMs: 9999 })]);
    expect(s.lcpMs).toEqual({ median: 200, min: 100, max: 300, samples: 3 });
  });
  it("handles even counts, null metrics and no successful runs", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(summarize([run({ lcpMs: null })]).lcpMs).toBeUndefined();
    expect(summarize([run({ ok: false })])).toEqual({});
  });
});

describe("POST /api/measure", () => {
  const stub = async (url: string) => ({ url, status: "complete" }) as never;
  it("is refused in public mode", async () => {
    const app = buildApp(loadConfig({ WPI_MODE: "public" }), { logger: false, measure: stub });
    const r = await app.inject({ method: "POST", url: "/api/measure", payload: { url: "https://example.com/" } });
    expect(r.statusCode).toBe(403); expect(r.json().code).toBe("BROWSER_DISABLED");
  });
  it("validates input and runs in local mode", async () => {
    const app = buildApp(loadConfig({}), { logger: false, measure: stub });
    expect((await app.inject({ method: "POST", url: "/api/measure", payload: { url: "https://example.com/", runs: 99 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/measure", payload: { url: "https://example.com/" } })).json().result.status).toBe("complete");
  });
});

// Real Chromium against a loopback page. Skipped when no browser is installed.
const hasBrowser = await import("playwright").then((m) => { try { return require("node:fs").existsSync(m.chromium.executablePath()); } catch { return false; } }, () => false);
describe.skipIf(!hasBrowser)("measurePage (real Chromium)", () => {
  let server: http.Server; let base: string;
  const local: NetworkPolicy = { mode: "local", allowedHosts: [], privateHosts: ["127.0.0.1"] };
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/missing") { res.writeHead(404, { "content-type": "text/html" }); return res.end("nope"); }
      if (req.url === "/img.svg") { res.writeHead(200, { "content-type": "image/svg+xml" }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="red"/></svg>'); }
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<html><body><h1>Hello</h1><img id="hero" src="/img.svg" width="400" height="300"><img src="http://10.255.255.1/x.png"></body></html>');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => { server.closeAllConnections(); server.close(); });

  it("measures repeated runs with metadata, summary and the LCP element", async () => {
    const m = await measurePage(`${base}/`, { policy: local, runs: 2, profile: "mobile", timeoutMs: 15_000 });
    expect(m).toMatchObject({ source: "lab", status: "complete", profile: "mobile" });
    expect(m.runs).toHaveLength(2);
    expect(m.metadata).toMatchObject({ viewport: { width: 412 }, throttling: "none", runs: 2 });
    expect(m.summary.lcpMs?.samples).toBe(2);
    expect(m.summary.loadMs?.median).toBeGreaterThan(0);
    expect(m.runs[0]!.lcpElement?.tag).toBeTruthy();
    expect(m.runs[0]!.blockedRequests).toBeGreaterThanOrEqual(1); // 10.255.255.1 is private and blocked in this policy
  }, 60_000);
  it("reports HTTP errors as a failed measurement, not a crash", async () => {
    const m = await measurePage(`${base}/missing`, { policy: local, runs: 1 });
    expect(m.status).toBe("failed"); expect(m.runs[0]!.error).toBe("HTTP 404");
  }, 30_000);
  it("rejects a blocked target before launching a browser", async () => {
    await expect(measurePage(`${base}/`, { policy: { ...local, mode: "public", privateHosts: [] } })).rejects.toMatchObject({ code: "BLOCKED_DESTINATION" });
  });
});
