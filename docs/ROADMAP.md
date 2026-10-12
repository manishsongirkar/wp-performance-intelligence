# Implementation roadmap

## Milestone 0 — Working foundation (current)
- [x] Repository layout and shared audit contracts
- [x] HTML metadata, headings, links, image and JSON-LD checks
- [x] CSV URL and old/new mapping parser
- [x] Initial old/new comparison rules
- [x] Local API and early dashboard
- [x] Excel workbook exporter
- [x] Unit test starter

## Milestone 1 — Reliable fetch and audit safety (in progress; code complete locally, not yet reviewed/merged)
- [x] Connection-time IP validation (resolve once, pin the validated address), redirect policy, deadline covering the body, streaming size limit
- [x] Explicit `local` / `public` modes; loopback bind by default; token required for non-loopback bind
- [x] Startup config validation, `.env` loading, CORS/Host checks, concurrency cap, validated export, formula-injection protection
- [x] Type-check covers `.tsx`; CI workflow; tests for policy, fetch, API, CSV, comparison, export
- [ ] Not done: per-host rate limits, retry/backoff, robots/sitemap discovery, wider audit rule catalog
- [ ] Not done: hosted-grade isolation (separate worker/egress firewall); the in-process policy is defence in depth, not a sandbox

## Milestone 2 — Performance browser engine
- [x] Playwright browser measurement (`/api/measure`, local mode only)
- [x] Lighthouse integration (`/api/lighthouse`: scores, Speed Index, TBT, opportunities; local mode only)
- [x] Desktop/mobile profiles and repeated samples
- [ ] LCP element, resource timing and browser trace artifacts
- [x] HTML report (`pnpm wpi report`) with Lighthouse standalone reports and copyable fix examples
- [x] Evidence-based exact fixes (LCP/FCP/TBT/unused CSS+JS/images/CLS) and `--baseline` before/after deltas
- [x] PageSpeed Insights alignment (same lab conditions, Opportunities/Diagnostics, opt-in PSI API with field data), LCP phase breakdown and what-if experiment, applied-fix detection
- [x] Median/min/max summary with run metadata (browser, viewport, UA, throttling)

## Milestone 3 — Bulk jobs and migration intelligence
- [x] Web UI to run reports in the background (single-job queue), CSV import, JSON/xlsx/HTML export
- [ ] Batch job queue for large URL sets (per-host limits, retries, pause/resume)
- [ ] Per-row status, retries and downloadable failures
- [ ] Redirect validation and URL inventory/coverage
- [ ] Configuration parity imports and intentional-change decisions

## Milestone 4 — Source-aware recommendations
- [ ] WordPress source mapping and confidence labels
- [ ] Structured recommendation contracts
- [ ] Patch proposal generation without file writes
- [ ] Human-readable diff view

## Milestone 5 — Approved fixes and regression
- [ ] Git worktree/branch integration
- [ ] Explicit approval and stale-patch rejection
- [ ] PHP/JS/SCSS lint, build and browser regression
- [ ] Apply/revert events and verified outcome tracking

## Milestone 6 — History and productization
- [ ] SQLite audit history and migrations
- [ ] Historical dashboard graphs
- [ ] Excel/CSV exports from saved runs
- [ ] Authentication, quotas, worker isolation and secure hosted deployment
- [ ] Local agent for LocalWP/private staging
