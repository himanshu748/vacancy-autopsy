# Model experiments

Status: Tinker training, all 400 original base/checkpoint comparisons and a separate 40-output exploratory third-party comparison completed, as did the fixed TabPFN API benchmark on a separate independently AI-reviewed priority corpus. Both model actions have run through the real browser workspace. The listing reader suggests candidate identity; Shortlist gives relative check order. Official availability verdicts still come from first-party source checks.

## Actual Tinker result

| Split | Base exact-record | Tuned exact-record | Base field F1 | Tuned field F1 |
| --- | ---: | ---: | ---: | ---: |
| 100 unseen Greenhouse page-text validation rows | 80% | 100% | 0.95 | 1.00 |
| 100 unseen Ashby native-JSON test rows | 100% | 100% | 1.00 | 1.00 |

The fine-tune corrected 20 validation title errors, including dropped location qualifiers. Job-ID and employer accuracy remained 100%; both models produced zero invalid JSON responses in both splits. The untouched native-JSON test was a ceiling tie, so no test improvement or production accuracy is claimed. The deterministic validation parser already scored 99% exact-record accuracy. All 297 source rows and the frozen employer/template partitions were retained; the corpus is predominantly structured-source data, not a representative messy third-party ad benchmark.

The real run used Qwen/Qwen3-8B, rank 16, one epoch, 13 steps, 339,094 training input tokens and an explicit 16,384-token context. Complete-run token ceilings were 350,000 / 425,000 / 1,025,000 for training / validation / test, with 1,800 seconds per action. The default 100,000-token limit would reject this full corpus and was not silently bypassed. No model or prompt changes followed the frozen test choice.

Private receipts are in workspace `work/model-live-v1/`: `training.json`, `validation.json`, `test.json`, `test-freeze.json`, `results-summary.json` and `checkpoint-retention.json`. Do not rerun completed artifacts or publish private checkpoint identifiers. The original seven-day retention was later superseded by a 90-day extension. The unchanged sampler remains private through **January 28, 2027, at 10:20 PM IST**; the current retention receipt is in ignored workspace `work/model-realworld-v1/checkpoint-retention-90days.json`.

Original experiment tokens were estimated at **$0.5132**; the initial seven-day storage estimate of **$0.00431** made the initial envelope about **$0.5175**. Current full 90-day storage for the measured 184.7 MB checkpoint is estimated at **$0.05540784**. The separate exploratory comparison adds **$0.01321434** in estimated tokens. These are gross rate-card estimates, not a verified bill or credit deduction. The initial billing read had no project rows and documented data lag; that does not establish zero cost. No automatic top-up, billing purchase or plan change occurred. [Full results and limits](../docs/MODEL-EXPERIMENTS.md).

A separate exploratory check on 20 complete OppIDX captures found **base 20/20 versus fine-tuned 18/20 exact records and job IDs**; employer, title and ATS were correct in both. All 40 outputs were retained. The tuned errors substituted third-party URL slugs for numeric Greenhouse IDs. Frozen job identities had no overlap with the original partitions, but the employers overlapped validation. This is not a new preregistered unseen-employer test, and no retuning followed it. The product guard now nulls candidate IDs that fail numeric-Greenhouse/UUID-Lever-or-Ashby formats or complete-boundary grounding checks. Raw benchmark results remain unchanged; no post-guard model accuracy is claimed.

## Actual TabPFN result

One fixed TabPFN-3.5 API prediction, four estimators and seed 17, used 10,000 quota tokens. The public corpus has 132 records split into 82 training, 20 validation and 30 test rows, with employers/templates disjoint. Features were captured before first-party verification and independently reviewed by another AI agent, not a human.

Test average precision was **0.92276**, versus **0.89251** for both age and logistic baselines. At six checks, TabPFN selected **6/17 exact-ID absences with zero false positives**; baselines selected 5/17 with one false positive. All 17 test negatives were already publisher-marked INACTIVE. Validation features all tied (AP 0.65 for every method), with no improvement. This is a small retrospective demonstration, not production accuracy or discovery of unmarked stale ads. AP is non-interpolated average precision, not trapezoidal PR-AUC.

