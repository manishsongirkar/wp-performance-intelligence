# WP Performance Intelligence

Local-first, web-based WordPress performance, SEO, migration comparison and regression intelligence.

## Current status: early MVP foundation

Implemented:
- Local Fastify API: health, URL audit, old/new comparison, CSV import, Excel export.
- Fetched-HTML checks: title, description, canonical, robots, headings, images, links, JSON-LD.
- A network-policy layer for all outbound fetches (`packages/safe-fetch`): connection-time IP validation, manual redirect handling, total deadline, streaming size limit.
- Old-vs-new comparison, CSV URL lists and old/new mappings, validated Excel export.

Not implemented yet: Lighthouse/Playwright/real browser metrics, field Core Web Vitals, bulk jobs, persistent history, source-code mapping, automatic fixes, authenticated multi-user hosting. This is not production-ready and not a PageSpeed Insights replacement.

## Requirements

- Node.js 22 or newer (uses `process.loadEnvFile`)
- pnpm 10 (pinned in `package.json` as `packageManager`)

## Run locally

```bash
pnpm install
cp .env.example .env     # optional; loaded from the directory you start the API in
pnpm dev                 # API on http://127.0.0.1:4178
pnpm dev:web             # dashboard on http://127.0.0.1:5173 (separate terminal)
pnpm audit audit https://example.com out.json   # CLI
```

Checks: `pnpm typecheck` (backend `.ts` and frontend `.tsx`), `pnpm test`, `pnpm build` (type-check + production build of the dashboard). CI (`.github/workflows/ci.yml`) runs all three.

## Configuration (environment or `.env`)

Invalid values stop startup with an error; nothing silently falls back to a weaker setting. Real environment variables override `.env`.

| Variable | Default | Meaning |
|---|---|---|
| `WPI_MODE` | `local` | `local` or `public` (see below) |
| `HOST` / `PORT` | `127.0.0.1` / `4178` | Bind address. A non-loopback `HOST` requires `WPI_MODE=public` and `WPI_API_TOKEN`. |
| `WPI_ALLOWED_HOSTS` | empty | If set, only these hosts and subdomains may be fetched, on every redirect hop |
| `WPI_PRIVATE_HOSTS` | `localhost,*.localhost,*.local,*.test,127.0.0.1,::1` | local mode only: names allowed to resolve to loopback/private addresses |
| `WPI_TIMEOUT_MS` | `15000` | Total deadline per audited URL (connect, redirects, headers, body) |
| `WPI_MAX_BYTES` | `2000000` | Max HTML body size, enforced while streaming |
| `WPI_MAX_REDIRECTS` | `5` | Max redirect hops |
| `WPI_MAX_CONCURRENT` | `4` | Concurrent fetch slots (a comparison uses 2); excess requests get HTTP 429 |
| `WPI_API_TOKEN` | unset | If set (min 16 chars), `/api/*` requires `Authorization: Bearer <token>` |
| `WPI_CORS_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Browser origins allowed to call the API; others get 403 |

## Network modes and security

- **`local` (default, for LocalWP and staging on your machine).** The API only binds to loopback. A hostname may resolve to a loopback/private address only if it matches `WPI_PRIVATE_HOSTS` (so `mysite.local` and `localhost:10010` work). A public name that resolves to a private address is blocked. Link-local/metadata (`169.254.0.0/16`, `fd00:ec2::254`), unspecified, multicast and reserved ranges are always blocked. Requests with a foreign `Host` header or a non-listed browser `Origin` are rejected.
- **`public` (hosted).** Loopback, private, CGNAT, link-local, metadata, multicast and reserved addresses are always blocked; hostname lists never relax this. Requires a token to bind beyond loopback. This is still a single-process service with a shared token: no per-user auth, quotas or worker isolation. Do not call it a secure hosted deployment yet. Private WordPress sites need a future local agent, not a hosted proxy.

How a fetch is enforced: the URL is validated (http/https only, no credentials), the hostname is resolved once, **every** resolved address must pass the policy (mixed public/private answers are rejected), and the connection is then made to that exact validated address, so DNS cannot change between check and use. TLS verification stays on. Redirects are followed manually (limit and loop detection); each hop gets the full policy check before any request. One deadline covers all hops and body reading; the body is cancelled as soon as it exceeds the byte limit. Non-HTML responses are not downloaded.

Known limits: one validated address is used per hop (no fallback to other records); only HTML responses are analysed; there is no per-host rate limiting; the concurrency cap is per process. Only audit sites you are authorized to test.

## API

See [docs/API.md](docs/API.md).

## CSV formats

Single-site crawl:
```csv
url,group,priority
https://example.com/,home,high
https://example.com/about/,pages,medium
```

Old/new mapping:
```csv
old_url,new_url,group,priority
https://old.example.com/,https://new.example.com/,home,high
https://old.example.com/about/,https://new.example.com/about-us/,pages,medium
```

## Safety

- Do not expose this API beyond loopback without reading the network modes above.
- Automatic code changes, patch approval and verification are not implemented. Commits and PRs are always made manually.
