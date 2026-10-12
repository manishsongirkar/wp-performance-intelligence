import http from "node:http";
import https from "node:https";
import { SafeFetchError, validateDestination, systemResolver, type NetworkPolicy, type Resolver } from "./policy.js";

export interface TransportRequest { url: URL; address: string; family: 4 | 6; headers: Record<string, string>; signal: AbortSignal }
export interface TransportResponse { status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array>; destroy(): void }
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface SafeFetchOptions {
  policy: NetworkPolicy;
  /** Total deadline for all hops, headers and body. */
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Return false to skip downloading the body (e.g. non-HTML). */
  wantBody?: (status: number, headers: Record<string, string>) => boolean;
  resolve?: Resolver;
  transport?: Transport;
}

export interface SafeFetchResult { status: number; headers: Record<string, string>; body: Buffer; finalUrl: string; redirectChain: string[] }

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Connects to the already-validated address, so DNS cannot change between check and use. TLS still verifies the hostname. */
export const nodeTransport: Transport = ({ url, address, family, headers, signal }) =>
  new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || undefined, path: url.pathname + url.search,
      method: "GET", headers, signal, agent: false,
      lookup: (_h, opts, cb) => (opts.all ? (cb as Function)(null, [{ address, family }]) : cb(null, address, family))
    }, (res) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
      resolve({ status: res.statusCode ?? 0, headers: out, body: res, destroy: () => res.destroy() });
    });
    req.on("error", reject);
    req.end();
  });

export async function safeFetch(inputUrl: string, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const { policy, timeoutMs = 15_000, maxBytes = 2_000_000, maxRedirects = 5, wantBody = () => true } = opts;
  const resolve = opts.resolve ?? systemResolver;
  const transport = opts.transport ?? nodeTransport;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let current: TransportResponse | undefined;
  try {
    let url: URL;
    try { url = new URL(inputUrl); } catch { throw new SafeFetchError("INVALID_URL", "Malformed URL."); }
    const chain: string[] = [];
    const seen = new Set<string>([url.href]);
    for (;;) {
      const dest = await validateDestination(url, policy, resolve);
      if (ctl.signal.aborted) throw new SafeFetchError("TIMEOUT", "Request timed out.");
      const res = current = await transport({
        url, ...dest, signal: ctl.signal,
        headers: { "user-agent": "WP-Performance-Intelligence/0.1 (+authorized website audit)", accept: "text/html,*/*;q=0.8" }
      });
      const location = res.headers["location"];
      if (REDIRECTS.has(res.status) && location) {
        res.destroy();
        if (chain.length >= maxRedirects) throw new SafeFetchError("REDIRECT_ERROR", `Too many redirects (limit ${maxRedirects}).`);
        let next: URL;
        try { next = new URL(location, url); } catch { throw new SafeFetchError("REDIRECT_ERROR", "Redirect has an invalid Location."); }
        if (seen.has(next.href)) throw new SafeFetchError("REDIRECT_ERROR", "Redirect loop detected.");
        seen.add(next.href); chain.push(next.href); url = next;
        continue; // the next iteration re-applies the full policy to the new URL
      }
      let body = Buffer.alloc(0);
      if (wantBody(res.status, res.headers)) {
        const declared = Number(res.headers["content-length"]);
        if (declared > maxBytes) { res.destroy(); throw new SafeFetchError("TOO_LARGE", `Response exceeds limit (${maxBytes} bytes).`); }
        const parts: Buffer[] = []; let size = 0;
        for await (const chunk of res.body) {
          size += chunk.byteLength;
          if (size > maxBytes) { res.destroy(); throw new SafeFetchError("TOO_LARGE", `Response exceeds limit (${maxBytes} bytes).`); }
          parts.push(Buffer.from(chunk));
        }
        body = Buffer.concat(parts);
      } else res.destroy();
      return { status: res.status, headers: res.headers, body, finalUrl: url.href, redirectChain: chain };
    }
  } catch (error) {
    current?.destroy();
    if (error instanceof SafeFetchError) throw error;
    if (ctl.signal.aborted) throw new SafeFetchError("TIMEOUT", "Request timed out.");
    throw new SafeFetchError("NETWORK", "Network error while fetching the page.");
  } finally {
    clearTimeout(timer);
  }
}

/** Minimal in-process concurrency cap; callers get 429-style rejection instead of an unbounded queue. */
export function createLimiter(max: number) {
  let active = 0;
  return async <T>(fn: () => Promise<T>, slots = 1): Promise<T> => {
    if (active + slots > max) throw new SafeFetchError("BUSY", "Too many audits in progress; retry shortly.");
    active += slots;
    try { return await fn(); } finally { active -= slots; }
  };
}
