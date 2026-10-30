# Model experiments

Status: separate extraction and priority experiment protocols are implemented. A captured extraction-only corpus can be frozen without inventing stale-job negatives. No trained checkpoint, TabPFN prediction, or model-improvement result is established. The TypeScript verifier uses deterministic URL identity matching; it does not call these runners.

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

Optional provider environments are separate; neither is needed for the app or tests. Use Python 3.11+ and create the environment only after adequate disk space is available:

```sh
python3 -m venv .venv
source .venv/bin/activate
# Install only the provider you intend to test:
python3 -m pip install -r ml/requirements-tabpfn.txt
# Or: python3 -m pip install -r ml/requirements-tinker.txt
```

For TabPFN, set `TABPFN_TOKEN` securely in your shell. This API path uploads the allowlisted feature matrix and training labels to Prior Labs; no employer names, URLs, advertisement text, or reviewer IDs are included. Check current quota first. The following is an explicit provider run, requires user authorization and a real ready dataset, and was **not run** during this build:

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

For Tinker, set `TINKER_API_KEY` securely. Set `TINKER_PROJECT_ID` or pass `--project-id` to keep runs in the intended project. Keep `HF_HOME` under a local ignored cache when using SDK tokenizer helpers. Review current model availability, token rates, free balance, and checkpoint storage charges before using either authorization flag. `Qwen/<available-model>` below is a placeholder; choose a supported Qwen model from the console. These commands were **not run**:

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

The training runner uses response-only next-token loss, excludes verification/gold data from model inputs, and sends training rows only. It rejects examples over the explicitly declared context ceiling rather than silently truncating away IDs. Its token ceiling can refuse a large corpus; lowering the sample to evade a data gate is not an acceptable workaround. The saved sampler checkpoint has a one-hour TTL, so compare promptly. The SDK can download tokenizer files when `get_tokenizer()` is first called; it does not download model weights. The provider runners have not called real endpoints. Offline SDK conformance checks and their limits are recorded in the experiment protocol; local imports never establish a successful model run.

No command enables billing, changes plans, accepts a model license, or reads credentials from another project. No prediction service is exposed until a useful model result and a deployment need justify it.
