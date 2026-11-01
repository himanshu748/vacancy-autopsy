# Vacancy Autopsy: preregistered model protocol

## Current evidence

The real Tinker extraction experiment completed on October 30, 2026: one fine-tune, base/checkpoint validation and one fixed held-out test comparison. Its 297 public-source records use frozen employer/template holdouts. The trained model improved exact title preservation on the unseen HTML validation set; the native-JSON test was a ceiling tie. This is separate from priority/stale-ad prediction. Official availability verdicts remain grounded in deterministic first-party checks; extracted model fields are candidate identity information, not a verification verdict. Synthetic unit tests establish implementation behavior only.

## Completed Tinker results

The fixed Qwen/Qwen3-8B run used 97 Lever records from Palantir/Zoox for one epoch: rank 16, learning rate 0.0001, batch size 8, 13 optimizer steps and 339,094 training input tokens. Live capabilities confirmed the model is trainable and sampleable with a 32,768-token context. The experiment explicitly used 16,384 total tokens per example. Both comparisons used temperature 0, one response per row and a 512-token completion limit.

| Evaluation | Base exact-record accuracy | Tuned exact-record accuracy | Base field micro-F1 | Tuned field micro-F1 |
| --- | ---: | ---: | ---: | ---: |
| Greenhouse validation: 100 page-text rows, Figma/Anthropic | 80% | 100% | 0.95 | 1.00 |
| Ashby held-out test: 100 native-JSON rows, Notion/Semgrep | 100% | 100% | 1.00 | 1.00 |

The validation gain corrected 20 title errors, including location qualifiers: the base model shortened “Account Executive, Enterprise (Berlin, Germany)” to “Account Executive, Enterprise,” while the tuned model preserved the complete source title. Exact job-ID and employer accuracy were already 100% and stayed there in both evaluations. All **400 comparison outputs** were retained, with zero invalid JSON responses, omitted rows or duplicate row IDs. Training choices were unchanged, and their hashes were frozen before the single held-out test comparison. No post-test retuning or replacement evaluation was performed.

The **held-out native-JSON test showed no improvement** because both models were already at 100%. The separate deterministic validation baseline reached 99% exact-record accuracy; the learned validation result is one additional correct record over that parser. Do not turn the larger base-model comparison into a claim of broad superiority over deterministic extraction. The corpus contains 197 structured API JSON inputs and only 100 page-text inputs. Each holdout contains two employers and one actual ATS family. Representative third-party advertisement generalization and production accuracy remain unestablished.

The complete experiment's worst-case gross token estimate was **$0.51320744**, using the refreshed [official Qwen3-8B rates](https://tinker-docs.thinkingmachines.ai/tinker/models/models_and_pricing/): $0.195 prefill, $0.60 sampling and $0.44 training per million tokens, without assuming cache discounts. This estimate is not a verified invoice or final credit deduction. A successful project usage query initially returned no rows; the [documented billing lag](https://tinker-docs.thinkingmachines.ai/tinker/cli/billing/) means that is not evidence of zero cost. No card-funded overage, automatic top-up, plan change or purchase was enabled.

The private sampler checkpoint is 184,692,800 bytes. Its original one-hour save TTL was first extended to November 6, 2026, with a seven-day storage estimate of **$0.0043095** at the documented $0.10/GB-month rate. That historical retention was subsequently superseded by a 90-day extension: the unchanged checkpoint now remains **private through January 28, 2027, at 10:20 PM IST**, with a full 90-day storage estimate of **$0.05540784**. See the exploratory-check section below for the latest receipt. Retention does not change model parameters or the evaluation protocol. The exact sampler path remains in ignored `work/model-live-v1/training.json`, not in shared source.

Current receipts at the workspace root are `work/model-live-v1/results-summary.json`, `validation.json`, `test.json`, `test-freeze.json`, `validation-title-errors.json` and `checkpoint-retention.json`. The earlier 24-hour retention receipt is preserved separately. All raw model outputs, credentials and private checkpoint identifiers stay outside the shareable source archive. Sponsor qualification and a broader extraction claim require their own review; this result establishes the narrow measured behavior above.

