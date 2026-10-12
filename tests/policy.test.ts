import { describe, expect, it } from "vitest";
import { classifyIp, validateDestination, SafeFetchError, DEFAULT_PRIVATE_HOSTS, type NetworkPolicy, type Resolver } from "../packages/safe-fetch/src/index.js";

const pub: NetworkPolicy = { mode: "public", allowedHosts: [], privateHosts: [] };
const local: NetworkPolicy = { mode: "local", allowedHosts: [], privateHosts: DEFAULT_PRIVATE_HOSTS };
const dns = (map: Record<string, string[]>): Resolver => async (h) => {
  if (!map[h]) throw new Error("ENOTFOUND");
  return map[h]!.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof SafeFetchError ? e.code : "other"));

describe("classifyIp", () => {
  it.each([
    ["8.8.8.8", "public"], ["93.184.216.34", "public"], ["2606:4700:4700::1111", "public"],
    ["127.0.0.1", "loopback"], ["127.9.9.9", "loopback"], ["::1", "loopback"],
    ["10.0.0.1", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["172.32.0.1", "public"],
    ["192.168.1.1", "private"], ["100.64.0.1", "private"], ["fd12:3456::1", "private"],
    ["0.0.0.0", "blocked"], ["::", "blocked"], ["169.254.169.254", "blocked"], ["fe80::1", "blocked"],
    ["224.0.0.1", "blocked"], ["ff02::1", "blocked"], ["240.0.0.1", "blocked"], ["255.255.255.255", "blocked"],
    ["192.0.2.1", "blocked"], ["198.18.0.1", "blocked"], ["2001:db8::1", "blocked"], ["fd00:ec2::254", "blocked"],
    ["::ffff:127.0.0.1", "loopback"], ["::ffff:7f00:1", "loopback"], ["::ffff:10.0.0.1", "private"],
    ["::ffff:169.254.169.254", "blocked"], ["::ffff:8.8.8.8", "public"], ["64:ff9b::7f00:1", "loopback"],
    ["2002:0a00:0001::1", "private"], ["not-an-ip", "blocked"]
  ])("%s -> %s", (ip, cls) => expect(classifyIp(ip)).toBe(cls));
});

describe("validateDestination", () => {
  const resolve = dns({
    "example.com": ["93.184.216.34"], "evil.com": ["10.0.0.5"], "mixed.com": ["93.184.216.34", "127.0.0.1"],
    "meta.com": ["169.254.169.254"], "mysite.local": ["127.0.0.1"], "lan.test": ["192.168.1.5"], "m2.test": ["169.254.169.254"]
  });
  const check = (url: string, policy = pub) => code(validateDestination(new URL(url), policy, resolve));

  it("accepts a public destination and returns the address to pin", async () => {
    expect(await validateDestination(new URL("https://example.com/"), pub, resolve)).toEqual({ address: "93.184.216.34", family: 4, all: [{ address: "93.184.216.34", family: 4 }] });
  });
  it("rejects bad schemes and credentials", async () => {
    expect(await check("ftp://example.com/")).toBe("INVALID_URL");
    expect(await check("file:///etc/passwd")).toBe("INVALID_URL");
    expect(await check("https://user:pw@example.com/")).toBe("INVALID_URL");
  });
  it("blocks loopback/private/link-local literals in public mode", async () => {
    for (const u of ["http://127.0.0.1/", "http://[::1]/", "http://10.1.2.3/", "http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://0x7f.1/", "http://2130706433/"])
      expect(await check(u), u).toBe("BLOCKED_DESTINATION");
  });
  it("blocks DNS answers that are prohibited, including mixed public+private", async () => {
    expect(await check("http://evil.com/")).toBe("BLOCKED_DESTINATION");
    expect(await check("http://mixed.com/")).toBe("BLOCKED_DESTINATION");
    expect(await check("http://mixed.com/", { ...local, privateHosts: ["localhost"] })).toBe("BLOCKED_DESTINATION");
  });
  it("reports DNS failure", async () => expect(await check("http://nope.example/")).toBe("DNS_FAILURE"));
  it("public mode ignores LocalWP-style names", async () => {
    expect(await check("http://mysite.local/")).toBe("BLOCKED_DESTINATION");
    expect(await check("http://localhost:10010/")).toBe("DNS_FAILURE"); // not resolvable by the fake DNS, never trusted by name
  });
  it("local mode allows only explicitly listed private hosts", async () => {
    expect(await check("http://mysite.local/", local)).toBe("ok");
    expect(await check("http://127.0.0.1:10010/", local)).toBe("ok");
    expect(await check("http://[::1]:10010/", local)).toBe("ok");
    expect(await check("http://evil.com/", local)).toBe("BLOCKED_DESTINATION"); // private IP behind a non-listed name
    expect(await check("http://10.1.2.3/", local)).toBe("BLOCKED_DESTINATION");
    expect(await check("http://example.com/", local)).toBe("ok");
  });
  it("never allows metadata/link-local, even for allowed private hosts", async () => {
    expect(await check("http://m2.test/", local)).toBe("BLOCKED_DESTINATION");
    expect(await check("http://169.254.169.254/", { ...local, privateHosts: ["169.254.169.254"] })).toBe("BLOCKED_DESTINATION");
  });
  it("enforces the host allowlist with subdomain matching", async () => {
    const p = { ...pub, allowedHosts: ["example.com"] };
    expect(await check("https://example.com/", p)).toBe("ok");
    expect(await check("https://sub.example.com/", p)).toBe("DNS_FAILURE"); // passes the allowlist; the fake DNS has no record
    expect(await check("https://notexample.com/", p)).toBe("BLOCKED_DESTINATION");
  });
});
