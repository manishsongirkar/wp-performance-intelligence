# WP Performance Intelligence

Local-first, web-based WordPress performance, SEO, migration comparison and regression intelligence.

## Current status: early MVP foundation

This repository currently provides:
- A local Fastify API with a health endpoint and URL audit endpoint.
- Rendered HTML checks for title, description, canonical, robots, headings, images, links and JSON-LD.
- CSV parsing for URL lists and explicit old/new URL mappings.
- Old-vs-new rendered-page comparison for selected SEO and content signals.
- JSON results and an Excel export endpoint.
- Initial tests for CSV parsing and comparison rules.

Performance metrics from Lighthouse/Playwright, a polished dashboard, persistent audit history, private-site agent and approved code patch workflow are planned next. Do not treat the current audit output as a complete PageSpeed Insights replacement.

## Requirements

- Node.js 22 LTS recommended
- pnpm 10+
- Chromium installation for later browser-audit features

## Run locally

```bash
pnpm install
cp .env.example .env
pnpm dev
```

The API listens on `http://127.0.0.1:4178` by default.

## API endpoints

- `GET /health`
- `POST /api/audit` with JSON `{ "url": "https://example.com" }`
- `POST /api/compare` with JSON `{ "oldUrl": "https://old.example.com", "newUrl": "https://new.example.com" }`
- `POST /api/import/csv` with JSON `{ "csv": "old_url,new_url\\n..." }`
- `POST /api/export/xlsx` with JSON `{ "results": [...] }`

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

This is an early development scaffold. Before exposing it publicly:
- Add a robust SSRF policy with DNS/IP validation at connection time and on every redirect.
- Add authentication, quotas, job isolation, upload size limits and persistent job storage.
- Do not expose private/local sites to a hosted service; use a locally installed agent for that.
- Do not automatically apply code changes. Patch approval and verification are not implemented yet.
- Use only URLs and environments you are authorized to audit.
