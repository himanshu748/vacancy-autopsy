# Ten sponsor targets — evidence before entry

Checked against [the HF26 hub](https://dev.to/challenges/hf26) and [Week 4 (event 82)](https://dev.to/challenges/hacktoberfest-week4-2026-10-26) on October 30, 2026. All ten categories below are listed. A project can qualify for several, but can win only once per challenge. Category eligibility is not a claim that this build meets the category's acceptance standard.

| Target | Current implementation | Required successful evidence before claiming |
| --- | --- | --- |
| Tinker · $200 | Opt-in runner, real corpus and local SDK/tokenizer preflight verified; no provider run | Real reviewed examples, frozen unseen-employer/template holdout, successful Tinker checkpoint, base-vs-tuned exact ID/employer/field metrics and token/cost receipt; demonstrate clear improvement |
| TabPFN · $200 | Schema, holdout, baselines, metrics and opt-in API runner prepared; provider runner unexecuted | Real independent first-party labels, pre-verification features, successful prediction call in priority workflow, comparisons to age/logistic baselines, AP/recall at fixed budget/FPs, quota receipt |
| Render · $200 | Built frontend/API and optional authenticated hosted mode prepared; private source remote configured; no deployment | Authorized hosted app and real judge journey on Render, persistent storage/worker setup, resource limits and verified free-credit behavior |
| SerpApi · $100 | Bounded discovery, private projection persistence/download and UI implemented; synthetic contracts passed; no live query | Successful live discovery query returning advertisement and candidate official source; preserve search provenance and actual source URLs; snippet alone is not a browser observation |
| Browserbase · $100 | Restricted static CDP capture, DOM/PNG hashes, cleanup and UI implemented; synthetic contracts passed; no live session | Successful remote browser visit and saved capture of an advertisement/application state; access restrictions respected; source-to-ATS linkage established independently |
| Mastra · $100 | Deterministic workflow executes resolve → check → report, tested locally | Already exercises the harness; strengthen with the open-model extraction/verification agent path and demonstrate that the open components enable the core capability. Organizer qualification is not asserted from workflow use alone |
| Temporal · $100 | Local durable execution and worker-crash recovery verified; see TEMPORAL.md | Real worker termination/restart receipt, preserved workflow history, same saved report, bounded retries, no duplicate evidence writes |
| MongoDB Atlas · $100 | Immutable report, source-artifact and approval adapters tested against synthetic driver contracts; no live database | Authorized Atlas read/write and restart receipt, indexes and private-workspace access validation. Atlas connector access is disabled by every available organization; an owner must enable it |
| Sentry Agent Tracing · $100 | Explicit content-minimized workflow/tool/approval spans and failure classification tested using the real SDK with an offline transport; no provider trace | A real trace of tool/model/browser execution, failures, latency and available token/cost data; provider trace link/screenshot and a demonstrated debugging finding |
| Auth0 for AI Agents · $100 | RS256/JWKS authorization, PKCE browser interface, hosted workspace gate and digest-bound private approvals implemented; synthetic enforcement tests passed; no tenant login or public publisher | Actual authenticated agent/reviewer flow, permission enforced by server, report digest bound to approval, unauthorized and changed-report rejection, approved public-release test using non-accusatory reviewed evidence |

## Browser account observations

From the signed-in Hacktoberfest offers page, not from inferred billing state:

- Tinker promotional codes were exhausted. Google sign-in subsequently succeeded using the requested account; its balance page was inspected with auto-reload disabled. Private balance values are omitted from shareable source. No key was created and no model run was started.
- Browserbase's one-month Developer promo requires a card. The page says the separate Free plan needs no code. No paid plan or card was enabled.
- Browserbase was revisited in the existing signed-in Free account. Its only project slot is occupied by Personal project; New project is disabled (zero available). Its existing project key was not revealed or reused, and no upgrade was made. A dedicated authorized credential/project remains blocked.
- Render advertised $50 credit. No redemption, paid resource, or deployment occurred.
- Prior Labs was already signed in. Its usage page was inspected, but point-in-time quotas are not a future billing guarantee. No API request or key creation occurred here.
- Prior Labs local-model licenses showed “Not accepted.” No license was accepted and no weights were downloaded. The prepared API runner avoids a local-weight dependency.
- Entire console sign-in succeeded through GitHub after Google returned an email collision. The latest billing inspection did not establish a trial grant. No billing setting was changed. Current [Entire billing documentation](https://docs.entire.com/billing) requires card verification for the $100, 90-day trial; no trial was activated by this project. CLI sessions remain local and unsynced.

## Fourteen release gates

- [x] Fix the product direction, user and qualified verdict semantics.
- [x] Verify current Week 4 rules, prize limits, and deadline discrepancy.
- [x] Implement exact supported ATS identity and bounded complete-feed checks.
- [x] Preserve downloadable evidence with timestamps and hashes.
- [x] Persist reports and recheck without overwriting prior observations.
- [x] Exercise the actual UI against a real public first-party source.
- [x] Capture a real advertisement with an explicit ATS link and check the linked ID against a complete employer feed. The OppIDX/Figma case establishes a current mismatch; prior removal remains unproven.
- [ ] Assemble a sufficiently large real labeled corpus with employer/template holdouts.
- [ ] Complete Tinker training and demonstrate baseline improvement.
- [ ] Complete TabPFN evaluation against baselines and use its ranking in the app.
- [x] Pass the local Temporal crash/restart test; record actual result in TEMPORAL.md.
- [ ] Verify Atlas, Browserbase, SerpApi and Sentry with actual service receipts.
- [ ] Verify Auth0 approval and an authorized persistent Render deployment.
- [ ] Write the evidence-backed DEV entry, review category claims and publish under explicit authorization.

The real extraction corpus has 297 rows with disjoint employer/template splits, but 197 inputs are native API JSON and deterministic validation already reaches 99% exact-record accuracy. It is not a representative messy-ad benchmark or a both-class priority dataset. Tinker SDK compatibility is verified locally; 4,096-token context is insufficient for many rows, and every planned stage exceeds the default 100,000-token ceiling. No fine-tune, model comparison or TabPFN prediction ran. See [MODEL-EXPERIMENTS.md](MODEL-EXPERIMENTS.md).

Checkboxes indicate observed work only. A completed local or synthetic test never substitutes for a live-provider acceptance gate. The eight-sponsor minimum remains unmet until eight integrations have successful meaningful runs. Do not claim eight or ten today.

## Additional Entire development target

Entire was requested after the original ten. CLI 0.12.2, Graph 0.6.0, a real code query and private Codex hook configuration have been exercised; see [ENTIRE.md](ENTIRE.md). Captured checkpoint/search evidence and a reviewed shareable session artifact must be verified before claiming that category. Console login does not establish CLI authentication or permission to upload sessions. No hosted Trail, trial credit or token-saving result is claimed. This does not increase the count of working investigation integrations.

## Recommended next dependency

Preserve the OppIDX/Figma observation and rerun the official check at demo time; feed state may change. Next, obtain project-specific authorized credentials and one real service receipt for each prepared adapter. Independently labeled negative examples are required before TabPFN evaluation. Reconsider Tinker training until a representative corpus has room to improve over the deterministic baseline; do not spend credits simply to add a category. The private source remote is configured. Render still requires deployment authorization and configured Auth0/MongoDB. An honest article can describe a current advertisement/source mismatch, while keeping removal and employer-intent claims out of the finding.
