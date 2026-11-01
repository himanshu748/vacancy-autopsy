"""Frozen extraction comparison with measured latency and uncached token costs.

Prepare downloads public tokenizer files only. Run requires explicit provider
authorization and refuses a retained attempt, including an uncertain submission.
No training, checkpoint creation, input truncation or automatic sampling retries occur.
"""
from __future__ import annotations

import argparse
import contextlib
from concurrent.futures import TimeoutError as FutureWaitTimeout
from datetime import datetime, timezone
import hashlib
import io
import json
import logging
import math
import os
from pathlib import Path
import signal
import time
from typing import Any, Callable

from data import DataError
from extraction_baseline import extract
from extraction_data import load_extraction_experiment
from extractor import SYSTEM_PROMPT, messages
from metrics import extraction_metrics
from tinker_runner import prompt_tokens

PRICE_URL = "https://tinker-docs.thinkingmachines.ai/tinker/models.json"
PRICE_PAGE = "https://tinker-docs.thinkingmachines.ai/tinker/models/models_and_pricing/"
MAX_COMPLETION = 512


class BenchmarkDeadline(RuntimeError):
    """A hard run deadline must never be mistaken for a local Future wait."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def save(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def percentile(values: list[float], fraction: float) -> float:
    """Linear interpolation at (n-1)*q, matching NumPy's default definition."""
    ordered = sorted(values)
    if not ordered or not 0 <= fraction <= 1:
        raise ValueError("Nonempty latency sample and percentile [0,1] required")
    position = (len(ordered) - 1) * fraction
    lower, upper = math.floor(position), math.ceil(position)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def token_cost(input_tokens: int, output_tokens: int, rates: dict[str, float]) -> float:
    return (input_tokens * rates["prefill"] + output_tokens * rates["sample"]) / 1_000_000


def enforce_budget(committed: float, next_worst_case: float, cap: float) -> None:
    if not all(math.isfinite(v) and v >= 0 for v in (committed, next_worst_case, cap)):
        raise DataError("Finite nonnegative budget values required")
    if committed + next_worst_case > cap + 1e-12:
        raise DataError("Projected Tinker spend exceeds the approved cap; no sample submitted")


def wait_same_future(future: Any, wait_seconds: int, on_pending: Callable[[], None]) -> Any:
    """Wait again on an existing handle; this function cannot submit a sample."""
    while True:
        try:
            return future.result(timeout=wait_seconds)
        except FutureWaitTimeout:
            if future.done():
                raise
            on_pending()


def load_inputs(args) -> tuple[dict[str, list[dict]], dict]:
    splits, frozen = load_extraction_experiment(args.dataset, args.manifest)
    training = json.loads(args.training_artifact.read_text())
    exploratory = json.loads(args.exploratory.read_text())
    freeze = json.loads(args.exploratory_freeze.read_text())
    if (training.get("status") != "completed" or training.get("base_model") != "Qwen/Qwen3-8B"
            or training.get("dataset_sha256") != frozen["dataset_sha256"]
            or training.get("prompt_sha256") != digest(SYSTEM_PROMPT.encode())
            or training.get("train_ids") != [r["id"] for r in splits["train"]]):
        raise DataError("Checkpoint does not match the unchanged frozen training protocol")
    if (digest(args.exploratory.read_bytes()) != freeze["recordsSha256"]
            or freeze["promptSha256"] != digest(SYSTEM_PROMPT.encode())
            or len(exploratory) != 20 or len(splits["validation"]) != 100):
        raise DataError("The complete frozen 100/20 evaluation inputs are required")
    if any(digest(r["advertisement_text"].encode()) != r["advertisement_sha256"] for r in exploratory):
        raise DataError("Exploratory captured text changed")
    rows = {"greenhouse_validation": splits["validation"], "third_party_exploratory": exploratory}
    metadata = {
        "dataset_sha256": frozen["dataset_sha256"],
        "manifest_sha256": digest(args.manifest.read_bytes()),
        "exploratory_records_sha256": freeze["recordsSha256"],
        "training_artifact_sha256": digest(args.training_artifact.read_bytes()),
        "prompt_sha256": digest(SYSTEM_PROMPT.encode()),
        "row_ids": {name: [r["id"] for r in values] for name, values in rows.items()},
        "messages_sha256": {r["id"]: digest(json.dumps(messages(r), ensure_ascii=False).encode())
                            for values in rows.values() for r in values},
    }
    return rows, metadata


