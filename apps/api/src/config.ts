import { z } from "zod";
import { DEFAULT_PRIVATE_HOSTS, type NetworkPolicy } from "../../../packages/safe-fetch/src/index.js";

const list = (fallback: string[] = []) => z.string().optional().transform((v) => (v === undefined ? fallback : v.split(",").map((s) => s.trim()).filter(Boolean)));
const int = (min: number, max: number, def: number) => z.coerce.number().int().min(min).max(max).default(def);

const envSchema = z.object({
  WPI_MODE: z.enum(["local", "public"]).default("local"),
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: int(1, 65535, 4178),
  WPI_ALLOWED_HOSTS: list(),
  WPI_PRIVATE_HOSTS: list(DEFAULT_PRIVATE_HOSTS),
  WPI_TIMEOUT_MS: int(1000, 120_000, 15_000),
  WPI_MAX_BYTES: int(10_000, 20_000_000, 2_000_000),
  WPI_MAX_REDIRECTS: int(0, 10, 5),
  WPI_MAX_CONCURRENT: int(1, 32, 4),
  WPI_API_TOKEN: z.string().optional(),
  WPI_CORS_ORIGINS: list(["http://127.0.0.1:5173", "http://localhost:5173"])
});

export interface Config {
  host: string; port: number; token?: string; corsOrigins: string[]; maxConcurrent: number;
  fetch: { policy: NetworkPolicy; timeoutMs: number; maxBytes: number; maxRedirects: number };
}

export const isLoopbackHost = (h: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(h);

/** Loads `.env` from the working directory (real environment variables win). Missing file is fine. */
export function loadDotEnv(): void {
  try { process.loadEnvFile(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
}

/** Throws a readable Error on any invalid value: the process must not start with a weaker policy than configured. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = parsed.data;
  const token = e.WPI_API_TOKEN || undefined;
  if (!isLoopbackHost(e.HOST)) {
    if (e.WPI_MODE !== "public") throw new Error("Binding to a non-loopback HOST requires WPI_MODE=public.");
    if (!token || token.length < 16) throw new Error("Binding to a non-loopback HOST requires WPI_API_TOKEN (at least 16 characters).");
  }
  return {
    host: e.HOST, port: e.PORT, token, corsOrigins: e.WPI_CORS_ORIGINS, maxConcurrent: e.WPI_MAX_CONCURRENT,
    fetch: {
      policy: { mode: e.WPI_MODE, allowedHosts: e.WPI_ALLOWED_HOSTS, privateHosts: e.WPI_MODE === "local" ? e.WPI_PRIVATE_HOSTS : [] },
      timeoutMs: e.WPI_TIMEOUT_MS, maxBytes: e.WPI_MAX_BYTES, maxRedirects: e.WPI_MAX_REDIRECTS
    }
  };
}
