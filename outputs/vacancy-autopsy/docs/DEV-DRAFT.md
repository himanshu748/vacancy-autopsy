---
title: "Vacancy Autopsy: Is this job still alive?"
published: true
tags: devchallenge, hf26challenge
---

*This is a submission for the [Hacktoberfest Open-Source AI Challenge Week 4: Ghost in the Machine](https://dev.to/challenges/hacktoberfest-week4-2026-10-26)*

## What I Built

A job advertisement can have a title, a description, and an Apply button even when you cannot find the opening on the employer’s own board.

That is a frustrating point to discover after writing a cover letter.

**Vacancy Autopsy helps you check an opening before you spend your evening applying.** Paste a job link, follow it back to its employer, and see where it stands:

- **Verified open:** the exact posting appears in the employer’s checked job feed.
- **Not currently listed:** the exact ID is absent from a complete response from that board.
- **Inconclusive:** the available sources cannot support a reliable answer yet.

Each finding comes with a next step: visit the official opening, look for a repost, or supply a stronger source link. You can open the source records, download the report, and recheck later while keeping the earlier observation.

The person I am building for already has enough tabs open. They might have found the same role on a search engine, a community catalogue and a third-party board, with slightly different titles on each. Before choosing where to apply, they need to know whether those pages point to the same opening and whether that opening can still be found at its source.

Vacancy Autopsy brings that comparison into one workspace. The saved check gives you somewhere to return when a listing resurfaces or a source changes. You can see what was established at the time and decide whether another check would help.

For a messy advertisement, the trained listing reader suggests the employer, role and posting identity. For a long list of possibilities, Shortlist helps you decide which opening to investigate first. The interface changes with what the investigation establishes: a confirmed match gets an official link; an uncertain match asks for the information it still needs.

My take on **Ghost in the Machine** is an advertisement that seems alive online while its original opening is difficult to verify. Vacancy Autopsy gives a job seeker a way to examine that ghost before investing more time in it.

## Demo

[Open the read-only source finding](https://vacancy-autopsy.onrender.com/?shared=53f29d77e07df8164037f8cc6bbc4f210c806f80163c69d98733b5efcab4f4c4). No account is needed. It shows a real Software Engineer Intern posting present in Semgrep's checked source, with its timestamp, official link and qualified finding.

[Open the live Render app](https://vacancy-autopsy.onrender.com). The investigation workspace requires an authorized reviewer account; the shared finding is the public demonstration. It exposes source references while keeping private inputs, captured bodies and reviewer identity protected.

The walkthrough follows one task:

1. Paste a job advertisement or an official Greenhouse, Lever or Ashby posting.
2. Read the listing details and confirm the exact official posting link.
3. Investigate it and get a finding with a useful next action.
4. Return to Saved checks and recheck the source without losing the original.

When starting from a third-party page, the source tools can capture the advertisement and retain its explicit ATS link. You choose that captured link before the official check.

An official posting URL is the shortest route through the product. A third-party advertisement needs an extra identity step, because a similar title alone is not enough to connect it to an employer opening. The reader helps extract the details, while the captured link gives the verifier a concrete posting to check.

The result is designed to be readable before you open the supporting records. The finding, check time and next action appear together. Source details remain available when you want to understand the answer more closely.

## Code

[View Vacancy Autopsy on GitHub](https://github.com/himanshu748/vacancy-autopsy)

The project is MIT-licensed. The [setup guide](https://github.com/himanshu748/vacancy-autopsy/blob/main/outputs/vacancy-autopsy/README.md) covers the local verifier and the provider-backed features. The trained checkpoint requires configured Tinker access.

## How I Built It

### Tinker reads the advertisement

On the frozen Greenhouse pages, the tuned Qwen3-8B reader was more accurate and cheaper than the largest available Qwen baseline:

| Model | Exact records | p50 / p95 seconds | Estimated USD / 1,000 |
| --- | ---: | ---: | ---: |
| Tuned Qwen3-8B | 100/100 | 2.87 / 3.01 | $0.338 |
| Qwen3.5-397B-A17B | 91/100 | 2.85 / 2.99 | $3.039 |

Fine-tuning also lifted base-8B exact records from **80% to 100%** through full-title preservation. Latency was similar. The parser reached 99%, while the 20-ad check regressed to 18/20 against both baselines’ 20/20. Costs use actual tokens at published uncached rates, exclude training and are not invoices; the timeout and repeated baseline pass remain in the evidence. These small sets do not establish production quality.

### TabPFN helps choose the next investigation

**The agent asks TabPFN which leads to verify first.** A Mastra `triage` step freezes six pre-check features, ranks the leads and checks only the top three by default. It explains each check or skip and logs outcomes for independent review, without retraining or turning rankings into verdicts.

On the frozen 30-row test, TabPFN reached **0.923 average precision**, against **0.893** for logistic regression and older-first checking. All 17 absent postings were already publisher-marked INACTIVE and validation tied, so this is retrospective evidence, not production accuracy.

Both models ran through the live Render application on **November 1, 2026**.

The [model experiments](https://github.com/himanshu748/vacancy-autopsy/blob/main/outputs/vacancy-autopsy/docs/MODEL-EXPERIMENTS.md) contain the complete results and limits.

### Follow the opening back to its source

**SerpApi** supplies search leads. **Browserbase** captures supported public pages and their explicit posting links. The verifier then checks exact posting identity against public Greenhouse, Lever or Ashby feeds. Search snippets and listing age never determine a verdict.

This gives discovery and verification different jobs. Search helps you find a candidate. A browser snapshot preserves what the advertisement actually presented. The official feed supplies the current source observation. Keeping those steps distinct lets the product explain an uncertain connection instead of silently treating two similar-looking pages as the same job.

**Mastra** coordinates the verification workflow. **Temporal** makes the local investigation resumable through worker failures. **MongoDB Atlas** stores saved checks, captures and private approvals so a restart does not erase the applicant’s work.

**Sentry** traces the tools when something goes wrong. It helped uncover a search adapter that discarded usable results when one URL was malformed. **Auth0** protects the reviewer’s private workspace and approval of an exact report. Only a specifically reviewed source-only finding becomes public.

When the exact opening is absent, **Ultramarine** can help find another direction. It compares a supplied public role title with postings in the checked employer inventory and suggests possible alternatives. One live call considered 20 of 140 retained postings, selected three, and used 792 input plus 47 output tokens, an estimated **$0.0001423** at the recorded rates. The links come from the source; they are different posting IDs, not confirmed reposts.

### An answer you can act on

The result view puts the finding ahead of the investigation machinery. A verified opening gives you a route back to the official posting. An absent ID suggests looking for a current repost. An inconclusive check explains which source information could make another attempt worthwhile.

The timeline and source records sit behind that first answer. They give an interested reader a way to inspect the check without making every applicant read a technical report. Rechecking creates another observation and preserves the original, so an answer from yesterday remains identifiable as yesterday’s answer.

**Render** hosts the frontend, investigation API and Python model clients in one live application. An applicant can read a listing, choose a checking budget and return to the saved findings in the same workspace. The hosted verifier uses Mastra directly; the separate Temporal recovery path remains local.

## Why Does Open Innovation Matter?

The open-weight model made the listing reader something I could train and compare against its starting point. Keeping the same extraction task across both models made the useful improvements and the regressions visible. That freedom matters when a small field such as a posting ID decides whether a check refers to the right opening.

Mastra makes the investigation workflow inspectable too. Reading a listing, choosing a check and verifying a source have separate responsibilities. I can change the reader without changing the rule that an availability finding needs a valid employer response.

The practical benefit is control over the experiment and the product boundary. I can keep the task schema fixed, retain the original model as a baseline and examine which fields changed after training. When an experiment regresses, the application can still enforce its own identity rules. The source check does not have to inherit the model’s confidence.

That makes future changes more deliberate. A better reader can take the same small extraction task, and another prioritizer can be compared on the same pre-verification information. The workflow remains understandable because the model’s responsibility is explicit.

This version uses hosted model APIs and current web sources, so it needs internet access. The open foundation gives me room to adapt the model and workflow; it does not make the external job boards or provider services disappear.

## The Spirit of It

The moment the idea became concrete was a Brand Design Intern advertisement attributed to Figma.

The advertisement still offered an Apply link. In the November 1 check, the exact linked job ID was absent from the complete public employer feed. Vacancy Autopsy kept the captured advertisement and official-source response together and returned **Not currently listed**.

That finding did not establish why the ID was absent, whether it had been removed, or what the employer intended. It gave an applicant a practical reason to look for a current opening before applying through that advertisement.

The interesting part was how ordinary the advertisement looked. A working page and an Apply button made it easy to keep moving. Comparing it with the official source created a useful pause: there was something concrete to check before putting more work into the application.

That is the experience I wanted to build: a little more clarity before another evening of applications.

## Prize Categories

Featured categories:

- **Best Use of Tinker:** the trained Qwen listing reader and its baseline comparison.
- **Best Use of TabPFN:** the pre-verification Shortlist ranker and evaluation.
- **Best Use of Render:** the live AI workspace and persistent model-operation runtime.

Additional categories:

- **Best Use of Browserbase:** live advertisement capture and explicit ATS-link evidence.
- **Best Use of SerpApi:** live search leads for an investigation.
- **Best Use of Mastra:** the open-source verification workflow.
- **Best Use of Temporal:** durable local investigations and tested worker recovery.
- **Best Use of MongoDB Atlas:** persistent saved checks, captures and private approvals.
- **Best Use of Ultramarine:** source-bound current-opening alternatives with a recorded live token-cost estimate.
- **Best Use of Sentry Agent Tracing:** tool tracing used to diagnose actual search failures.
- **Best Use of Auth0 for AI Agents:** authenticated reviewer access and approval of an exact report.

<!-- Add Best Use of Render only after its hosted product journey is verified. My Agent Session is omitted because that template section is optional and session publication is not authorized. -->
