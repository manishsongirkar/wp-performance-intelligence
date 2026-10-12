# Implementation roadmap

## Milestone 0 — Working foundation (current)
- [x] Repository layout and shared audit contracts
- [x] HTML metadata, headings, links, image and JSON-LD checks
- [x] CSV URL and old/new mapping parser
- [x] Initial old/new comparison rules
- [x] Local API and early dashboard
- [x] Excel workbook exporter
- [x] Unit test starter

## Milestone 1 — Reliable fetch and audit safety
- [ ] Connection-time SSRF protection and redirect policy
- [ ] Content length/time limits enforced while streaming
- [ ] Retry/backoff and per-host concurrency controls
- [ ] Robots/sitemap discovery with crawl budgets
- [ ] Expand fixture coverage and audit rule catalog

## Milestone 2 — Performance browser engine
- [ ] Playwright and Lighthouse integration
- [ ] Desktop/mobile profiles and repeated samples
- [ ] LCP element, resource timing and browser trace artifacts
- [ ] Median/variance comparison with reproducibility metadata

## Milestone 3 — Bulk jobs and migration intelligence
- [ ] CSV upload UI and batch job queue
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