All 50 held-out scores, quota observations and frozen model context remain in ignored workspace `work/priority-corpus/`. The Shortlist browser journey exercised real ranking, selection into the check form, and state preservation when returning. It displays relative order, never a probability that a job is fake.

## Use the local model actions

Install provider requirements only for the actions you intend to run, in private project-specific Python environments. Keep secrets in the ignored application `.env` and use absolute private paths or paths relative to the application working directory:

```text
TINKER_API_KEY=...
TINKER_PROJECT_ID=...
TINKER_EXTRACTOR_ARTIFACT=/private/path/to/completed-training-artifact.json
TINKER_PYTHON=/private/path/to/tinker-env/bin/python
TINKER_TOKENIZER_CACHE=/private/path/to/project-tokenizer-cache
TABPFN_TOKEN=...
TABPFN_PRIORITY_CONTEXT=/private/path/to/frozen-model-context.json
TABPFN_PYTHON=/private/path/to/tabpfn-env/bin/python
```

Do not copy another project's keys, context or checkpoint. The trained Tinker artifact must match the intended project/prompt/model, and its checkpoint must still exist. Prepare the tokenizer cache before serving: the request path uses the existing cache rather than downloading model files. The private TabPFN context must have its validated companion state, with writable private persistent storage for `runtime/` so accepted requests can resume after restart. Provider-expired state fails closed rather than retraining silently. Contexts and raw provider state are local artifacts, not bundled in source.

Start the application from this directory with `npm start` after a production build. “Read listing details” accepts public advertisement text and returns grounded candidate fields. Shortlist accepts 2–20 user-entered rows, including optional known age/repost information. Missing facts stay null; neither action checks an official source before making its model request. Missing configuration, provider errors or model expiry produce an explicit unavailable/error state without a simulated result.

The serving paths serialize requests, enforce input/output bounds and deadlines, and keep credentials on the server. TabPFN saves submission intent and accepted pending state before waiting; a matching accepted retry resumes it, an uncertain submission cannot blindly resubmit, and an identical completed batch reuses the genuine result. These are single-workspace, single-storage controls, not distributed exactly-once guarantees. Remaining project credits are authorized, while upgrades, purchases and auto-reload are not enabled by these commands.

Run the dependency-free checks from the project root:

```sh
python3 -m unittest discover -s ml/tests -v
```

All test records are synthetic, generated in memory, and refused by the production benchmark loader. See [the experiment protocol](../docs/MODEL-EXPERIMENTS.md) for record fields, sources, acceptance gates, and limitations.

For **priority prediction**, create independently reviewed public records with both real priority classes in `ml/artifacts/records.jsonl`, then freeze its holdout:

```sh
python3 ml/prepare.py ml/artifacts/records.jsonl --output ml/artifacts/split.json
python3 ml/priority.py ml/artifacts/records.jsonl ml/artifacts/split.json \
  --output ml/artifacts/baselines.json
```

`prepare.py` refuses insufficient data. It writes a blocked manifest when the split exists but does not meet the sample gate. An impossible joint holdout fails before writing a manifest. Subsequent runners recalculate every partition, verify the dataset hash, and refuse changed manifests. Existing report paths are retained instead of overwritten.

Optional provider environments are separate; neither is needed for the deterministic verifier or dependency-free tests. They are needed for their respective live model actions. Use Python 3.11+ and create the environment only after adequate disk space is available:

```sh
python3 -m venv .venv
source .venv/bin/activate
# Install only the provider you intend to test:
python3 -m pip install -r ml/requirements-tabpfn.txt
# Or: python3 -m pip install -r ml/requirements-tinker.txt
```

For TabPFN, set `TABPFN_TOKEN` securely in your shell. This API path uploads the allowlisted feature matrix and training labels to Prior Labs; no employer names, URLs, advertisement text, or reviewer IDs are included. Check current quota first. The following is a generic explicit provider-run template. The completed build used its frozen reviewed corpus and retained a separate benchmark artifact; do not rerun that fixed test for model selection:

```sh
python3 ml/priority.py ml/artifacts/records.jsonl ml/artifacts/split.json \
  --output ml/artifacts/tabpfn.json --with-tabpfn --allow-provider-run \
  --max-provider-tokens 100000
```