def pricing(args) -> tuple[dict[str, dict], str]:
    prices = json.loads(args.pricing_json.read_text())
    capabilities = json.loads(args.capabilities_json.read_text())
    available = {r["model_name"] for r in capabilities if r.get("sampleable") is True}
    candidates = [r for r in prices if r["tinker_id"] in available
                  and r["tinker_id"].startswith("Qwen/") and ":" not in r["tinker_id"]
                  and r["params"] > 8_000_000_000 and "Base" not in r["tinker_id"]]
    preferred = next((r for r in candidates if r["tinker_id"] == "Qwen/Qwen3-32B"), None)
    if not candidates:
        raise DataError("No priced, sampleable larger Qwen model available")
    larger = preferred or max(candidates, key=lambda r: r["params"])
    base = next(r for r in prices if r["tinker_id"] == "Qwen/Qwen3-8B")
    if base["tinker_id"] not in available:
        raise DataError("Required base Qwen3-8B is not sampleable")
    all_models = {"tuned_8b": base, "base_8b": base, "larger_qwen": larger}
    selected = {alias: all_models[alias] for alias in args.model_aliases}
    return selected, larger["tinker_id"]


def tokenizer_for(model: str, cache: Path):
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(model, cache_dir=cache, trust_remote_code=False, token=False)
    if tokenizer.eos_token_id is None:
        raise DataError("Tokenizer must expose an EOS token")
    return tokenizer


def prepare(args) -> dict:
    if args.output.exists():
        raise DataError("Choose a new receipt; prior preparations and attempts are retained")
    rows, metadata = load_inputs(args)
    selected, larger = pricing(args)
    tokenizers = {model: tokenizer_for(model, args.tokenizer_cache) for model in {"Qwen/Qwen3-8B", larger}}
    models = {}
    projected = 0.0
    for alias, price in selected.items():
        rates = {name: float(price[name].removeprefix("$")) for name in ("prefill", "sample")}
        counts = {name: [len(prompt_tokens(tokenizers[price["tinker_id"]], r)) for r in values]
                  for name, values in rows.items()}
        if any(v + MAX_COMPLETION > 16384 for values in counts.values() for v in values):
            raise DataError("A complete input exceeds the common context limit; no truncation")
        inputs = sum(sum(values) for values in counts.values())
        worst = token_cost(inputs, 120 * MAX_COMPLETION, rates)
        projected += worst
        models[alias] = {"model": price["tinker_id"], "params": price["params"],
                         "active_params": price["active_params"], "architecture": price["arch"],
                         "rates_per_million_usd": rates, "prompt_token_counts": counts,
                         "worst_case_usd": worst}
    enforce_budget(args.prior_reserved_usd, projected, args.spend_cap_usd)
    report = {"kind": "tinker_cost_latency_benchmark", "status": "prepared", "prepared_at": now(),
              "provider_samples_submitted": 0, "protocol": metadata, "models": models,
              "pricing": {"json_url": PRICE_URL, "page_url": PRICE_PAGE,
                          "snapshot_sha256": digest(args.pricing_json.read_bytes()), "checked_at": now(),
                          "assumption": "Full uncached prefill; no cache discounts; token estimate, not invoice"},
              "temperature": 0.0, "max_completion_tokens": MAX_COMPLETION,
              "thinking_enabled": False, "sampling_order": "serial, complete models: " + ", ".join(args.model_aliases),
              "latency_definition": "Wall time around one sample call/result, includes provider/network queue; excludes client/tokenizer setup and decoding",
              "percentile_definition": "Linear interpolation at (n-1)*q",
              "spend_cap_usd": args.spend_cap_usd, "full_run_worst_case_usd": projected,
              "prior_reserved_usd": args.prior_reserved_usd,
              "all_attempts_worst_case_usd": args.prior_reserved_usd + projected,
              "request_wait_seconds": args.request_wait_seconds,
              "max_seconds": args.max_seconds,
              "caller_retries": 0, "in_flight": None,
              "limitations": ["One deterministic repetition; latency is a single serial run, not a controlled load test.",
                              "Validation employers and exploratory employers overlap; no new unseen-employer generalization claim.",
                              "No training or retuning; earlier 18/20 third-party regression remains part of the record.",
                              "Larger model can use a different native tokenizer/chat template; prompt messages and schema are identical.",
                              "Tinker transport may retry idempotently; application sampling retries are disabled."]}
    save(args.output, report)
    return report


