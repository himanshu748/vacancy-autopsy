# Vacancy Autopsy

**The internet remembers jobs that employers have already removed.**

**Before you apply, know where the job stands.** Vacancy Autopsy helps applicants follow an advertised opening back to its employer, decide what to check first, and take a useful next step.

The public landing leads into a working local workspace, with no sample listing or simulated verdict. Paste a job link to check its exact ID against Greenhouse, Lever or Ashby. Paste public advertisement text to ask the trained **Tinker** listing reader for candidate employer, role, posting ID and ATS fields. Build a shortlist and ask **TabPFN** which openings to check first; its order is relative priority, never a job-status verdict. Reports lead with the finding and next action; detailed source records remain available when needed.

Tinker fine-tuning and the TabPFN API benchmark have run against real public data. Both the trained Tinker reader and TabPFN Shortlist ranking have run through the real browser workspace. **Render** is the intended host, with no deployment yet. **SerpApi** returns real advertisement leads, **MongoDB Atlas** preserves saved checks across API and worker restarts, and a dedicated **Sentry** project receives content-minimized tool and workflow traces. **Browserbase** has now captured a real advertisement with hash-verified DOM/PNG evidence and confirmed session release. **Auth0** has completed a real Google reviewer login, denied a missing permission, and then recorded a scoped private approval in Atlas. Nine original sponsor technologies have meaningful execution evidence; this is not a claim of nine accepted contest categories or a hosted release. See [sponsor status](docs/SPONSOR-GATES.md).

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
3. Read the verdict and suggested next step. Open the employer posting when it is verified, or inspect the source details when the result needs clarification.
4. Download the JSON report. Each evidence body hashes as UTF-8 text to its stored SHA-256 value.
5. Recheck; the original report remains in Saved checks and the new report links to it.

The listing reader requires the project's private trained-checkpoint configuration. Shortlist ranking requires the project's fitted TabPFN context and dedicated token. Missing configuration produces an explicit unavailable state; no fixture or age-based fallback impersonates either model. Runtime setup and limits are in [ml/README.md](ml/README.md).

Supported forms:

```text
https://job-boards.greenhouse.io/{board}/jobs/{id}
https://boards.greenhouse.io/{board}/jobs/{id}
https://jobs.lever.co/{board}/{uuid}
https://jobs.eu.lever.co/{board}/{uuid}
https://jobs.ashbyhq.com/{board}/{uuid}
```

The example ThinkingMachines Ashby posting in the saved verification evidence was present on October 30, 2026. Its future availability is not guaranteed. Employer custom URLs carrying only `gh_jid`, EU Greenhouse boards, arbitrary job boards, and board-root URLs are currently unsupported and return inconclusive. Submitted posting URLs are canonicalized without query strings or fragments; captured official feed URLs retain the parameters used for that source request. Supplying an official URL alongside a third-party advertisement does not prove the two are related; without an attached validated browser snapshot that report remains inconclusive, while retaining the separate official-source observation. Pasted text is labeled user supplied.

## Optional source and reviewer tools

Expand the source tools to search through SerpApi or capture a supported public advertisement through Browserbase. Results and captures have separate downloadable provenance; they never silently become an investigation verdict. Select **Use this captured posting link** to attach a saved snapshot to a check. The server requires matching source URLs, intact hashes, a snapshot no older than 24 hours and one unique supported ATS identity matching the selected posting. It then checks current availability separately and includes the browser evidence in the private report. A captured link does not prove employer ownership, intent or prior removal. Missing credentials produce an explicit unavailable state without a provider call. See [DISCOVERY.md](docs/DISCOVERY.md) for restrictions and budgets.

Live SerpApi searches returned two advertisement candidates for a Figma query and one advertisement candidate for a Semgrep query. The Figma result was saved, downloaded and hash-checked. Neither search returned an exact first-party posting candidate, so automatic counterpart discovery remains unverified. An initial failure exposed malformed-URL handling; the repair now discards unsafe leads without losing the whole response. Sentry recorded the failure and successful follow-ups without retaining the advertisement, query, credentials or response body. Separate browser requests now have distinct traces, while an investigation keeps its nested verification steps together.

Configured Auth0 reviewers can approve the digest of an evidence-bearing report after reviewing its limitations. Real Google sign-in, missing-permission rejection and a subsequent scoped private approval have passed through the app and persisted in Atlas. That approval stays private. An optional sharing flow, **off by default**, adds a source-only public preview and a separate explicit confirmation before creating a share link. It replays captured official evidence, checks freshness/integrity and matching review digests, excludes private inputs/bodies/reviewer identity, and supports withdrawal. Local generated-JWT and storage tests exercise sharing; a real authorized public release and hosted Auth0 callbacks remain unverified. [AUTH0.md](docs/AUTH0.md) describes the permission, callback and sharing protocol.

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

See [VERIFICATION.md](docs/VERIFICATION.md) for actual checks and browser observations. Synthetic logic tests establish implementation behavior; the following model measurements come from separate real-provider experiments, detailed in [MODEL-EXPERIMENTS.md](docs/MODEL-EXPERIMENTS.md).

| Model experiment | Measured result | Practical limit |
| --- | --- | --- |
| Tinker / Qwen3-8B listing extraction | Exact-record accuracy improved 80% → 100% on 100 unseen Greenhouse validation page-text rows; field micro-F1 0.95 → 1.00 | The 100-row unseen Ashby JSON test tied at 100%. A later exploratory 20-row OppIDX check regressed from base 20/20 to tuned 18/20; the original deterministic validation parser reached 99%. No broad fine-tuned superiority or production accuracy claim |
| TabPFN-3.5 shortlist priority | Test average precision 0.92276 versus 0.89251 for age/logistic baselines; at six checks, 6/17 exact-ID absences and zero false positives versus 5/17 and one false positive | Only 30 retrospective test rows; all 17 negatives were already marked INACTIVE by their publisher. Validation features all tied, with no improvement. This is priority evaluation, not production stale-job accuracy |

