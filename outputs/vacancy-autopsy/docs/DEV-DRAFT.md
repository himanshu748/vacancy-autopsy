---
title: "The listing is still here. Is the job? Building Vacancy Autopsy."
published: false
tags: devchallenge, hf26challenge
---

# The listing is still here. Is the job?

## What I Built

Applying for a job takes more than a click. You read the description, reshape a résumé, write a note, and then discover that the original opening is no longer easy to find.

Vacancy Autopsy puts a small check before that investment: **can this exact advertised opening still be verified at its employer?**

The landing page says what the product helps you do: “Before you apply, know where the job stands.” Open the workspace, paste a job link, and get a finding with a useful next action. A verified opening links back to its employer. An absent ID tells you what was checked and when. An uncertain match asks for stronger source information. Source details and downloads are available behind the finding, rather than becoming the whole product.

My interpretation of “Ghost in the Machine” is a listing that outlives the source it points to. The useful question is not whether an employer is dishonest. It is whether an applicant can still find this exact opening at its original source.

## Demo

The source release includes a runnable local demo. Render hosting remains pending; there is no public SaaS URL or video in this submission.

```sh
git clone https://github.com/himanshu748/vacancy-autopsy.git
cd vacancy-autopsy/outputs/vacancy-autopsy
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:8787`. Paste a supported Greenhouse, Lever or Ashby posting URL to exercise the core source verifier, saved checks and evidence downloads. This path needs no sponsor credentials. Model extraction, ranking, remote capture and reviewer sign-in require separately configured provider access; the private trained checkpoint is not distributed. See the [setup guide](https://github.com/himanshu748/vacancy-autopsy/blob/main/outputs/vacancy-autopsy/README.md).

In my configured local workspace, the real product has also exercised capture → exact ATS link → complete employer feed, refreshed-snapshot rechecks, and Auth0 permission-denial/private-approval. It holds 20 saved investigations. These provider-backed journeys are described below with their limits; a clean checkout does not inherit my accounts or credentials.

The Semgrep example was verified open at its recorded check time; the Figma example below demonstrates an advertised-source mismatch. These are timestamped observations, not promises that either source remains unchanged when a judge revisits it.

## Code

[Source code and setup instructions](https://github.com/himanshu748/vacancy-autopsy), licensed under MIT. A [source-only ZIP](https://github.com/himanshu748/vacancy-autopsy/releases/download/hf26-v1/vacancy-autopsy.zip) accompanies the release. Credentials, private model checkpoints, account captures, local observations and agent-session transcripts are excluded. The fine-tuned checkpoint is private; reproducing training or hosted inference requires the reader's own provider access.


## How I Built It

### Three pieces of the product

**Read the listing with Tinker.** Public advertisements can bury the employer, full role title, ATS and posting ID inside a page of unrelated text. I fine-tuned Qwen3-8B to return those four fields, and connected the private checkpoint to the workspace's “Read listing details” action. A real browser run extracted Figma, Brand Design Intern (Summer 2027), Greenhouse and posting ID `6144755004` from captured public advertisement text. Extracted fields are suggestions; the model cannot declare a job open or closed.

**Choose the next check with TabPFN.** A shortlist lets an applicant compare several openings before investigating them. TabPFN ranks rows using only information available before an official check, including known listing age, repost count, source type and visible ATS-link information. Unknown information stays unknown. The interface shows a relative order, with shared ranks for ties, rather than presenting a model score as the probability that an employer is dishonest. A real browser run ranked two genuine public advertisements, opened the selected URL in the check form, and preserved the shortlist when returning from that check.

**Make the workflow available with Render.** The built frontend, API and durable worker are prepared for hosting, but I have not deployed the service. The existing Render workspace has hackathon credit and is at its service quota. A persistent, authenticated hosted journey remains a release gate. A local app is not being presented as a live Render service.

### What the models actually improved

Tinker training used 97 public Lever records for one epoch. Employers and actual ATS families were disjoint between training, validation and test.

On 100 unseen Greenhouse validation page-text rows, exact-record accuracy rose from **80% to 100%** and field micro-F1 from **0.95 to 1.00**. The 20 corrected errors were shortened titles: the tuned model preserved location qualifiers that the base model dropped. Exact posting ID and employer accuracy were already 100%.

The single frozen, 100-row Ashby native-JSON test was a **100% versus 100% tie**. All 400 base/tuned comparison outputs were retained, including zero invalid JSON responses or omitted rows. A separate deterministic validation parser already reached 99%, so the practical gain on these clean sources is much smaller than the base-model comparison alone suggests. Representative third-party advertisement accuracy is still unestablished.

A later exploratory check on 20 complete OppIDX captures exposed a regression: **base 20/20 versus fine-tuned 18/20 exact records**. The tuned model returned a page slug instead of the numeric Greenhouse ID twice. All 40 outputs were retained. These job IDs were absent from the original partitions, but the employers overlapped validation; this was not a new preregistered unseen-employer test. I did not retrain or tune against it. Instead, the product now rejects candidate IDs that fail the ATS format or complete-boundary grounding checks. That is an input-validation repair, not a claim that model accuracy improved.

The initial experiment's token-plus-seven-day-storage estimate was about **$0.5175**; the exploratory check adds a **$0.01321434** gross token estimate. The unchanged private checkpoint now expires **January 28, 2027, at 10:20 PM IST**, with a full 90-day storage estimate of **$0.05540784**. These are estimates before a verified final invoice. No top-up or paid-plan change was enabled.

For TabPFN, 132 public records were labeled using independent first-party verification and a separate AI-agent evidence review, not human review. Features were captured before verification. The frozen employer/template split contained 82 training, 20 validation and 30 test rows. The model never received the final official result as a feature.

With fixed TabPFN-3.5 settings, test **average precision was 0.92276**, versus **0.89251** for both the age heuristic and logistic regression. Within a six-check budget, TabPFN selected **six of 17 exact-ID absences with zero false positives**; the baselines selected five with one false positive. One provider prediction used 10,000 quota tokens.

This is a small retrospective demonstration. All 17 test negatives were already marked INACTIVE by the publisher, so they are not discoveries of unmarked stale ads. The validation feature vectors all tied, and every method had AP 0.65 with no improvement. Average precision is reported as AP, not trapezoidal PR-AUC. None of these results establishes production accuracy or employer intent.

### The real opening behind the idea

On October 30, an [OppIDX advertisement](https://www.oppidx.com/opportunities/brand-design-intern-summer-2027-figma-0kjy3o) displayed “Brand Design Intern (Summer 2027),” attributed to Figma. Its Apply link included Greenhouse job ID `6144755004`.

I inspected the advertisement in a browser and followed that link. It redirected to Figma's careers page. At the recorded check time, a complete public Greenhouse feed contained 141 postings and lacked that exact ID. Vacancy Autopsy saved a **Not currently listed** official-source observation. A recheck preserved the original observation.

That finding concerns one source at one time. I have no earlier positive observation for this ID, so I cannot establish prior removal, permanent closure or employer intent. The first observation used manual browser inspection. On November 1, Browserbase independently saved this same public advertisement, its exact Greenhouse link and a viewport screenshot. Both saved hashes matched and the newly created session was released; dynamic application state remains unverified. SerpApi has not established the exact counterpart. Supplying two URLs alone still keeps the overall finding inconclusive. The completed capture path is stronger: select the saved snapshot’s unique posting link, then investigate. A November 1 run preserved the captured advertisement and complete 140-posting feed together and returned **Not currently listed**. The exact link is evidenced; prior removal and intent remain unknown.

### How an answer stays dependable

Greenhouse, Lever and Ashby provide structured public sources. A deterministic verifier resolves the exact ID and validates complete responses. An old advertisement that still matches an active posting can be **Verified open**. A timeout, incomplete feed or uncertain identity stays **Inconclusive**. Age alone never supplies a verdict.

Mastra coordinates resolve → check → report. Temporal wraps the investigation in durable execution. A real local recovery test killed the worker after persistence, restarted it and returned the same report with one source fetch and successful history replay. That test used a synthetic source, separate from the live job observations.

The source tools are also earning their place in the product. SerpApi returned two real advertisement leads for the Figma query; the app saved the result and its JSON download passed its projection-hash check. A second query returned one advertisement lead. Neither produced an exact first-party posting candidate, so I have not demonstrated automatic counterpart discovery yet. Search results help choose a starting point; they do not establish availability.

Sentry helped fix real problems in that journey. The first search failed in 1.53 seconds even though the provider returned usable results: a malformed URL could make local validation discard the entire response. After that repair, successful browser searches appeared in separate traces. The initial shared trace had exposed a second issue, request context leaking across independent operations; fresh searches now have distinct trace IDs, while the verification worker keeps its nested steps together. The traces retain operation, outcome and latency, without the advertisement, query, response body, private checkpoint identity or invented token/cost data.

Saved checks now live in MongoDB Atlas, so returning to an investigation does not depend on the API or worker staying alive. The migration preserved 15 reports and two source artifacts with matching hashes. I rechecked a real Semgrep opening through the app, restarted both processes, and returned to all 16 saved checks; the new report downloaded byte-for-byte unchanged. The database user is scoped to this product's database and cluster. An offline refresh also retained the archive and showed an error rather than telling the applicant it was empty.

Browserbase now saves a genuine remote-browser snapshot through the product. The first attempt exposed a changed opaque transport URL; constructing the documented connection from the freshly created session ID fixed it. The successful capture retained the public advertisement, its exact ATS link and a PNG with verified hashes, then released that same new session.

Auth0 now also works through the actual reviewer interface. The reviewer flow denied my Google account before it had reviewer permission. After I assigned only the dedicated `review:reports` role and signed in again, the product recorded approval of one exact private report; a separate Atlas connection validated the saved approval and report digest. This is a local test using Auth0 development social keys. Production social credentials and hosted callbacks remain open. Hosted mode requires Auth0 alongside persistent MongoDB and currently represents one private shared reviewer workspace, not a tenant-isolated public SaaS. The sharing flow now lets a permitted human preview a source-only finding, confirm the exact approved snapshot, and later withdraw its link. Saved official bytes, report/preview digests and freshness are checked again before publication. Browser tests used clearly labeled synthetic findings; an Atlas adapter test verified persistence and withdrawal of one synthetic record. Sharing remains off in the real app, and no real finding has been published.

The product does not submit applications or contact employers. It helps an applicant choose a better next move before spending another evening applying.

## Why Does Open Innovation Matter?

The open-weight Qwen model made the extractor an experiment I could inspect and adapt. I kept the task schema, frozen employer/template partitions, deterministic parser baseline and every base/tuned output. That made both the validation gain and the later regression visible. I can change the extraction strategy without letting the model redefine what counts as an available job.

The open-source Mastra workflow also keeps the decisive check explicit: resolve the exact opening, validate the employer response, and preserve the observation. Model suggestions stay outside that rule. TabPFN helps decide which opening deserves attention first; it cannot turn a suspicious score into a finding.

This build still depends on networked search, model providers and current employer feeds. It does not run offline, and the private hosted checkpoint is not a released set of weights. The benefit I can demonstrate is a replaceable, inspectable extraction and orchestration layer with reproducible comparisons, rather than a claim that a closed service could never implement the same workflow.

## Prize Categories

I am entering **Best Use of Tinker** and **Best Use of TabPFN** as the featured categories, supported by the experiments and product interactions above.

The additional categories are **Best Use of Browserbase**, **Best Use of SerpApi**, **Best Use of Mastra**, **Best Use of Temporal**, **Best Use of MongoDB Atlas**, **Best Use of Sentry Agent Tracing**, and **Best Use of Auth0 for AI Agents**. Nine technologies have meaningful execution evidence; organizer acceptance is not being assumed.

**Render remains a target, not an entered category**, until the actual application is deployed and verified. Its current workspace is full, and the persistent deployment requires payment verification. No unrelated services or billing settings were changed. One project may enter several categories but can win only once in this challenge.


Agent-session sharing is optional and remains off. No transcript, account screenshot or secret-bearing artifact is included in this article.

Primary API references: [Greenhouse](https://docs.greenhouse.io/job-board.html), [Lever](https://github.com/lever/postings-api), [Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api). Reproducible checks and limits: [VERIFICATION.md](https://github.com/himanshu748/vacancy-autopsy/blob/main/outputs/vacancy-autopsy/docs/VERIFICATION.md), [MODEL-EXPERIMENTS.md](https://github.com/himanshu748/vacancy-autopsy/blob/main/outputs/vacancy-autopsy/docs/MODEL-EXPERIMENTS.md), [SPONSOR-GATES.md](https://github.com/himanshu748/vacancy-autopsy/blob/main/outputs/vacancy-autopsy/docs/SPONSOR-GATES.md).