def summarize(rows: list[dict], predictions: list[dict], rates: dict | None) -> dict:
    latencies = [p["latency_seconds"] for p in predictions]
    inputs, outputs = sum(p["input_tokens"] for p in predictions), sum(p["output_tokens"] for p in predictions)
    cost = token_cost(inputs, outputs, rates) if rates else None
    return {"count": len(predictions), "metrics": extraction_metrics([r["gold"] for r in rows], [p["raw"] for p in predictions]),
            "latency_seconds_p50": percentile(latencies, .5), "latency_seconds_p95": percentile(latencies, .95),
            "input_tokens": inputs, "output_tokens": outputs, "gross_uncached_estimate_usd": cost,
            "usd_per_1000_listings": cost * 1000 / len(predictions) if cost is not None else None}


def compose_attempts(initial: Path, completion: Path, output: Path) -> dict:
    """Compose the declared complete passes, retaining the earlier failure audit.

    This performs no provider action and never substitutes partial predictions.
    The full replacement base pass is selected before its results are inspected.
    """
    first, second = json.loads(initial.read_text()), json.loads(completion.read_text())
    if first["protocol"] != second["protocol"] or second["status"] != "completed":
        raise DataError("Composition requires matching frozen inputs and a complete replacement pass")
    if (first["pricing"] != second["pricing"]
            and first["pricing"]["snapshot_sha256"] != second["pricing"]["snapshot_sha256"]):
        raise DataError("Pricing changed between the retained attempts")
    if any(first["models"][alias] != second["models"][alias] for alias in ("base_8b", "larger_qwen")):
        raise DataError("Baseline models, tokenization or rates changed between attempts")
    if (first.get("status") != "interrupted_or_failed" or not first.get("in_flight")
            or not math.isclose(second.get("prior_reserved_usd", -1), first.get("committed_worst_case_usd", -2), rel_tol=0, abs_tol=1e-12)
            or set(second["models"]) != {"base_8b", "larger_qwen"}):
        raise DataError("The retained failed attempt and its cost reservation must be explicit")
    results = {"tuned_8b": first["results"]["tuned_8b"], "base_8b": second["results"]["base_8b"],
               "larger_qwen": second["results"]["larger_qwen"], "deterministic_parser": second["results"]["deterministic_parser"]}
    for model, parts in results.items():
        if set(parts) != set(first["protocol"]["row_ids"]):
            raise DataError("Every declared partition is required for every primary model")
        for partition, part in parts.items():
            if (part["status"] != "completed"
                    or [p["id"] for p in part["predictions"]] != first["protocol"]["row_ids"][partition]
                    or part["summary"]["count"] != len(part["predictions"])):
                raise DataError("Incomplete or reordered primary results cannot be composed")
    known_cost = first["gross_uncached_estimate_usd"] + second["gross_uncached_estimate_usd"]
    unknown_bound = first["in_flight"]["reserved_usd"]
    all_bound = second["committed_worst_case_usd"]
    enforce_budget(0, all_bound, second["spend_cap_usd"])
    models = {"tuned_8b": first["models"]["tuned_8b"], "base_8b": second["models"]["base_8b"],
              "larger_qwen": second["models"]["larger_qwen"]}
    primary_count = sum(len(part["predictions"]) for alias, parts in results.items()
                        if alias != "deterministic_parser" for part in parts.values())
    parser_count = sum(len(part["predictions"]) for part in results["deterministic_parser"].values())
    all_responses = sum(len(part["predictions"]) for attempt in (first, second)
                        for alias, parts in attempt["results"].items() if alias != "deterministic_parser"
                        for part in parts.values())
    report = {key: first[key] for key in ("kind", "protocol", "pricing", "temperature", "max_completion_tokens",
                                         "thinking_enabled", "latency_definition", "percentile_definition", "spend_cap_usd")}
    report.update({"status": "completed", "started_at": first["started_at"], "finished_at": second["finished_at"],
        "models": models, "results": results, "in_flight": None,
        "primary_provider_response_count": primary_count, "completed_rows_including_parser": primary_count + parser_count,
        "provider_samples_submitted": first["provider_samples_submitted"] + second["provider_samples_submitted"],
        "all_attempt_completed_provider_responses": all_responses,
        "prior_uncertain_submissions": [first["in_flight"]],
        "all_attempts_worst_case_usd": all_bound,
        "all_attempts_known_response_estimate_usd": known_cost,
        "all_attempts_estimate_usd_range": [known_cost, known_cost + unknown_bound],
        "full_run_worst_case_usd": sum(m["worst_case_usd"] for m in models.values()),
        "gross_uncached_estimate_usd": sum(part["summary"]["gross_uncached_estimate_usd"]
            for alias, parts in results.items() if alias != "deterministic_parser" for part in parts.values()),
        "primary_selection": {"tuned_8b": "All 120 completed responses from initial pass",
                              "base_8b": "All 120 responses from the predeclared complete replacement pass; first pass retained, no result-based selection",
                              "larger_qwen": "All 120 newly submitted responses in completion pass",
                              "deterministic_parser": "All 120 local parser calls in completion pass"},
        "attempts": [{"receipt": str(path), "sha256": digest(path.read_bytes()), "status": data["status"],
                      "submitted": data["provider_samples_submitted"], "error_type": data.get("error_type")}
                     for path, data in ((initial, first), (completion, second))],
        "limitations": first["limitations"] + [
            "The initial pass stopped with TimeoutError during the nineteenth base-model exploratory request. Its acceptance/result remain unconfirmed and its maximum token cost is reserved.",
            "Completed-pass latency percentiles exclude the retained failed pass. They are not failure-inclusive service latency or reliability estimates.",
            "The complete base pass and the first larger-model pass occurred in a later session; fixed serial order and time windows can affect latency."]})
    if output.exists() and output.read_bytes() != initial.read_bytes():
        raise DataError("Final receipt differs from the retained first attempt; refusing overwrite")
    save(output, report)
    return report


