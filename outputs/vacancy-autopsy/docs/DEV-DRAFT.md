# The advertisement was still there. Its Apply link led back to careers.

Unpublished working draft. Category claims and hosted/model evidence remain incomplete; this is not a submitted challenge entry.

Applying for a job takes more than a click. You read the description, reshape a résumé, write a note, and then discover that the original opening is no longer easy to find.

Vacancy Autopsy starts with a narrower question than whether a job is “fake”: **can this exact advertised opening still be verified at its original source?**

## A real, qualified finding

On October 30, an [OppIDX advertisement](https://www.oppidx.com/opportunities/brand-design-intern-summer-2027-figma-0kjy3o) displayed “Brand Design Intern (Summer 2027),” attributed to Figma. Its Apply link included Greenhouse job ID `6144755004`.

I inspected the advertisement in a browser and followed the Apply link. It redirected to Figma's careers page. Then I submitted the original URL to Vacancy Autopsy. The public Greenhouse feed returned 141 postings; that exact ID was absent. The app saved a **Not currently listed** report, including the response, timestamp and SHA-256 fingerprint. Recheck created a new observation and preserved the original.

That is evidence of a current mismatch. It does not establish that the employer previously removed the posting, permanently closed the role, or never intended to hire. I have no earlier positive observation for this ID. The advertisement linkage was manually inspected; it was not automatically established by a paid browser service.

Those qualifications are part of the product. If a feed times out, is partial, or cannot be validated, absence becomes **Inconclusive**. An old advertisement that still matches an active posting becomes **Verified open**. Age alone never supplies a verdict.

## Receipts instead of a confidence score

The working journey is one URL, an evidence timeline, three verdicts, a JSON download and a recheck. The opening illustration is labeled as an example. Real reports stay private.

Greenhouse, Lever and Ashby provide structured public posting sources. The verifier resolves exact identity, makes bounded requests and checks complete validated responses. It keeps source bodies and hashes in the saved report, while history contains compact references. Arbitrary user-supplied advertisement/source pairs remain inconclusive because supplying two URLs does not prove their relationship.

Mastra coordinates the deterministic resolve → check → report workflow. Temporal provides optional durable execution around it. I tested the difficult boundary: kill a worker after evidence was saved but before its activity completed, restart it, and verify that the same report returns without fetching the source again. The real local Temporal test passed with a synthetic source fixture, one saved report, one fetch and successful history replay. It is recovery evidence, separate from the live job finding.

## What the other integrations actually do

The current source also implements bounded SerpApi discovery, restricted Browserbase page capture, MongoDB artifact/approval storage, content-minimized Sentry spans and Auth0 reviewer approval. Their tests use synthetic provider contracts. Live service receipts are still missing, so I am not claiming those sponsor categories yet.

Hosted mode is prepared for one private shared reviewer workspace, with server-enforced JWT permission checks and persistent MongoDB. It has not been deployed to Render. An approval binds a reviewer to the exact report digest and remains private; there is no autonomous public publisher.

## The model experiment challenged the plan

I prepared 297 real extraction records across six employers and froze disjoint employer/template partitions. But 197 inputs are structured API JSON, and a deterministic validation baseline already achieved 99% exact-record accuracy on the clean validation set. That is not a strong reason to spend credits fine-tuning a model.

The local Tinker SDK and real tokenizer preflight work. Training and base-versus-tuned evaluation have not run. TabPFN still needs a defensible dataset containing both independently verified priority classes; active API postings cannot manufacture missing negative examples. Neither model powers the live app today.

The useful next experiment is a representative messy-ad corpus and an evaluation that measures improvement over the simple verifier. If the models do not earn their complexity, the evidence should say so.

## What is verified today

The current local checks passed: strict types/build, 64 TypeScript tests, 47 Python tests, a separate real Temporal crash/recovery test, browser downloads/rechecks, and matching downloaded evidence hashes. Ordinary tests skip the server-dependent recovery test, which runs separately.

The source and setup instructions are reviewable locally. Live provider setup, learned-model results, final mobile regression, hosted access/persistence and publication remain open gates. No successful SDK import, polished screen or proposed integration substitutes for those receipts.

Vacancy Autopsy does not decide an employer's intent. It helps an applicant follow a specific opening back to the evidence before spending another evening applying.

Primary API references: [Greenhouse](https://docs.greenhouse.io/job-board.html), [Lever](https://github.com/lever/postings-api), [Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api). Reproducible checks and limits: [VERIFICATION.md](VERIFICATION.md), [MODEL-EXPERIMENTS.md](MODEL-EXPERIMENTS.md), [SPONSOR-GATES.md](SPONSOR-GATES.md).
