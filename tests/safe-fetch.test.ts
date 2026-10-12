import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { safeFetch, SafeFetchError, type NetworkPolicy, type Resolver, type Transport } from "../packages/safe-fetch/src/index.js";

const pub: NetworkPolicy = { mode: "public", allowedHosts: [], privateHosts: [] };
const local: NetworkPolicy = { mode: "local", allowedHosts: [], privateHosts: ["app.test", "127.0.0.1"] };
const resolve: Resolver = async (h) => ({ "a.com": ["93.184.216.34"], "b.com": ["93.184.216.35"], "evil.com": ["10.0.0.9"], "app.test": ["127.0.0.1"] }[h] ?? (() => { throw new Error("nx"); })()).map((address) => ({ address, family: 4 }));
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof SafeFetchError ? e.code : `other:${e}`));

/** Mock transport: routes by URL; records every request that was actually made. */
function mock(routes: Record<string, { status?: number; headers?: Record<string, string>; chunks?: string[] }>) {
  const calls: Array<{ url: string; address: string }> = [];
  const transport: Transport = async ({ url, address }) => {
    calls.push({ url: url.href, address });
    const r = routes[url.href]; if (!r) throw new Error("no route " + url.href);
    return { status: r.status ?? 200, headers: r.headers ?? { "content-type": "text/html" }, destroy() {}, body: (async function* () { for (const c of r.chunks ?? ["<html></html>"]) yield Buffer.from(c); })() };
  };
  return { transport, calls };
}
const redir = (to: string, status = 301) => ({ status, headers: { location: to } });

describe("redirects (mock transport)", () => {
  it("follows relative and absolute redirects and records the chain", async () => {
    const m = mock({ "https://a.com/x": redir("/y"), "https://a.com/y": redir("https://b.com/z", 302), "https://b.com/z": {} });
    const r = await safeFetch("https://a.com/x", { policy: pub, resolve, transport: m.transport });
    expect(r.finalUrl).toBe("https://b.com/z");
    expect(r.redirectChain).toEqual(["https://a.com/y", "https://b.com/z"]);
    expect(m.calls.map((c) => c.address)).toEqual(["93.184.216.34", "93.184.216.34", "93.184.216.35"]);
  });
  it.each([
    ["private IP literal", "http://127.0.0.1/admin"], ["metadata", "http://169.254.169.254/"], ["private DNS", "http://evil.com/"],
  ])("blocks redirect to %s without connecting", async (_n, to) => {
    const m = mock({ "https://a.com/": redir(to) });
    expect(await code(safeFetch("https://a.com/", { policy: pub, resolve, transport: m.transport }))).toBe("BLOCKED_DESTINATION");
    expect(m.calls).toHaveLength(1);
  });
  it("blocks redirect to a host outside the allowlist", async () => {
    const m = mock({ "https://a.com/": redir("https://b.com/") });
    expect(await code(safeFetch("https://a.com/", { policy: { ...pub, allowedHosts: ["a.com"] }, resolve, transport: m.transport }))).toBe("BLOCKED_DESTINATION");
  });
  it("rejects non-http redirect schemes and credentials", async () => {
    for (const to of ["file:///etc/passwd", "ftp://a.com/", "javascript:alert(1)", "https://u:p@b.com/"]) {
      const m = mock({ "https://a.com/": redir(to) });
      expect(await code(safeFetch("https://a.com/", { policy: pub, resolve, transport: m.transport })), to).toBe("INVALID_URL");
    }
  });
  it("limits hops and detects loops", async () => {
    const chain: Record<string, any> = {}; for (let i = 0; i < 10; i++) chain[`https://a.com/${i}`] = redir(`/${i + 1}`);
    expect(await code(safeFetch("https://a.com/0", { policy: pub, resolve, transport: mock(chain).transport, maxRedirects: 3 }))).toBe("REDIRECT_ERROR");
    const loop = mock({ "https://a.com/a": redir("/b"), "https://a.com/b": redir("/a") });
    expect(await code(safeFetch("https://a.com/a", { policy: pub, resolve, transport: loop.transport }))).toBe("REDIRECT_ERROR");
  });
  it("rejects malformed URLs", async () => expect(await code(safeFetch("nonsense", { policy: pub, resolve }))).toBe("INVALID_URL"));
});

describe("response handling (real loopback server, local policy)", () => {
  let server: http.Server; let port: number; let aborted = 0;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.on("close", () => { if (!res.writableFinished) aborted++; });
      switch (req.url) {
        case "/ok": res.writeHead(200, { "content-type": "text/html" }); res.end("<html><title>Hi</title></html>"); break;
        case "/json": res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); break;
        case "/404": res.writeHead(404, { "content-type": "text/html" }); res.end("<p>gone</p>"); break;
        case "/500": res.writeHead(500); res.end("boom"); break;
        case "/hang-headers": break;
        case "/hang-body": res.writeHead(200, { "content-type": "text/html" }); res.write("<html>"); break;
        case "/big-chunked": res.writeHead(200, { "content-type": "text/html" }); { const t = setInterval(() => res.write("x".repeat(10_000)), 1); res.on("close", () => clearInterval(t)); } break;
        case "/big-declared": res.writeHead(200, { "content-type": "text/html", "content-length": "5000000" }); res.write("x"); break;
        case "/cut": res.writeHead(200, { "content-type": "text/html", "content-length": "1000" }); res.write("<html>"); setTimeout(() => res.socket?.destroy(), 20); break;
        default: res.writeHead(404); res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => { server.closeAllConnections(); server.close(); });
  const get = (path: string, o: object = {}) => safeFetch(`http://app.test:${port}${path}`, { policy: local, resolve, timeoutMs: 1000, maxBytes: 100_000, ...o });

  it("fetches HTML, connecting to the pinned (validated) address rather than re-resolving", async () => {
    const r = await get("/ok");
    expect(r.status).toBe(200); expect(r.body.toString()).toContain("<title>Hi</title>");
  });
  it("hosted policy refuses the same server", async () => expect(await code(get("/ok", { policy: pub }))).toBe("BLOCKED_DESTINATION"));
  it("returns non-HTML metadata without reading the body when not wanted", async () => {
    const r = await get("/json", { wantBody: () => false });
    expect(r.body.length).toBe(0); expect(r.headers["content-type"]).toBe("application/json");
  });
  it("returns HTTP error statuses instead of throwing", async () => {
    expect((await get("/404")).status).toBe(404); expect((await get("/500")).status).toBe(500);
  });
  it("times out before headers", async () => expect(await code(get("/hang-headers", { timeoutMs: 150 }))).toBe("TIMEOUT"));
  it("times out while consuming the body (deadline is not cleared after headers)", async () => expect(await code(get("/hang-body", { timeoutMs: 200 }))).toBe("TIMEOUT"));
  it("aborts an oversized chunked response and cancels the connection", async () => {
    const before = aborted;
    expect(await code(get("/big-chunked", { maxBytes: 50_000 }))).toBe("TOO_LARGE");
    await new Promise((r) => setTimeout(r, 100));
    expect(aborted).toBeGreaterThan(before);
  });
  it("rejects oversized declared Content-Length early", async () => expect(await code(get("/big-declared"))).toBe("TOO_LARGE"));
  it("maps an interrupted stream to a safe error", async () => expect(await code(get("/cut"))).toBe("NETWORK"));
  it("maps connection refusal to a safe error", async () => {
    const r = await code(safeFetch("http://app.test:1/", { policy: local, resolve, timeoutMs: 1000 }));
    expect(r).toBe("NETWORK");
  });
});
