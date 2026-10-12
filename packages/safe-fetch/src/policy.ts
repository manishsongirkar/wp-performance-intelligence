import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export type NetworkMode = "local" | "public";

export interface NetworkPolicy {
  mode: NetworkMode;
  /** If non-empty, only these hosts (and their subdomains) may be fetched, on every hop. */
  allowedHosts: string[];
  /** local mode only: hosts allowed to resolve to loopback/private addresses. `*.` prefix is optional. */
  privateHosts: string[];
}

export const DEFAULT_PRIVATE_HOSTS = ["localhost", "*.localhost", "*.local", "*.test", "127.0.0.1", "::1"];

export type SafeFetchErrorCode =
  | "INVALID_URL" | "BLOCKED_DESTINATION" | "DNS_FAILURE" | "TIMEOUT"
  | "REDIRECT_ERROR" | "TOO_LARGE" | "NETWORK" | "BUSY";

export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string) { super(message); this.name = "SafeFetchError"; }
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export const systemResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

export type IpClass = "public" | "private" | "loopback" | "blocked";

function parseIPv4(ip: string): number[] { return ip.split(".").map(Number); }

function parseIPv6(ip: string): number[] {
  let s = ip.split("%")[0]!.toLowerCase();
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = parseIPv4(v4[1]!) as [number, number, number, number];
    s = s.slice(0, -v4[1]!.length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - h.length - t.length).fill("0");
  const groups = [...h, ...fill, ...t].map((g) => parseInt(g || "0", 16));
  return groups.flatMap((g) => [g >> 8, g & 255]); // 16 bytes
}

function classifyV4([a, b, c]: number[]): IpClass {
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127)) return "private";
  if (a === 0 || a === 169 && b === 254 || a! >= 224) return "blocked"; // unspecified, link-local/metadata, multicast, reserved, broadcast
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "blocked";
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return "blocked";
  if (a === 203 && b === 0 && c === 113) return "blocked";
  return "public";
}

/** Classifies a literal IP. Unknown or malformed input is "blocked" (fail closed). */
export function classifyIp(ip: string): IpClass {
  const family = isIP(ip);
  if (family === 4) return classifyV4(parseIPv4(ip));
  if (family !== 6) return "blocked";
  const b = parseIPv6(ip);
  const zeros = (n: number) => b.slice(0, n).every((x) => x === 0);
  if (zeros(15) && b[15] === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address.
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return classifyV4(b.slice(12));
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return classifyV4(b.slice(12));
  if (b[0] === 0x20 && b[1] === 0x02) return classifyV4(b.slice(2, 6));
  if (b[0] === 0xfd && b[1] === 0 && b[2] === 0x0e && b[3] === 0xc2) return "blocked"; // AWS IPv6 metadata fd00:ec2::254
  if ((b[0]! & 0xfe) === 0xfc) return "private"; // fc00::/7
  if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0 && b[3] === 0) || (b[2] === 0x0d && b[3] === 0xb8))) return "blocked"; // Teredo, documentation
  if ((b[0]! & 0xe0) !== 0x20) return "blocked"; // only 2000::/3 is global unicast
  return "public";
}

const bare = (h: string) => h.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

export function hostMatches(hostname: string, list: string[]): boolean {
  const host = bare(hostname);
  return list.some((entry) => { const e = bare(entry.replace(/^\*\./, "")); return host === e || host.endsWith(`.${e}`); });
}

/**
 * Validates a URL against the policy and resolves it. The returned address is the one the
 * connection MUST use (see fetch.ts), which is what defeats DNS rebinding.
 */
export async function validateDestination(url: URL, policy: NetworkPolicy, resolve: Resolver = systemResolver): Promise<{ address: string; family: 4 | 6 }> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("INVALID_URL", "Only HTTP and HTTPS URLs are supported.");
  if (url.username || url.password) throw new SafeFetchError("INVALID_URL", "URLs containing credentials are not allowed.");
  const host = bare(url.hostname);
  if (!host) throw new SafeFetchError("INVALID_URL", "URL has no hostname.");
  if (policy.allowedHosts.length && !hostMatches(host, policy.allowedHosts)) {
    throw new SafeFetchError("BLOCKED_DESTINATION", `Host ${host} is not in the configured allowlist.`);
  }
  const literal = isIP(host);
  let addresses: Array<{ address: string; family: number }>;
  if (literal) addresses = [{ address: host, family: literal }];
  else {
    try { addresses = await resolve(host); } catch { throw new SafeFetchError("DNS_FAILURE", `Could not resolve ${host}.`); }
    if (!addresses.length) throw new SafeFetchError("DNS_FAILURE", `Could not resolve ${host}.`);
  }
  const mayBePrivate = policy.mode === "local" && hostMatches(host, policy.privateHosts);
  for (const { address } of addresses) {
    const cls = classifyIp(address);
    if (cls === "public" || (mayBePrivate && (cls === "private" || cls === "loopback"))) continue;
    throw new SafeFetchError("BLOCKED_DESTINATION", `Host ${host} resolves to a disallowed address.`);
  }
  const first = addresses[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}
