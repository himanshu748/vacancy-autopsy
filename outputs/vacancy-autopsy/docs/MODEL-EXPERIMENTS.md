# Vacancy Autopsy: preregistered model protocol

## Current evidence

Local experiment infrastructure is implemented and tested. Extraction now has 297 captured public-source records and a frozen employer/template holdout; this is not a priority/stale-ad dataset. No sponsor model run or trained checkpoint has completed. Synthetic unit tests validate logic only. No model improvement, production accuracy, Tinker qualification, or TabPFN qualification is claimed. The live TypeScript investigation flow remains deterministic.

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

A fixed zero-model validation baseline(`native-fields-and-explicit-headings-v1`) used only the model inputs, without employer-specific dictionaries, group metadata or gold data. On 100 Greenhouse validation records it achieved 99% exact-record accuracy, 100% job-ID accuracy, 99% employer/title accuracy, and field micro-F1 of 0.9974937343. The artifact is `work/extraction-corpus/deterministic-validation.json`. The test partition was not evaluated. This near-deterministic result materially weakens the case for spending credit on this clean-source corpus; genuinely messy third-party generalization remains unproven. A model baseline/fine-tune must demonstrate useful improvement before a Tinker category claim.

## TabPFN comparison

Fixed comparators: older-first age heuristic, deterministic L2 logistic regression (train-only standardization, null indicators and one-hot source types; 1,200 full-batch steps, learning rate 0.05, L2 0.01), and TabPFN-3.5 API with four estimators and seed 17. The numeric matrices are the same for logistic and TabPFN. No names, full URLs, ad text, reviewer identifiers, or official-result fields go to TabPFN.

For each holdout, report non-interpolated **average precision**, class prevalence, recall/precision at a predeclared 20% investigation budget, and false-positive/false-negative counts. Average precision is labeled precisely; it is not trapezoidal PR-AUC. Score ties use record-ID order for the fixed budget, while AP groups ties. No model or threshold is selected using the test set. The API runner makes one prediction over concatenated validation/test inputs, then evaluates the partitions separately; no held-out labels are sent to fit.

The API runner requests a dimension-only quota estimate before uploading feature values and rejects unknown billing units or an estimate over the caller's token ceiling. It saves pending prediction state and imposes a 300-second wait ceiling. An estimate is not a cost guarantee, and a local timeout is not server cancellation. Inspect provider quota and state before any retry. There is no automatic plan upgrade, overage, or data deletion. The model-version alias is recorded; its resolved checkpoint may change at the provider.

## Tinker comparison

Use a currently available Qwen model with its chat template, identically disabled thinking, and the same system prompt for base/checkpoint sampling. Model inputs contain only a JSON-encoded advertisement and URL. Retrieved text remains untrusted; the extractor has no tools or publication authority. Reject malformed output rather than repairing it with gold information.

Response-only next-token SFT uses a shifted input/target sequence and masks all prompt-token losses. Defaults: rank 16, learning rate 0.0001, batch size 8, one epoch, at most 30 steps, a default 4,096 total tokens per example (explicitly configurable up to 16,384 before model evaluation), 100,000 planned training tokens, and a 600-second wait ceiling. These limits may block a corpus. Choose a justified budget before a provider run; do not silently truncate inputs or omit held-out failures. A tokenizer-only `preflight` action can count all planned train/validation/test inputs without credentials or Tinker calls. It downloads only tokenizer files, using a project-local cache. Any context/budget change must be explicitly recorded before the first model result; failed/long examples cannot silently disappear. Only train rows enter gradient requests. The runner saves a sampler checkpoint with a one-hour TTL and records the dataset hash, prompt hash, training IDs, and settings. Checkpoint storage may still incur charges during its lifetime.

Compare base and checkpoint at temperature 0, one sample each, max 512 completion tokens, first on validation. Freeze all choices before a single held-out test comparison. Report exact job-ID accuracy, normalized employer accuracy, field micro precision/recall/F1, invalid-JSON count, exact-record accuracy, and the number/accuracy of non-null job IDs separately. Names/titles normalize NFKC, case and whitespace only; job IDs retain exact case/punctuation. The sample count, raw outputs, elapsed time, checkpoint and absolute metric changes remain inspectable. A saved checkpoint, lower training loss, or positive fixture result alone does not qualify as improvement.

## Release gates

- Tinker: real reviewed corpus, frozen unseen-employer/template holdout, successful fine-tune, actual held-out base/checkpoint comparison, useful observed improvement and provider usage receipt. Requires an appropriate extraction corpus, project credential, confirmed bounded free-credit budget, and an authorized run. Account access alone does not satisfy this gate; the existing clean-source baseline argues for caution before spending credit.
- TabPFN: same independent labels and frozen split, actual API predictions, baselines and held-out report, quota receipt. Currently blocked on data, credentials, and an authorized run. Browser quota availability is not evidence that this project ran.
- Serving: establish measured benefit before exposing an extra prediction service. The TypeScript core currently remains independent of model availability.

## Primary sources checked October 30, 2026

- [Prior Labs API client, authentication, persistence and quoting](https://github.com/PriorLabs/tabpfn-client)
- [Prior Labs estimator version selection](https://github.com/PriorLabs/tabpfn-client/blob/main/src/tabpfn_client/estimator.py)
- [Prior Labs cost estimation](https://github.com/PriorLabs/tabpfn-client/blob/main/src/tabpfn_client/cost.py)
- [Tinker SDK loss masking and training flow](https://tinker-docs.thinkingmachines.ai/tinker/sdk-cheatsheet/)
- [Tinker training-client API](https://tinker-docs.thinkingmachines.ai/tinker/api-reference/trainingclient/)
- [Tinker session lifecycle](https://tinker-docs.thinkingmachines.ai/tinker/api-reference/serviceclient/)
- [Tinker checkpoint lifetime](https://tinker-docs.thinkingmachines.ai/tinker/howto/checkpoints/)

Optional requirements pin `tabpfn-client==0.7.0` and `tinker==0.36.0`, with current official SDK signatures checked before a real run. Provider endpoints remain unexecuted; offline import/conformance results will be stated separately from successful provider use. Recheck package/docs compatibility before the first real run. No local TabPFN weights or non-commercial license acceptance is needed for the API path.
