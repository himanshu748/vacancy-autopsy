# Verification receipt — October 30, 2026

Result: **working local investigation slice; full ten-sponsor release incomplete**. Eight meaningful sponsor integrations, real model benchmarks, a verified stale-ad finding, and a hosted public demo have not been established.

## Automated checks

| Check | Actual result | Evidence boundary |
| --- | --- | --- |
| TypeScript strict check and Vite production build | Passed | Compiles the local app and optional Temporal code |
| TypeScript tests | 21 passed; one server-dependent recovery test skipped in the ordinary suite | Exact identity, partial/malformed/error responses, invalid UTF-8, pagination, direct Lever lookup, immutable reports/rechecks, local Host/Origin guard, Unicode request limits, durable persistence and redacted errors; source responses are synthetic fixtures |
| Python logic tests | 46 passed | Synthetic logic fixtures; schema, leakage, grouped splits, frozen extraction/priority manifests, baselines/metrics, counterpart provenance, token-cap gates and extraction loss masks; no learned-model accuracy claim |
| Real local Temporal recovery | Passed separately | Real server and worker, synthetic source; SIGKILL after evidence save, restart, same report, exactly one source fetch, history replay |
| Runtime dependency audit | Zero reported advisories | `npm audit --omit=dev`; a point-in-time registry audit, not a complete security assessment |

Reproduce ordinary checks with `npm run build`, `npm test`, and `python3 -m unittest discover -s ml/tests -v`. [Temporal instructions](TEMPORAL.md) describe the opt-in recovery check and its saved receipt.

## Real source observations

The public sources below were requested through the actual local API, with the optional Temporal worker enabled for later checks. Reports retain response text, source URLs, capture times, status codes and SHA-256 values. These are positive source observations, not stale-job accusations.

| Source | Outcome | Saved report |
| --- | --- | --- |
| Ashby / ThinkingMachines / `885f32cc-5b1c-465c-af5a-e88634065bc6` | Verified open; “Research, General Agents” | `960699df-fe67-42e3-a98c-f4a74398c0f5`, checked `2026-10-30T06:41:04.305Z` |
| Ashby / semgrep / `8e64dc7f-e925-4361-86d5-b01ee518c987` | Verified open; “Software Engineer Intern” | `ec7f1f7a-097d-4b83-b443-15bc126e002e`, checked `2026-10-30T06:47:38.220Z` |
| Greenhouse / figma / `5426468004` | Verified open; “Account Executive, Enterprise” | `b7265f6a-baec-4aae-bb5e-d143331a069e` |
| Lever / palantir / `6ed76ce8-4156-4b60-b120-403538bd66cd` | Initial board check timed out: inconclusive. A later direct-posting lookup verified “Administrative Business Partner” | Original `b53893e8-c068-4256-ab40-433eaeb73321` retained; recheck `379636f9-eb4a-49a9-a403-6551833bbc0e`, checked `2026-10-30T06:56:12.303Z` |

Downloaded evidence bodies were independently rehashed with Python and matched their stored fingerprints. The first Ashby report was downloaded using the actual browser control. Later copies were retrieved through the local report endpoint. The public feeds may change after these capture times.

The [Employbl Semgrep advertisement](https://www.employbl.com/jobs/software-engineer-intern-cloud-platform-semgrep-1709977) visibly linked to the same Ashby posting and displayed an update date of September 9. Its age did not justify an outdated verdict: the exact posting was still present. This is one positive counterexample, not a statistical evaluation of an age baseline. No claim that a real ad outlived its opening has been established.

## Browser journey

Used the user's requested **in-app browser**, not a screenshot mockup:

- Submitted a real Ashby URL using Enter; observed actual loading and a verified-open report.
- Downloaded the JSON report through the browser and checked the saved body hashes.
- Rechecked and confirmed both original and linked new report in the archive.
- Submitted an unsupported example-domain URL; observed inconclusive with zero source records and no fetch-based finding.
- Submitted an HTTP URL; observed a visible server-validation error requiring public HTTPS.
- Ran the optional Temporal path with a live Ashby source through the same UI.
- Exercised the built app on port 8787 as well as the Vite development entry on 5173.
- Inspected desktop at 1280 pixels and mobile at 390 pixels; the mobile document width was exactly 390, with no horizontal overflow.
- Verified result focus moves to the report; Tab then reaches the download action. Mobile result focus brings the report into view.
- Inspected text contrast using computed styles in the rendered desktop investigation; no non-decorative small-text failures remained below 4.5:1. This is a focused contrast check, not a complete WCAG certification.
- No browser warnings/errors were reported on the built page at the checked point, before a deliberately invalid request was tested.

Reduced-motion CSS disables animations/transitions. The in-app browser surface exposed viewport overrides but no media emulation control, and the active system preference was not reduced motion. **Reduced-motion rendering was not independently browser-emulated.** Native screen-reader behavior, mobile hardware, public multi-user access, provider outages, and hardware/storage-failure recovery were not tested.

## Sponsor and release limits

Mastra's deterministic workflow and Temporal's local durability path ran. MongoDB's optional adapter compiled but Atlas was not connected. Tinker/TabPFN provider runners are prepared and explicitly unexecuted; their imports/endpoints remain provider-unverified. SerpApi discovery, Browserbase capture, Sentry traces, Auth0 approval, and Render hosting are unimplemented or unverified as detailed in [SPONSOR-GATES.md](SPONSOR-GATES.md).

No payment method, paid plan, cloud deployment, public report, contest submission, or push was created. The user authorized one initial local source commit to enable Entire's anchor-dependent features; a separate local receipt records its observed outcome. No credentials were copied from another project. The local app, worker and Temporal dev server may remain running for review; stop the two npm terminals with Ctrl-C and stop the workspace Temporal CLI process when finished. Default `npm run dev` uses the direct path unless `TEMPORAL_ADDRESS` is explicitly supplied.

## Research consequence

[Skip The Boards](https://skiptheboards.com/jobs/3cbe4ca5f05f-software-engineer-intern-winter-2027-notion) describes regular first-party rechecks and removing disappeared listings. [Software Internships](https://swe-internships.pages.dev/) describes checking employer boards and retaining unreachable roles as unverified. These product pages establish that source rechecking is already an advertised mechanism; their actual reliability was not audited. Do not claim novelty for that mechanism. The proposed differentiation is the user-triggered investigation artifact, preserved history, recovery evidence and honest model experiments, still requiring comparative validation.

Community research also reinforced explicit idempotent activity behavior: [Understanding At-Least-Once Execution and Why It Matters for Workflow & Agent Developers](https://dev.to/diagrid/understanding-at-least-once-execution-and-why-it-matters-for-workflow-developers-3nen) by [@diagrid](https://dev.to/diagrid) discusses the gap between a side effect and recording completion. The recovery test deliberately interrupts that gap. [Read the full DEV discussion](https://dev.to/diagrid/understanding-at-least-once-execution-and-why-it-matters-for-workflow-developers-3nen). Temporal implementation choices were checked against its own primary documentation as well.

## Subsequent account access

On October 30, 2026, the user explicitly requested Google sign-in using their Gmail account. Tinker authenticated the requested account, and its balance page was inspected with auto-reload disabled. Private account balances and screenshots are excluded from shareable source. No billing setting was changed, no API key was created, and no Vacancy Autopsy model run occurred. Account access is verified; it does not satisfy the Tinker fine-tuning/benchmark gate.