def run(args) -> dict:
    report = json.loads(args.output.read_text())
    if report["status"] != "prepared" or report["provider_samples_submitted"] or report["in_flight"]:
        raise DataError("A previous benchmark attempt exists; never automatically resubmit")
    rows, metadata = load_inputs(args)
    if (metadata != report["protocol"] or args.spend_cap_usd != report["spend_cap_usd"]
            or args.prior_reserved_usd != report["prior_reserved_usd"]
            or args.model_aliases != list(report["models"])
            or args.request_wait_seconds != report["request_wait_seconds"]):
        raise DataError("Frozen benchmark protocol or approved cap changed")
    enforce_budget(args.prior_reserved_usd, report["full_run_worst_case_usd"], args.spend_cap_usd)
    training = json.loads(args.training_artifact.read_text())
    if training.get("project_id") != os.environ.get("TINKER_PROJECT_ID"):
        raise DataError("Training checkpoint and configured project differ")
    os.environ.pop("TINKER_CREDENTIAL_CMD", None)
    os.environ.pop("TINKER_BASE_URL", None)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_CACHE"] = str(args.tokenizer_cache.resolve())
    import tinker
    from tinker.lib.retry_handler import RetryConfig
    service = None
    report.update(status="running", started_at=now(), results={}, committed_worst_case_usd=args.prior_reserved_usd)
    save(args.output, report)
    def timeout(*_):
        raise BenchmarkDeadline("Benchmark deadline reached; retained attempt must be inspected")
    old_handler = signal.signal(signal.SIGALRM, timeout)
    signal.alarm(args.max_seconds)
    try:
        service = tinker.ServiceClient(api_key=os.environ["TINKER_API_KEY"], project_id=os.environ["TINKER_PROJECT_ID"],
            base_url="https://tinker.thinkingmachines.dev/services/tinker-prod", display_name="Vacancy Autopsy frozen cost/latency benchmark")
        retry = RetryConfig(enable_retry_logic=False, max_connections=1, progress_timeout=args.request_wait_seconds)
        for alias, model in report["models"].items():
            sampler = service.create_sampling_client(**({"model_path": training["checkpoint"]} if alias == "tuned_8b"
                                                        else {"base_model": model["model"]}), retry_config=retry)
            if sampler.get_base_model() != model["model"]:
                raise DataError("Sampler renderer differs from frozen model")
            tokenizer = sampler.get_tokenizer()
            params = tinker.types.SamplingParams(max_tokens=MAX_COMPLETION, temperature=0.0, stop=[tokenizer.eos_token_id])
            report["results"][alias] = {}
            for partition, values in rows.items():
                predictions = []
                report["results"][alias][partition] = {"status": "running", "predictions": predictions}
                for index, row in enumerate(values):
                    tokens = prompt_tokens(tokenizer, row)
                    if len(tokens) != model["prompt_token_counts"][partition][index]:
                        raise DataError("Tokenizer output differs from prepared protocol")
                    worst = token_cost(len(tokens), MAX_COMPLETION, model["rates_per_million_usd"])
                    enforce_budget(report["committed_worst_case_usd"], worst, args.spend_cap_usd)
                    report["committed_worst_case_usd"] += worst
                    report["provider_samples_submitted"] += 1
                    report["in_flight"] = {"model": alias, "partition": partition, "id": row["id"], "started_at": now(), "reserved_usd": worst}
                    save(args.output, report)
                    started = time.perf_counter()
                    future = sampler.sample(prompt=tinker.types.ModelInput.from_ints(tokens), num_samples=1, sampling_params=params)
                    def observed_pending():
                        report["in_flight"]["last_observed_pending_at"] = now()
                        report["in_flight"]["wait_timeouts"] = report["in_flight"].get("wait_timeouts", 0) + 1
                        save(args.output, report)
                    response = wait_same_future(future, args.request_wait_seconds, observed_pending)
                    elapsed = time.perf_counter() - started
                    if len(response.sequences) != 1 or len(response.sequences[0].tokens) > MAX_COMPLETION:
                        raise DataError("Unexpected provider response length")
                    output_tokens = response.sequences[0].tokens
                    predictions.append({"id": row["id"], "raw": tokenizer.decode(output_tokens, skip_special_tokens=True),
                                        "input_tokens": len(tokens), "output_tokens": len(output_tokens), "latency_seconds": elapsed})
                    report["in_flight"] = None
                    save(args.output, report)
                report["results"][alias][partition].update(status="completed", summary=summarize(values, predictions, model["rates_per_million_usd"]))
                save(args.output, report)
        report["results"]["deterministic_parser"] = {}
        for partition, values in rows.items():
            predictions = []
            for row in values:
                started = time.perf_counter()
                result = extract(row["advertisement_url"], row["advertisement_text"])
                elapsed = time.perf_counter() - started
                predictions.append({"id": row["id"], "raw": json.dumps(result), "input_tokens": 0, "output_tokens": 0, "latency_seconds": elapsed})
            report["results"]["deterministic_parser"][partition] = {"status": "completed", "predictions": predictions, "summary": summarize(values, predictions, None)}
        report["status"] = "completed"
    except BaseException as exc:
        report.update(status="interrupted_or_failed", error_type=type(exc).__name__, retry_permitted=False)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)
        report["finished_at"] = now()
        completed = [p for partitions in report["results"].values() for part in partitions.values() for p in part.get("predictions", [])]
        report["completed_rows_including_parser"] = len(completed)
        report["gross_uncached_estimate_usd"] = sum(
            token_cost(sum(p["input_tokens"] for part in partitions.values() for p in part.get("predictions", [])),
                       sum(p["output_tokens"] for part in partitions.values() for p in part.get("predictions", [])),
                       report["models"][alias]["rates_per_million_usd"])
            for alias, partitions in report["results"].items() if alias in report["models"])
        if service:
            try:
                service.close(status="success" if report["status"] == "completed" else "errored", detail="Frozen extraction cost and latency comparison").result(timeout=5)
                report["session_close_confirmed"] = True
            except Exception:
                report["session_close_confirmed"] = False
        save(args.output, report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("prepare", "run"))
    for name in ("dataset", "manifest", "training-artifact", "exploratory", "exploratory-freeze", "pricing-json", "capabilities-json", "tokenizer-cache", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--spend-cap-usd", type=float, default=3.0)
    parser.add_argument("--max-seconds", type=int, default=1800)
    parser.add_argument("--model-aliases", nargs="+", choices=("tuned_8b", "base_8b", "larger_qwen"), default=["tuned_8b", "base_8b", "larger_qwen"])
    parser.add_argument("--prior-reserved-usd", type=float, default=0.0)
    parser.add_argument("--request-wait-seconds", type=int, default=60)
    parser.add_argument("--allow-provider-run", action="store_true")
    args = parser.parse_args()
    if (not 0 < args.spend_cap_usd <= 3 or not 1 <= args.max_seconds <= 3600
            or not 1 <= args.request_wait_seconds <= 180
            or not math.isfinite(args.prior_reserved_usd) or args.prior_reserved_usd < 0
            or len(set(args.model_aliases)) != len(args.model_aliases)):
        raise DataError("This harness permits at most the approved $3 and one-hour deadline")
    if args.phase == "run" and (not args.allow_provider_run or not os.environ.get("TINKER_API_KEY") or not os.environ.get("TINKER_PROJECT_ID")):
        raise DataError("Run requires explicit authorization and this project's Tinker settings")
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    for name in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACEHUB_API_TOKEN"):
        os.environ.pop(name, None)
    logging.disable(logging.CRITICAL)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        result = prepare(args) if args.phase == "prepare" else run(args)
    print(json.dumps({"status": result["status"], "receipt": str(args.output), "full_run_worst_case_usd": result["full_run_worst_case_usd"],
                      "provider_samples_submitted": result["provider_samples_submitted"], "gross_uncached_estimate_usd": result.get("gross_uncached_estimate_usd")}))
    if result["status"] == "interrupted_or_failed":
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except (Exception, KeyboardInterrupt) as exc:
        raise SystemExit(f"Benchmark stopped ({type(exc).__name__}); inspect the retained receipt before another attempt. No raw provider errors are printed.") from None
