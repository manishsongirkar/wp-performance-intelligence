# API

JSON over HTTP. Default `http://127.0.0.1:4178`. If `WPI_API_TOKEN` is set, send `Authorization: Bearer <token>` to `/api/*`.

| Endpoint | Request | Success |
|---|---|---|
| `GET /health` | none | `{ ok, name, version }` |
| `POST /api/audit` | `{ "url": "https://example.com/" }` | `{ result: PageAudit }` |
| `POST /api/compare` | `{ "oldUrl": "...", "newUrl": "..." }` | `{ result: ComparisonResult }` |
| `POST /api/import/csv` | `{ "csv": "url\nhttps://example.com/" }` (max 500 KB) | `{ result: { mode, urls, pairs, errors } }` |
| `POST /api/export/xlsx` | `{ "results": [PageAudit \| ComparisonResult] }` (max 5000) | `.xlsx` file |

Types: `packages/contracts/src/types.ts`; export input is validated by `packages/contracts/src/schemas.ts` (string length and array caps). Strings starting with `=`, `+`, `-`, `@` are prefixed with `'` in the workbook to block formula injection.

`PageAudit.redirectChain` lists redirect hops that were followed; `statusCode`/`finalUrl` describe the final response. HTTP 4xx/5xx pages are audited and get an `http.error-status` finding. Non-HTML responses return an audit with no page checks.

## Errors

`{ "error": string, "code"?: string }`. Stack traces and internal details are never returned.

| Status | When |
|---|---|
| 400 | invalid body/URL (`INVALID_URL` for bad scheme or credentials), malformed JSON, bad CSV, invalid export shape |
| 401 | missing/wrong token |
| 403 | `BLOCKED_DESTINATION`, disallowed `Origin` or `Host` |
| 413 | body over 1 MB |
| 422 | `DNS_FAILURE`, `REDIRECT_ERROR` (too many/loop/invalid), `TOO_LARGE` |
| 429 | `BUSY`: concurrency cap reached |
| 502 | `NETWORK`: connection failed or interrupted |
| 504 | `TIMEOUT` |
| 500 | unexpected error (generic message) |
