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
pnpm wpi audit https://example.com out.json   # CLI (not "pnpm audit": that is a built-in pnpm command)
pnpm wpi report --audit https://example.com --lighthouse https://example.com   # HTML report on ~/Desktop
```

Checks: `pnpm typecheck` (backend `.ts` and frontend `.tsx`), `pnpm test`, `pnpm build` (type-check + production build of the dashboard). CI (`.github/workflows/ci.yml`) runs all three.

## HTML reports

```bash
pnpm wpi report --audit https://example.com/ --compare https://old.example.com/,https://new.example.com/ \
  --measure https://example.com/ --lighthouse https://example.com/ --runs 3 --profile mobile
```

Writes `~/Desktop/<site>_<YYYY-MM-DD_HH-mm-ss>/` (override the parent with `--out DIR`) containing:
- `report.html`: findings, old/new differences, browser measurements, Lighthouse score summary, and **example fixes with a copy-to-clipboard button on every code block** (generic templates, not verified against your code). All site-derived text is HTML-escaped and the page has a restrictive CSP.
- `lighthouse-N-runM.html`: Lighthouse's own standalone report for each run (same look as Chrome DevTools / PageSpeed).
- `data.json`: the raw results.

**Exact fixes.** For each Lighthouse page the report adds an "Exact fixes for this page" block for LCP, FCP, TBT, unused CSS/JS, images and CLS. The code is built from the measured evidence of that run: the real LCP image URL (preload and `fetchpriority`), the real render-blocking and heavy script files (async/defer lists with sizes), unused CSS/JS files (with a warning when a file is mostly used and must not be dequeued), and the exact image files to convert or regenerate. Fixes are scoped to the audited URL, every site-derived value is allow-listed and escaped before it reaches code, and the generated PHP and bash are syntax-checked in the tests. They are still untested on your site: apply them on staging, then re-run with the baseline.

**Before/after.** `--baseline <previous report folder>` adds deltas to the new report. Each report's "Verify" block contains the exact re-run command. Changes inside the baseline's own min–max range, or too small to matter, are shown as "no clear change".

`--measure` and `--lighthouse` need `WPI_MODE=local` and Chromium (`pnpm exec playwright install chromium`). For LocalWP **https** sites, Node does not trust the LocalWP certificate by default; start with `NODE_USE_SYSTEM_CA=1` so Node uses the macOS keychain (TLS verification stays on).

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