## Completed TabPFN results

A separate 132-record public corpus passed the frozen protocol and independent evidence review by another AI agent, not a human reviewer. Its seed-17 split was 82 Lever/community-catalogue training records, 20 OppIDX/Greenhouse validation records and 30 Simplify/Ashby test records, with employer and actual source-template families disjoint. Source captures and feature freezes preceded first-party checks. The reviewed labels preserve complete source bundles; uncertain or incomplete responses did not become negative labels.

One fixed TabPFN-3.5 API prediction used four estimators and seed 17, with no test-set selection or retuning. All 50 held-out raw scores were preserved. The provider run completed in 12.48 seconds and consumed 10,000 quota tokens, confirmed by the account's before/after usage observation. No model weights or local-model license acceptance was needed.

| Evaluation | TabPFN average precision | Age/logistic average precision | Outcome at fixed 20% check budget |
| --- | ---: | ---: | --- |
| Validation: 20 rows | 0.65000 | 0.65000 | All feature vectors tied; identical ID tie-break and no improvement |
| Test: 30 rows | 0.92276 | 0.89251 | Six checks: TabPFN selects 6/17 exact-ID absences with zero false positives; each baseline selects 5/17 with one false positive |

These values are **non-interpolated average precision**, not trapezoidal PR-AUC. All **17 test negatives were already publisher-marked INACTIVE**. The sample is retrospective and age-stratified, with catalogue JSON among its source representations. It does not establish market prevalence, production generalization or discovery of unmarked stale ads. The validation tie and publisher-status limitation must accompany the test gain. Publisher status, official verification results, text, URLs and employer groups were excluded from the 13-column numeric feature matrix; leakage mutation checks preserved that matrix.

The local Shortlist service uses the fitted context, preserves null values and ranks only user-entered pre-check information. A real browser run ranked two genuine public advertisement URLs, used the selected opening to prefill and focus the check form, and retained entries and rankings when returning to Shortlist. Its priority is relative order, never an availability verdict. Accepted prediction state is persisted for resume; an uncertain submission cannot blindly submit again, and identical completed batches reuse their genuine result.

Private receipts are retained under workspace `work/priority-corpus/`: `benchmark-v1.json`, `benchmark-usage.json`, `predictions.fixed-benchmark.json`, `independent-review.json` and the reviewed split/corpus. The live product receipt is `outputs/evidence/tabpfn-live-shortlist.json`. No credential, raw private model state or checkpoint identifier is included in shareable source.

## Executed local compatibility and token preflight

Before the live run, the isolated environment imported Tinker 0.36.0 and verified 14 SDK signatures/type constructions with sockets disabled; that earlier phase constructed no service client. Transformers 5.22.1 and the real Qwen/Qwen3-8B tokenizer exposed a mapping-return compatibility bug: the runner now explicitly requests `return_dict=False` and validates a flat nonnegative token-ID list. The Python suite covers that regression. Tokenizer files were cached locally; no base-model weights were downloaded. Real provider outputs were subsequently captured during the completed experiment above.

On all 297 frozen rows, a 4,096-token cap rejects 36/97 training rows and 97/100 test rows. An explicit 16,384-token cap fits every row, but this is local shape/context evidence only. Planned training input is 339,094 tokens; worst-case base-plus-tuned validation is 422,916 and test comparison is 1,018,428. Each stage exceeds its default 100,000-token ceiling. Before the real requests, the authorized full run explicitly used ceilings of 350,000 training tokens, 425,000 validation-comparison tokens and 1,025,000 test-comparison tokens, with an 1,800-second deadline per action. Every row remained intact. These are declared complete-run envelopes; inputs were never silently truncated or omitted.

Receipts remain private under `work/model-provider-sdk-proof.json`, `work/model-preflight-4096.json`, `work/model-preflight-16384.json` and `work/model-provider-preflight-status.json`. Earlier preflights that counted mapping keys were retained with `counts_valid: false`; their token totals are invalid. TabPFN preparation and results are tracked separately. The extraction corpus does not supply independently verified priority classes, so the Tinker result cannot establish a TabPFN prediction or ranking result.

