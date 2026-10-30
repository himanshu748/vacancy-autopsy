"""Opt-in Tinker SFT and fixed base/checkpoint comparison.

No provider action occurs without both authorization flags and TINKER_API_KEY.
Token ceilings are execution bounds, not dollar guarantees; confirm current rates
and free balance externally. No account, billing, or license setup is automated.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from importlib.metadata import version
import json
import math
import os
from pathlib import Path
import signal
import time
from typing import Any

from data import DataError, sha256, write_json
from extraction_data import load_extraction_experiment
from extractor import SYSTEM_PROMPT, assert_extraction_labels, messages, shifted_datum_values
from metrics import extraction_metrics


def prompt_tokens(tokenizer: Any, row: dict[str, Any]) -> list[int]:
    # This runner is restricted to the Qwen family; use its chat template and
    # disable optional thinking identically for train, baseline, and checkpoint.
    return tokenizer.apply_chat_template(messages(row), tokenize=True, add_generation_prompt=True, enable_thinking=False)


def preflight(args, splits, frozen) -> dict[str, Any]:
    """Download tokenizer files only, count every planned input, call no provider."""
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.base_model, cache_dir=args.tokenizer_cache_dir, trust_remote_code=False, token=False)
    if tokenizer.eos_token_id is None:
        raise DataError("Tokenizer has no explicit EOS token")
    partitions = {}
    for partition, rows in splits.items():
        counts = []
        over_limit = []
        for row in rows:
            prefix = prompt_tokens(tokenizer, row)
            completion = tokenizer.encode(json.dumps(row["gold"], ensure_ascii=False), add_special_tokens=False) + [tokenizer.eos_token_id]
            total = len(prefix) + (len(completion) if partition == "train" else 512)
            counts.append({"id": row["id"], "prompt_tokens": len(prefix), "gold_completion_tokens": len(completion),
                           "worst_case_total_tokens": total})
            if total > args.max_context_tokens:
                over_limit.append(row["id"])
        partitions[partition] = {"count": len(rows), "records": counts, "over_context_limit_ids": over_limit,
            "prompt_tokens": sum(row["prompt_tokens"] for row in counts),
            "training_input_tokens": sum(row["prompt_tokens"] + row["gold_completion_tokens"] - 1 for row in counts) if partition == "train" else 0,
            "base_and_tuned_worst_case_tokens": 2 * (sum(row["prompt_tokens"] for row in counts) + len(rows) * 512) if partition != "train" else 0}
    return {"kind": "tinker_preflight", "status": "ready" if not any(p["over_context_limit_ids"] for p in partitions.values()) else "blocked_context_limit",
            "provider_called": False, "model_weights_downloaded": False,
            "dataset_sha256": frozen["dataset_sha256"], "prompt_sha256": sha256(SYSTEM_PROMPT),
            "base_model": args.base_model, "max_context_tokens": args.max_context_tokens,
            "tokenizer_class": type(tokenizer).__name__, "partitions": partitions,
            "limits": "Token counts only, not a dollar quote. Review current provider rates and the complete train/validation/test budget before a run."}


def train(args, splits, frozen, service, tinker) -> dict[str, Any]:
    if not args.base_model.startswith("Qwen/"):
        raise DataError("This renderer is restricted to Qwen; supply an available Qwen base model")
    if not 1 <= args.epochs <= 3 or not 1 <= args.batch_size <= 16 or not 1 <= args.max_steps <= 100:
        raise DataError("Expected epochs 1–3, batch size 1–16, and max steps 1–100")
    client = service.create_lora_training_client(base_model=args.base_model, rank=16, seed=frozen["seed"])
    tokenizer = client.get_tokenizer()
    if tokenizer.eos_token_id is None:
        raise DataError("Tokenizer has no explicit EOS token")
    datum_values = []
    for row in splits["train"]:
        prefix = prompt_tokens(tokenizer, row)
        completion = tokenizer.encode(json.dumps(row["gold"], ensure_ascii=False), add_special_tokens=False) + [tokenizer.eos_token_id]
        if len(prefix) + len(completion) > args.max_context_tokens:
            raise DataError("Training example exceeds the declared context limit; do not silently truncate or omit held-out failures")
        datum_values.append(shifted_datum_values(prefix, completion))
    total_tokens = sum(len(item["input_tokens"]) for item in datum_values) * args.epochs
    step_count = math.ceil(len(datum_values) / args.batch_size) * args.epochs
    if total_tokens > args.max_tokens or step_count > args.max_steps:
        raise DataError("Planned complete training run exceeds token/step ceiling; no gradient request submitted")
    dataset = [tinker.types.Datum(
        model_input=tinker.types.ModelInput.from_ints(item["input_tokens"]),
        loss_fn_inputs={"target_tokens": item["target_tokens"], "weights": item["weights"]},
    ) for item in datum_values]
    steps = 0
    started = time.monotonic()
    for _ in range(args.epochs):
        # The frozen training order is deterministic; there is no test data here.
        for start in range(0, len(dataset), args.batch_size):
            client.forward_backward(dataset[start:start + args.batch_size], "cross_entropy").result()
            client.optim_step(tinker.types.AdamParams(learning_rate=0.0001)).result()
            steps += 1
    checkpoint = client.save_weights_for_sampler(
        name="vacancy-autopsy-extractor", ttl_seconds=3600,
        user_metadata={"dataset_sha256": frozen["dataset_sha256"], "prompt_sha256": sha256(SYSTEM_PROMPT)},
    ).result()
    return {
        "kind": "tinker_training", "status": "completed", "base_model": args.base_model,
        "checkpoint": checkpoint.path, "checkpoint_ttl_seconds": 3600,
        "dataset_sha256": frozen["dataset_sha256"], "prompt_sha256": sha256(SYSTEM_PROMPT),
        "train_ids": [row["id"] for row in splits["train"]],
        "epochs": args.epochs, "rank": 16, "learning_rate": 0.0001,
        "batch_size": args.batch_size, "steps": steps, "training_input_tokens": total_tokens,
        "max_context_tokens": args.max_context_tokens,
        "elapsed_seconds": time.monotonic() - started,
        "limitations": ["Completed training alone does not demonstrate improved held-out extraction.",
                        "Checkpoint storage may incur charges until its TTL expires; inspect provider usage."],
    }


def compare(args, splits, frozen, service, tinker) -> dict[str, Any]:
    training = json.loads(args.training_artifact.read_text())
    if (training.get("kind") != "tinker_training" or training.get("status") != "completed"
        or training.get("dataset_sha256") != frozen["dataset_sha256"]
        or training.get("train_ids") != [row["id"] for row in splits["train"]]
        or training.get("prompt_sha256") != sha256(SYSTEM_PROMPT)):
        raise DataError("Training artifact does not match frozen data, training rows, and extraction prompt")
    base_model = training["base_model"]
    if not base_model.startswith("Qwen/"):
        raise DataError("Unsupported renderer family")
    baseline = service.create_sampling_client(base_model=base_model)
    tuned = service.create_sampling_client(model_path=training["checkpoint"])
    if tuned.get_base_model() != base_model:
        raise DataError("Checkpoint base model differs from baseline")
    tokenizer = baseline.get_tokenizer()
    rows = splits[args.partition]
    prompts = [prompt_tokens(tokenizer, row) for row in rows]
    if args.max_context_tokens != training.get("max_context_tokens", 4096):
        raise DataError("Evaluation context limit differs from the frozen training choice")
    if any(len(tokens) + 512 > args.max_context_tokens for tokens in prompts):
        raise DataError("Evaluation input exceeds the preregistered context cap")
    planned_tokens = 2 * (sum(map(len, prompts)) + len(rows) * 512)
    if planned_tokens > args.max_tokens:
        raise DataError("Worst-case comparison tokens exceed ceiling; no samples submitted")
    params = tinker.types.SamplingParams(max_tokens=512, temperature=0.0, stop=[tokenizer.eos_token_id])
    report: dict[str, Any] = {
        "kind": "tinker_comparison", "status": "running", "partition": args.partition,
        "dataset_sha256": frozen["dataset_sha256"], "prompt_sha256": sha256(SYSTEM_PROMPT),
        "base_model": base_model, "checkpoint": training["checkpoint"],
        "temperature": 0.0, "max_completion_tokens": 512,
        "worst_case_tokens": planned_tokens, "test_use": "one fixed comparison, no tuning on held-out results",
        "models": {},
    }
    for name, sampler in (("base", baseline), ("fine_tuned", tuned)):
        predictions = []
        started = time.monotonic()
        for row, tokens in zip(rows, prompts):
            result = sampler.sample(prompt=tinker.types.ModelInput.from_ints(tokens), num_samples=1, sampling_params=params).result()
            predictions.append({"id": row["id"], "raw": tokenizer.decode(result.sequences[0].tokens, skip_special_tokens=True)})
            # Retain progress before the next request. Never blindly resubmit a timed-out run.
            report["models"][name] = {"predictions": predictions, "status": "running"}
            write_json(args.output, report)
        report["models"][name] = {
            "predictions": predictions, "status": "completed", "elapsed_seconds": time.monotonic() - started,
            "metrics": extraction_metrics([row["gold"] for row in rows], [row["raw"] for row in predictions]),
        }
    before = report["models"]["base"]["metrics"]
    after = report["models"]["fine_tuned"]["metrics"]
    report["absolute_improvement"] = {
        key: after[key] - before[key]
        for key in ("job_id_exact_accuracy", "employer_normalized_accuracy", "field_micro_f1")
    }
    report["status"] = "completed"
    report["limitations"] = ["A single deterministic comparison does not quantify stochastic or sampling uncertainty.",
                             "Positive improvement must be observed; it is never assumed from a saved checkpoint."]
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "train", "compare"))
    parser.add_argument("dataset", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-model")
    parser.add_argument("--training-artifact", type=Path)
    parser.add_argument("--partition", choices=("validation", "test"), default="validation")
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-steps", type=int, default=30)
    parser.add_argument("--max-tokens", type=int, default=100000)
    parser.add_argument("--max-seconds", type=int, default=600)
    parser.add_argument("--max-context-tokens", type=int, default=4096)
    parser.add_argument("--tokenizer-cache-dir", type=Path)
    parser.add_argument("--project-id", default=os.environ.get("TINKER_PROJECT_ID"))
    parser.add_argument("--allow-provider-run", action="store_true")
    parser.add_argument("--credits-confirmed", action="store_true")
    args = parser.parse_args()
    if not 512 <= args.max_context_tokens <= 16384:
        raise SystemExit("Context ceiling must be between 512 and 16,384 tokens")
    if args.output.exists():
        raise SystemExit("Choose a new output path; retained experiment artifacts are not overwritten")
    args.tokenizer_cache_dir = args.tokenizer_cache_dir or args.output.parent / "tokenizer-cache"
    if args.action == "preflight":
        if not args.base_model or not args.base_model.startswith("Qwen/"):
            raise SystemExit("Preflight requires an available Qwen --base-model")
        splits, frozen = load_extraction_experiment(args.dataset, args.manifest)
        result = preflight(args, splits, frozen)
        write_json(args.output, result)
        print(f"Wrote tokenizer-only preflight to {args.output}; no Tinker provider call made.")
        return
    if not args.allow_provider_run or not args.credits_confirmed:
        raise SystemExit("Provider actions require --allow-provider-run and --credits-confirmed after reviewing free balance and current pricing")
    if not os.environ.get("TINKER_API_KEY"):
        raise SystemExit("Missing TINKER_API_KEY; no provider call made")
    if not 1 <= args.max_tokens <= 2_000_000 or not 1 <= args.max_seconds <= 1800:
        raise SystemExit("Token ceiling 1–2,000,000 and time ceiling 1–1800 seconds required")
    if args.action == "train" and not args.base_model:
        raise SystemExit("Training requires --base-model chosen from current available Qwen models")
    if args.action == "compare" and not args.training_artifact:
        raise SystemExit("Comparison requires --training-artifact")
    splits, frozen = load_extraction_experiment(args.dataset, args.manifest)
    assert_extraction_labels(splits)
    # Keep tokenizer cache local unless the user explicitly supplied a location.
    os.environ.setdefault("HF_HOME", str(args.tokenizer_cache_dir.resolve()))
    import tinker
    report: dict[str, Any] = {
        "status": "started", "action": args.action,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "tinker_version": version("tinker"), "dataset_sha256": frozen["dataset_sha256"],
        "max_tokens": args.max_tokens, "max_seconds": args.max_seconds,
        "max_context_tokens": args.max_context_tokens, "project_id": args.project_id,
    }
    service = None
    close_status = "errored"
    def timed_out(_signum, _frame):
        raise TimeoutError("Provider wait exceeded time ceiling; inspect usage before retrying")
    previous_handler = signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(args.max_seconds)
    try:
        service = tinker.ServiceClient(api_key=os.environ["TINKER_API_KEY"], project_id=args.project_id,
                                       display_name="Vacancy Autopsy extraction experiment",
                                       user_metadata={"dataset_sha256": frozen["dataset_sha256"], "task": "extraction"})
        result = train(args, splits, frozen, service, tinker) if args.action == "train" else compare(args, splits, frozen, service, tinker)
        report.update(result)
        close_status = "success"
    except BaseException as exc:
        report.update({"status": "interrupted_or_failed", "error_type": type(exc).__name__,
                       "next_step": "Inspect any partial comparison and provider usage before starting a new run."})
        # compare() writes per-sample progress. Retain it if it exists.
        if args.output.exists():
            partial = json.loads(args.output.read_text())
            partial.update(report)
            report = partial
        if isinstance(exc, (KeyboardInterrupt, TimeoutError)):
            close_status = "interrupted"
        raise
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous_handler)
        write_json(args.output, report)
        if service is not None:
            try:
                service.close(status=close_status, detail="Vacancy Autopsy bounded experiment").result(timeout=10)
            except Exception:
                print("Session close was not confirmed; inspect the provider console.")
    print(f"Wrote {args.action} artifact to {args.output}")


if __name__ == "__main__":
    try:
        main()
    except DataError as exc:
        raise SystemExit(str(exc)) from exc
