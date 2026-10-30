# Verifier implementation notes

The API defaults to `127.0.0.1:8787`. `index.ts` selects local file storage unless `MONGODB_URI` is explicitly set; a failed MongoDB connection stops startup rather than silently switching storage. `DATA_DIR` and `MONGODB_DATABASE` are optional. Public multi-user hosting requires authentication and authorization before exposing these private report routes.

Mastra runs three deterministic steps: resolve a supported posting URL, check its public ATS feed, and prepare a qualified evidence report. No language-model call, autonomous agent behavior, durable recovery, or cloud sponsor verification is implied. All source requests are GETs to a fixed ATS API allowlist, without redirects, with per-request/total timeout, response-size and pagination limits.

Greenhouse absence requires a valid complete feed with `jobs.length === meta.total`; Lever absence requires every bounded page and a final page smaller than 100; duplicate IDs make the result inconclusive. Ashby `isListed: false` means direct-link-only, so it remains inconclusive rather than being called closed. Pasted advertisement text is explicitly user-supplied. Supplying an official URL alongside an arbitrary third-party URL cannot establish that the two advertisements refer to the same job.

Local reports use immutable UUID filenames, restrictive permissions, fsync, and an atomic hard-link publication into the private data directory. History strips source bodies and advertisement text. Downloaded JSON retains source bodies, SHA-256 hashes, capture times, limitations and recheck links. Local storage is a single-process development store capped at 200 reports, not a durable multi-worker deployment database.

Supported input URLs are hosted Greenhouse `/board/jobs/id`, Lever `/board/uuid` (global/EU, optional `/apply`), and Ashby `/board/uuid` (optional `/application`). Custom employer domains with `gh_jid`, embedded Greenhouse query-based URLs, and regional Greenhouse domains are currently unsupported. This is a meaningful coverage limitation: a live Stripe feed exposed a custom `stripe.com/jobs/search?gh_jid=…` URL. Query-based URLs need an explicit, independently established board mapping before they can safely become a supported identity source; the current baseline removes query strings and returns inconclusive.

Primary sources checked on October 30, 2026:

- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html): public GET access, public posting IDs and complete board response.
- [Lever Postings API](https://github.com/lever/postings-api): global/EU endpoints, hosted URLs, `skip`/`limit` pagination.
- [Ashby public Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api): published jobs, job URLs and `isListed` semantics.
- [Mastra workflows](https://mastra.ai/docs/workflows/overview): schema-bound `createStep`/`createWorkflow` execution.

Verification: 14 synthetic contract/failure/API tests passed, and TypeScript checking passed. A separate read-only live Ashby check found the exact ThinkingMachines posting `885f32cc-5b1c-465c-af5a-e88634065bc6` at `2026-10-30T06:23:56.746Z`; this establishes an observation at that time only. MongoDB Atlas, browser capture, model calls and recovery were not tested by this module.

Lever positive checks now use its documented exact-posting endpoint first; a 404 falls back to the complete bounded board check. A 404 alone never establishes absence. This change followed a real full-board timeout; the later live recheck succeeded and preserves the earlier report.