## What is being predicted

Priority target `1`: the exact advertised posting was absent from a successfully validated, complete public employer board response at the recorded check time. Target `0`: the exact posting was present. Access failures, rate limits, malformed feeds, partial data, and uncertain identity are excluded. Absence does not establish fraudulent employer intent, a fake job, or a previous removal. A prior positive observation is required for a removal claim.

The extraction task reads only advertisement text and its URL, returning `employer`, `title`, `job_id`, and `ats`. Missing facts are null. A structured official counterpart helps an annotator establish the identity but must not supply an invisible job ID as an oracle extraction label. If the ID is absent from both model inputs, its gold extraction label must be null.

## Priority-prediction capture and record contract

Each JSONL record has exactly these fields:

| Field | Meaning |
| --- | --- |
| `id` | Stable unique sample identifier, not a label-bearing ID |
| `provenance` | `real_public`; `synthetic_test` is refused by every benchmark loader |
| `employer_group` | Canonical employer identity for grouping, assigned independently of outcomes |
| `template_group` | Actual page/template family, not a per-employer invented unique value |
| `dedup_key` | Stable ATS + board + posting ID; shared by reposts/rechecks of that opening |
| `advertisement_url` | Public HTTPS URL without embedded credentials |
| `advertisement_text` | Captured relevant text, 1–32,000 characters |
| `advertisement_sha256` | SHA-256 of the exact UTF-8 text |
| `advertisement_captured_at` | Aware ISO timestamp of capture |
| `features_captured_at` | Aware ISO timestamp when pre-verification features were frozen |
| `features` | Only the six features below |
| `verification` | Independent review metadata below |
| `gold` | Exactly `employer`, `title`, `job_id`, `ats`; strings or null, employer/title required |

`verification` has exactly: `source_url`, `checked_at`, `evidence_sha256`, `complete`, `identity_confirmed`, `outcome`, `reviewed_by`, `label_method`. Source URLs must use a supported Greenhouse, Lever, or Ashby API host. `complete` and `identity_confirmed` must both be true; `label_method` must be `independent_first_party_review`; outcome must be `verified_open` or `not_listed`. Use a pseudonymous reviewer identifier. Retain original response bytes and capture records under the referenced hash for manual audit. The schema validates metadata and the advertisement text hash; it cannot prove that a declared provenance, reviewer statement, timestamp, or verification hash is truthful. The evidence files and source linkage still need review.

Require advertisement capture ≤ feature freeze **<** verification, with verification no more than 24 hours after feature freeze. This is a declared demonstration label window, not a claim that hiring status remains stable for a day. Preserve true source capture times, including later rechecks. Do not relabel an old observation with a newer check time.

| Feature | Available before verification |
| --- | --- |
| `listing_age_days` | Age reported by the advertisement at feature freeze; null if unavailable |
| `repost_count` | Previously observed reposts only, not future history |
| `employer_name_similarity` | Comparison with a previously captured candidate employer/domain identity |
| `title_consistency` | Comparison with a pre-verification candidate title, never the final feed outcome |
| `ats_link_present` | 0 or 1 from the advertisement text/link |
| `source_type` | `job_board`, `search_cache`, or `official` |

All numeric values must be finite, nonnegative, and within a hard limit of 1,000,000; similarities are [0,1], repost count is integral, and ATS-link presence is 0/1. Missing numeric features are null. The feature allowlist prevents accidentally adding `found`, HTTP status, final verdict, evidence counts, or response-derived facts to the matrix. A timestamp assertion alone cannot detect someone calculating a feature using a later result; reviewers must audit feature computation and pre-verification snapshots. Employer and template IDs are grouping metadata, never predictor features.

Public APIs expose current openings, which supplies many positive examples but does not automatically supply historical negatives. Obtain negatives by retaining earlier advertisements and independently checking their exact identities, with user-permitted public capture and manual review. Never generate absent IDs or infer negative labels from age. Sample across source types and employers; report coverage and selection bias.

## Freeze, deduplication, and minimum evidence