The initial Tinker experiment retained all 400 base/tuned comparison outputs with no omitted rows or invalid JSON. Its initial token-plus-seven-day-storage estimate was about $0.5175. A later exploratory third-party check retained another 40 outputs and has a $0.01321434 gross token estimate. The unchanged private checkpoint now expires January 28, 2027, at 10:20 PM IST, with a full 90-day storage estimate of $0.05540784. These are estimates, not a verified final bill. The exploratory failures prompted stricter ATS-format and complete-boundary checks that null invalid ID suggestions; no model retraining or replacement benchmark was performed. TabPFN used one fixed provider prediction and 10,000 quota tokens. The user authorized use of remaining project credits; no card, plan change, purchase or automatic top-up was enabled.

## Persistence and operation

Without MongoDB configuration, reports live under ignored `data/`, using private local files with atomic exclusive writes. History omits response bodies; individual/downloaded reports retain them. A new recheck creates a new report. The local store caps total reports and individual response size rather than deleting evidence automatically. Back up the data directory if the reports matter. There is no automatic retention purge or deletion UI yet.

Copy `.env.example` to `.env` for configuration. Without `MONGODB_URI`, the app uses local files. Setting it selects MongoDB persistence for reports, source artifacts and private approvals, with unique-ID indexes and validated immutable records; connection failure stops startup rather than falling back. The current local app and Temporal worker use a dedicated free Atlas cluster, a database-scoped application user and a single-address network rule, all configured under explicit authorization. The migration preserved 15 reports and two source artifacts with matching hashes. A real browser recheck created a sixteenth report only in Atlas; after restarting both processes again, the archive restored all 16 and downloaded that report unchanged. On November 1 the restored workspace retained 18 reports, a real Browserbase capture and a genuine Auth0 private approval. Indexes, duplicate protection, idempotent migration and an out-of-scope access denial were also verified. See [VERIFICATION.md](docs/VERIFICATION.md) for the receipts.

Network calls are bounded and allowlisted to the documented public ATS APIs, with redirects disabled. Two checks may run concurrently. Read-only ATS calls have per-request and total timeouts, a 2 MB aggregate response budget, and bounded Lever pagination. Host and Origin checks protect the local API against browser DNS rebinding and foreign origins. Credentials and source bodies are excluded from API logs. Submitted public URLs lose query strings/fragments, but pasted text may still contain information you supply: paste public listing content only.

Optional local durable execution uses Temporal around the same investigation; see [TEMPORAL.md](docs/TEMPORAL.md) for server, worker, API, recovery-test, and shutdown instructions. This remains local development evidence, with no Temporal Cloud claim.

Optional development tooling uses Entire CLI 0.12.2 and Graph 0.6.0. See [ENTIRE.md](docs/ENTIRE.md) for setup, parser limits, private checkpoint settings and console sign-in evidence. Current [billing documentation](https://docs.entire.com/billing) requires a verified credit/debit card before granting the $100, 90-day trial. No billing setting, trial credit, hosted agent or session upload was activated here. This tooling does not add a model to the investigation algorithm.

## Challenge scope

New project for the DEV Hacktoberfest Open-Source AI Challenge, Week 4 (event 82), “Ghost in the Machine.” No Arduino or DigitalOcean. The ten sponsor targets and required evidence are in [SPONSOR-GATES.md](docs/SPONSOR-GATES.md). An imported SDK or configured key is not a successful integration. Mastra currently runs a deterministic workflow; it is not a trained extractor or autonomous model agent.

Official written rules say **October 31, 2026, 11:59 PM PDT**, which is **November 1, 2026, 12:29 PM IST**. The event API's `ends_at` instead says `2026-10-31T06:59:00Z` (October 31, 12:29 PM IST), one day earlier. Until clarified, use the earlier time as an internal cutoff; do not represent it as the authoritative written deadline. One project can enter all categories it genuinely uses, but can win only once. Writing quality has the greatest judging weight. A good submission must demonstrate the open-source AI core and actual sponsor use, including the measured model behavior alongside deterministic verification.

Sources checked October 30, 2026: [Week 4 rules](https://dev.to/challenges/hacktoberfest-week4-2026-10-26), [HF26 category requirements](https://dev.to/challenges/hf26), [DEV event API](https://dev.to/api/events/82), [Greenhouse](https://docs.greenhouse.io/job-board.html), [Lever](https://github.com/lever/postings-api), [Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api), [Mastra workflows](https://mastra.ai/docs/workflows/overview).

The user authorized private source delivery to [himanshu748/vacancy-autopsy](https://github.com/himanshu748/vacancy-autopsy). Git history records the earlier delivered revision; current product/model changes are local until separately committed and pushed with authorization. Entire session/checkpoint refs, local evidence, environment secrets and account screenshots stay local. Remaining sponsor credits are authorized for this project; cloud deployment, public publishing, contest submission, card-funded purchases, upgrades and automatic top-up remain separately gated.

## License and attribution

Project code: MIT. Dependencies retain their own licenses. DM Sans, IBM Plex Mono, and Instrument Serif are served locally; their SIL Open Font Licenses are preserved in `public/fonts/`. The user’s approved concept and wording define the product direction; no novelty claim is made about the general ghost-job category.