The script requests a dimension-only estimate and refuses estimates that exceed the token ceiling or use unknown billing units. The estimate is not a guaranteed final bill. It performs one standard v3.5 API prediction over combined validation/test features, with fixed settings and four estimators. It saves provider model/pending-request state beside the report. After an interruption, inspect that state and quota before resubmitting. A wait timeout does not cancel server work. Server-retained data is not automatically deleted.

For **Tinker extraction**, use its separate record contract and manifest. Current public postings may all be open; that does not supply a TabPFN training target. Preserve counterpart source files beside the extraction JSONL because the loader verifies their hashes and exact ID/title bindings. No synthesized absent IDs or pretend manual reviews are needed or accepted.

```sh
python3 ml/prepare_extraction.py /path/to/extraction/records.jsonl \
  --output /path/to/extraction/split.json
python3 ml/extraction_baseline.py /path/to/extraction/records.jsonl \
  /path/to/extraction/split.json --output ml/artifacts/deterministic-validation.json
```

The fixed zero-model baseline reads native JSON fields and explicit HTML headings, plus exact ATS URLs. It never reads gold fields or guesses employer aliases from board slugs. Run validation first; keep the test partition untouched until choices are frozen. A largely structured corpus may already be solved by deterministic parsing and may not justify a fine-tune.

Before any Tinker call, run a tokenizer-only preflight:

```sh
python3 ml/tinker_runner.py preflight /path/to/extraction/records.jsonl \
  /path/to/extraction/split.json --base-model 'Qwen/<available-model>' \
  --output ml/artifacts/preflight.json
```

This downloads tokenizer files from the selected public Qwen repository into a local cache, not model weights. It counts every train/validation/test prompt and worst-case comparison token total without a Tinker key or provider call. Its default 4,096-token total context cap can block full public ads. If a larger cap is justified, choose it explicitly with `--max-context-tokens` (at most 16,384), price the entire experiment, and record that decision before seeing model outputs. Do not silently truncate inputs or omit failed held-out rows.

For Tinker, set `TINKER_API_KEY` securely. Set `TINKER_PROJECT_ID` or pass `--project-id` to keep runs in the intended project. Keep `HF_HOME` under a local ignored cache when using SDK tokenizer helpers. Review current model availability, token rates, free balance, and checkpoint storage charges before using either authorization flag. `Qwen/<available-model>` below is a placeholder; choose a supported Qwen model from the console. These are generic command templates; the measured run used the explicit full-corpus settings above and retained separate artifacts:

```sh
python3 ml/tinker_runner.py train /path/to/extraction/records.jsonl /path/to/extraction/split.json \
  --base-model 'Qwen/<available-model>' --output ml/artifacts/training.json \
  --allow-provider-run --credits-confirmed --max-tokens 100000 --max-seconds 600
python3 ml/tinker_runner.py compare /path/to/extraction/records.jsonl /path/to/extraction/split.json \
  --training-artifact ml/artifacts/training.json --partition validation \
  --output ml/artifacts/extraction-validation.json --allow-provider-run \
  --credits-confirmed --max-tokens 100000 --max-seconds 600
# Freeze all choices after validation, then evaluate test once with --partition test.
```

The training runner uses response-only next-token loss, excludes verification/gold data from model inputs, and sends training rows only. It rejects examples over the explicitly declared context ceiling rather than silently truncating away IDs. Its token ceiling can refuse a large corpus; lowering the sample to evade a data gate is not an acceptable workaround. The runner saves a sampler checkpoint with a one-hour TTL by default, so compare promptly. The measured run first extended that private checkpoint to seven days, then separately to 90 days; retained receipts record both changes. The SDK can download tokenizer files when `get_tokenizer()` is first called; it does not download model weights. The Tinker runner made real requests in the completed experiment above. Offline SDK conformance remains separate evidence; local imports alone never establish provider execution. TabPFN status remains separate from this result.

No command enables billing, changes plans, accepts a model license, or reads credentials from another project. The optional local extractor supplies candidate fields only; it does not replace the first-party verifier or authorize a public deployment.