`prepare.py` retains the earliest observation of each `dedup_key` or identical advertisement content hash. Repeated checks are not independent rows. It joins records sharing an employer **or** a template into connected components, then assigns whole components to train/validation/test with seed 17. Roughly 20% of components go to each holdout; the rest train. Labels do not choose partitions, and there is no search for a favorable seed. Near-duplicate text with changed whitespace still requires manual deduplication.

For priority prediction, require ≥80 train rows, ≥20 validation rows, and ≥30 test rows; each partition needs at least five rows of each real priority class and at least two employers. These are modest demonstration gates, not a statistical power guarantee. Extraction additionally needs ≥20 visible-ID train labels and ≥10 in each holdout. The frozen manifest records dataset hash, seed, row IDs, group membership, and class counts. Runners recalculate it and reject changed data or partitions.

Shared ATS templates can connect most employers into one component. If fewer than three independent components remain, the joint holdout is impossible and the run stops. Do not invent unique template labels to force it through. A later employer-only evaluation could answer a narrower question, but must be explicitly named and must not claim unseen-template generalization. This protocol does not silently downgrade its split.

## Separate extraction-only experiment

The extraction task does not require old/absent postings. It now has a distinct JSONL contract and `vacancy_autopsy_extraction_split` manifest, loaded by `extraction_data.py` and frozen by `prepare_extraction.py`. The priority loader remains strict and cannot consume this record shape. Its two-class gates were not relaxed.

Extraction records contain exactly: `id`, `provenance`, `employer_group`, `template_group`, `dedup_key`, `advertisement_url`, `advertisement_text`, `advertisement_sha256`, `advertisement_captured_at`, `gold`, and `counterpart`. `gold` contains the same four output fields, each nullable when absent from model inputs. Non-null employer/title labels must be present in the supplied text or URL after basic HTML/entity/whitespace normalization; non-null job IDs must appear literally. Do not infer an employer alias from an ATS board slug.

`counterpart` contains exactly `source_url`, `checked_at`, `evidence_sha256`, `identity_confirmed`, `label_method`, and `record_path`. Source hosts are the documented public ATS APIs. Its capture follows the ad within 24 hours. Label method explicitly distinguishes `automated_exact_structured_counterpart` from `independent_first_party_review`; automation is never claimed to be human review. Referenced source paths must remain relative to the dataset directory. The loader checks retained file hashes, native structured records, and the unique ID/title match when the label exposes an ID. Null-ID rows keep auditable source provenance but cannot have source linkage proved by that ID. Hashes do not prove employer-domain ownership or labeling truth by themselves.

The joint employer/template holdout and deduplication policy remain unchanged in substance. Extraction requires ≥80 train, ≥20 validation and ≥30 test records, with at least two employers per partition, and ≥20/10/10 visible-ID labels. It deliberately has no priority-class count. Missing facts have separate non-null denominators in the metrics, so null handling cannot hide what was actually extracted.

The captured corpus at `work/extraction-corpus/records.jsonl` passed this contract with 297 records, six employers and three real ATS families. Its seed 17 manifest assigned 97 Lever rows (Palantir/Zoox) to train, 100 Greenhouse rows (Figma/Anthropic) to validation, and 100 Ashby rows (Notion/Semgrep) to test, with no shared employers/templates. Dataset SHA-256: `26d6e3fecfba25e42e98bc4ef4b92d3863058ba90b7534c4b8a4a2637a302ed3`. These are public-source extraction records, not a stale-ad dataset:100 inputs are parser-extracted real page text and197 are native API JSON objects. Lever/Ashby page403responses were respected; documented public API data was captured as its own representation, never passed off as browser evidence or synthetic noisy ads.

A fixed zero-model validation baseline(`native-fields-and-explicit-headings-v1`) used only the model inputs, without employer-specific dictionaries, group metadata or gold data. On 100 Greenhouse validation records it achieved 99% exact-record accuracy, 100% job-ID accuracy, 99% employer/title accuracy, and field micro-F1 of 0.9974937343. The artifact is `work/extraction-corpus/deterministic-validation.json`. This deterministic baseline was not evaluated on the test partition. This near-deterministic result limits the practical improvement that a learned extractor can demonstrate on this clean-source corpus. The subsequent Tinker result above must be read alongside this baseline; genuinely messy third-party generalization remains unproven.

