# Vacancy Autopsy

**The internet remembers jobs that employers have already removed.**

A job-source investigation desk for people deciding whether to spend time applying. Follow an exact posting ID to its public ATS feed, inspect a timestamped verdict, download the evidence, and recheck without overwriting the original observation.

The local desk verifies first-party postings and preserves their evidence. Optional source search, restricted browser capture, private Auth0 reviewer approval, content-minimized Sentry spans and MongoDB persistence are implemented and tested with synthetic provider contracts. Their live-service acceptance gates remain open. Learned extraction/prioritization and hosted deployment are also unverified. The opening screen is explicitly illustrative.

A real OppIDX advertisement was observed linking to Figma job `6144755004`, while the checked complete Figma feed lacked that ID and the Apply destination redirected to Figma careers. This is a timestamped source mismatch; without an earlier positive observation it does not prove removal, permanent closure or employer intent. See [verification evidence](docs/VERIFICATION.md).

## Run locally

Requires Node.js 22.13+ and npm. Python 3.11+ is sufficient for the dependency-free model preparation tests. Use a fresh terminal in this project directory:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. API: `http://127.0.0.1:8787`. Both listen locally. For the built frontend:

```sh
npm run build
npm start
```

Then open `http://127.0.0.1:8787`. Localhost is the default. Optional hosted mode requires complete Auth0 and MongoDB settings and protects all workspace APIs. It is one private workspace shared by permitted human reviewers, not a multi-tenant service. Deployment remains unauthorized and unverified; see [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Try the journey

1. Copy an individual posting link from a public Greenhouse, Lever, or Ashby board.
2. Submit the URL. The exact ID is checked against the public feed or exact public posting endpoint, through a deterministic Mastra workflow.
3. Inspect the timeline, verdict, capture time, source URL, HTTP status, and SHA-256 fingerprint.
4. Download the JSON report. Each evidence body hashes as UTF-8 text to its stored SHA-256 value.
5. Recheck; the original report remains in the case archive and the new report links to it.

Supported forms:

```text
https://job-boards.greenhouse.io/{board}/jobs/{id}
https://boards.greenhouse.io/{board}/jobs/{id}
https://jobs.lever.co/{board}/{uuid}
https://jobs.eu.lever.co/{board}/{uuid}
https://jobs.ashbyhq.com/{board}/{uuid}
```

The example ThinkingMachines Ashby posting in the saved verification evidence was present on October 30, 2026. Its future availability is not guaranteed. Employer custom URLs carrying only `gh_jid`, EU Greenhouse boards, arbitrary job boards, and board-root URLs are currently unsupported and return inconclusive. Query strings/fragments are discarded before storage. Supplying an official URL alongside a third-party advertisement does not prove the two are related; that report remains inconclusive, while retaining the separate official-source observation. Pasted text is labeled user supplied.

## Optional source and reviewer tools

Expand the source tools to search through SerpApi or capture a supported public advertisement through Browserbase. Results and captures have separate downloadable provenance; they never silently become an investigation verdict. Missing credentials produce an explicit unavailable state without a provider call. See [DISCOVERY.md](docs/DISCOVERY.md) for restrictions and budgets.

Configured Auth0 reviewers can approve the digest of an evidence-bearing report after reviewing its limitations. Approval stays private and does not publish the report. [AUTH0.md](docs/AUTH0.md) describes the permission, callback and server enforcement.

## Read the verdict precisely

| Verdict | Established observation | Limits |
| --- | --- | --- |
| Verified open | Exact posting ID is present in the checked public board or returned by the exact posting API | No hiring-intent, application-review, or future-availability guarantee |
| Not currently listed | ID is absent from a complete validated board response | No proof of fraud, closure, previous existence, or removal |
| Inconclusive | Identity, access, completeness, or source state prevents a supported conclusion | Retry or obtain stronger source evidence |

Unlisted Ashby jobs are inconclusive: a direct-link-only posting may still accept applications. Proving removal requires a previous positive observation. API access errors and oversized, malformed, incomplete, invalid-UTF-8, or unstable paginated feeds never establish absence. No application is submitted and no employer is contacted.

## Validation

```sh
npm run build
npm test
python3 -m unittest discover -s ml/tests -v
```

See [VERIFICATION.md](docs/VERIFICATION.md) for actual results, browser observations, and their limits. [MODEL-EXPERIMENTS.md](docs/MODEL-EXPERIMENTS.md) defines the real-data and benchmark gates. No model accuracy or fine-tuning improvement has been established by the synthetic logic tests.

## Persistence and operation

Default reports live under ignored `data/`, using private local files with atomic exclusive writes. History omits response bodies; individual/downloaded reports retain them. A new recheck creates a new report. The local store caps total reports and individual response size rather than deleting evidence automatically. Back up the data directory if the reports matter. There is no automatic retention purge or deletion UI yet.

Copy `.env.example` to `.env` for configuration. `MONGODB_URI` selects MongoDB persistence for reports, source artifacts and private approvals, with unique-ID indexes and validated immutable records. A connection failure stops startup. Local storage remains the default. Atlas read/write behavior has not been exercised against an actual database. The Atlas connector reported AI-client access disabled for every available organization; an organization owner must enable it before connector access can proceed. No organizational access control was bypassed.

Network calls are bounded and allowlisted to the documented public ATS APIs, with redirects disabled. Two checks may run concurrently. Read-only ATS calls have per-request and total timeouts, a 2 MB aggregate response budget, and bounded Lever pagination. Host and Origin checks protect the local API against browser DNS rebinding and foreign origins. Credentials and source bodies are excluded from API logs. Submitted public URLs lose query strings/fragments, but pasted text may still contain information you supply: paste public listing content only.

Optional local durable execution uses Temporal around the same investigation; see [TEMPORAL.md](docs/TEMPORAL.md) for server, worker, API, recovery-test, and shutdown instructions. This remains local development evidence, with no Temporal Cloud claim.

Optional development tooling uses Entire CLI 0.12.2 and Graph 0.6.0. See [ENTIRE.md](docs/ENTIRE.md) for setup, parser limits, private checkpoint settings and console sign-in evidence. Current [billing documentation](https://docs.entire.com/billing) requires a verified credit/debit card before granting the $100, 90-day trial. No billing setting, trial credit, hosted agent or session upload was activated here. This tooling does not add a model to the investigation algorithm.

## Challenge scope

New project for the DEV Hacktoberfest Open-Source AI Challenge, Week 4 (event 82), “Ghost in the Machine.” No Arduino or DigitalOcean. The ten sponsor targets and required evidence are in [SPONSOR-GATES.md](docs/SPONSOR-GATES.md). An imported SDK or configured key is not a successful integration. Mastra currently runs a deterministic workflow; it is not a trained extractor or autonomous model agent.

Official written rules say **October 31, 2026, 11:59 PM PDT**, which is **November 1, 2026, 12:29 PM IST**. The event API's `ends_at` instead says `2026-10-31T06:59:00Z` (October 31, 12:29 PM IST), one day earlier. Until clarified, use the earlier time as an internal cutoff; do not represent it as the authoritative written deadline. One project can enter all categories it genuinely uses, but can win only once. Writing quality has the greatest judging weight. A good submission must demonstrate the open-source AI core and actual sponsor use, beyond this initial deterministic verifier.

Sources checked October 30, 2026: [Week 4 rules](https://dev.to/challenges/hacktoberfest-week4-2026-10-26), [HF26 category requirements](https://dev.to/challenges/hf26), [DEV event API](https://dev.to/api/events/82), [Greenhouse](https://docs.greenhouse.io/job-board.html), [Lever](https://github.com/lever/postings-api), [Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api), [Mastra workflows](https://mastra.ai/docs/workflows/overview).

The user authorized private source delivery to [himanshu748/vacancy-autopsy](https://github.com/himanshu748/vacancy-autopsy). Git history records the source revisions. Entire session/checkpoint refs, local evidence, environment secrets and account screenshots stay local. Spending, cloud deployment, public publishing and contest submission remain separately gated; none has occurred.

## License and attribution

Project code: MIT. Dependencies retain their own licenses. DM Sans, IBM Plex Mono, and Instrument Serif are served locally; their SIL Open Font Licenses are preserved in `public/fonts/`. The specimen illustration is an original SVG built for this interface. The user’s approved concept and wording define the product direction; no novelty claim is made about the general ghost-job category.