## TabPFN comparison

Fixed comparators: older-first age heuristic, deterministic L2 logistic regression (train-only standardization, null indicators and one-hot source types; 1,200 full-batch steps, learning rate 0.05, L2 0.01), and TabPFN-3.5 API with four estimators and seed 17. The numeric matrices are the same for logistic and TabPFN. No names, full URLs, ad text, reviewer identifiers, or official-result fields go to TabPFN.

For each holdout, report non-interpolated **average precision**, class prevalence, recall/precision at a predeclared 20% investigation budget, and false-positive/false-negative counts. Average precision is labeled precisely; it is not trapezoidal PR-AUC. Score ties use record-ID order for the fixed budget, while AP groups ties. No model or threshold is selected using the test set. The API runner makes one prediction over concatenated validation/test inputs, then evaluates the partitions separately; no held-out labels are sent to fit.

The API runner requests a dimension-only quota estimate before uploading feature values and rejects unknown billing units or an estimate over the caller's token ceiling. It saves pending prediction state and imposes a 300-second wait ceiling. An estimate is not a cost guarantee, and a local timeout is not server cancellation. Inspect provider quota and state before any retry. There is no automatic plan upgrade, overage, or data deletion. The model-version alias is recorded; its resolved checkpoint may change at the provider.

## Tinker comparison

Use a currently available Qwen model with its chat template, identically disabled thinking, and the same system prompt for base/checkpoint sampling. Model inputs contain only a JSON-encoded advertisement and URL. Retrieved text remains untrusted; the extractor has no tools or publication authority. Reject malformed output rather than repairing it with gold information.

Response-only next-token SFT uses a shifted input/target sequence and masks all prompt-token losses. Defaults: rank 16, learning rate 0.0001, batch size 8, one epoch, at most 30 steps, a default 4,096 total tokens per example (explicitly configurable up to 16,384 before model evaluation), 100,000 planned training tokens, and a 600-second wait ceiling. These limits may block a corpus. Choose a justified budget before a provider run; do not silently truncate inputs or omit held-out failures. A tokenizer-only `preflight` action can count all planned train/validation/test inputs without credentials or Tinker calls. It downloads only tokenizer files, using a project-local cache. Any context/budget change must be explicitly recorded before the first model result; failed/long examples cannot silently disappear. Only train rows enter gradient requests. The runner saves a sampler checkpoint with a one-hour TTL and records the dataset hash, prompt hash, training IDs, and settings. Checkpoint storage may still incur charges during its lifetime.

Compare base and checkpoint at temperature 0, one sample each, max 512 completion tokens, first on validation. Freeze all choices before a single held-out test comparison. Report exact job-ID accuracy, normalized employer accuracy, field micro precision/recall/F1, invalid-JSON count, exact-record accuracy, and the number/accuracy of non-null job IDs separately. Names/titles normalize NFKC, case and whitespace only; job IDs retain exact case/punctuation. The sample count, raw outputs, elapsed time, checkpoint and absolute metric changes remain inspectable. A saved checkpoint, lower training loss, or positive fixture result alone does not qualify as improvement.

## Exploratory third-party template check: a regression

After the original validation and test were complete, a separate protocol froze all 20 existing OppIDX advertisement captures. It preserved each complete captured text, its hash, all four labels, the unchanged prompt and checkpoint, temperature 0, and one sample per model per row. Employer and title labels were checked against the exact captured page-title line; each job ID and ATS reference occurred in the actual application link. No source text was edited. The 20 job identities overlap none of the original train, validation or test records. Figma and Anthropic do overlap the earlier validation employers, while remaining absent from training. This is an exploratory check of a different page template, not a newly preregistered unseen-employer test.

| Real OppIDX captures | Base Qwen3-8B | Existing fine-tuned checkpoint |
| --- | ---: | ---: |
| Exact-record accuracy | 20/20 (100%) | 18/20 (90%) |
| Exact job-ID accuracy | 20/20 (100%) | 18/20 (90%) |
| Employer, title and ATS accuracy | 100% each | 100% each |
| Field micro-F1 | 1.0 | 0.975 |
| Invalid JSON | 0 | 0 |

The two fine-tuned errors substituted an OppIDX URL slug for the actual Greenhouse posting ID: `data-engineer-figma-0u3v5s` instead of `5220003004`, and `figma-xlm891` instead of `6143238004`. These strings are present in the third-party URL, so a substring-grounding check alone cannot establish that they are ATS posting IDs. A model suggestion must still match a supported employer posting URL before it can supply an original application link. This regression limits the earlier validation gain and rules out a general claim that the fine-tuned model is better on real advertisements.

All 40 responses were retained in 121.75 seconds, with no omitted rows, duplicates, follow-up training, or caller retries. Actual returned token counts were 62,172 input and 1,818 output tokens; current uncached rates imply a gross estimate of **$0.01321434**, not a verified invoice amount. Frozen inputs, raw outputs, error analysis, hashes and usage receipt are in the ignored `work/model-realworld-v1/` directory. Only two employers and one third-party template were tested, so these results do not establish representative production accuracy.

The existing private checkpoint was separately verified after a 90-day TTL extension. Its unchanged 184,692,800-byte sampler now expires **January 28, 2027, at 16:50:39 UTC**. At the documented $0.10/GB/month storage rate, the full 90-day gross storage estimate is **$0.05540784**. Its path, private access and model stayed unchanged; no payment method, plan, auto-reload or publication setting changed. The retained receipt is `work/model-realworld-v1/checkpoint-retention-90days.json`.

## Release gates

- Tinker: the real corpus, frozen employer/template holdouts, fine-tune and complete base/checkpoint comparisons have run. Validation improved; the held-out native-JSON test tied at its ceiling, and the exploratory third-party template check regressed. Actual billed cost remains unverified because usage data lags. Preserve these distinctions when reviewing category claims, and obtain a representative advertisement evaluation before asserting broader extraction value.
- TabPFN: independently AI-reviewed labels, frozen split, actual API prediction, fixed baselines and held-out report, quota receipt and live Shortlist journey have run. Validation tied and the small retrospective test used publisher-marked negatives. Broader prospective generalization remains unestablished.
- Serving: the trained checkpoint can supply candidate extraction fields through the optional local service. Model output does not establish source linkage or availability. Deployment, availability past the recorded checkpoint expiry and wider model quality remain separate checks.

## Primary sources checked October 30, 2026

- [Prior Labs API client, authentication, persistence and quoting](https://github.com/PriorLabs/tabpfn-client)
- [Prior Labs estimator version selection](https://github.com/PriorLabs/tabpfn-client/blob/main/src/tabpfn_client/estimator.py)
- [Prior Labs cost estimation](https://github.com/PriorLabs/tabpfn-client/blob/main/src/tabpfn_client/cost.py)
- [Tinker SDK loss masking and training flow](https://tinker-docs.thinkingmachines.ai/tinker/sdk-cheatsheet/)
- [Tinker training-client API](https://tinker-docs.thinkingmachines.ai/tinker/api-reference/trainingclient/)
- [Tinker session lifecycle](https://tinker-docs.thinkingmachines.ai/tinker/api-reference/serviceclient/)
- [Tinker checkpoint lifetime](https://tinker-docs.thinkingmachines.ai/tinker/howto/checkpoints/)
- [Tinker current model pricing](https://tinker-docs.thinkingmachines.ai/tinker/models/models_and_pricing/)
- [Tinker billing usage and lag](https://tinker-docs.thinkingmachines.ai/tinker/cli/billing/)

Optional requirements pin `tabpfn-client==0.7.0` and `tinker==0.36.0`. Tinker 0.36.0 made the real requests reported above; earlier offline compatibility checks remain separate evidence. Recheck package/docs compatibility before another run. The TabPFN API path needs no local model weights or local-weight license acceptance.
