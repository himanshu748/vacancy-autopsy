"""Evaluate fixed investigation-priority baselines, optionally call TabPFN API.

Default execution is entirely local. Provider mode needs explicit flags, a token,
and a server quote within the supplied token ceiling. A quote is not a billing
guarantee. The API receives only the allowlisted numeric feature matrix and labels.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from importlib.metadata import version
import math
import os
from pathlib import Path
import signal
import time

from baselines import Encoder, age_scores, logistic_scores
from data import DataError, load_experiment, target, write_json
from metrics import priority_metrics


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--budget-fraction", type=float, default=0.2)
    parser.add_argument("--with-tabpfn", action="store_true")
    parser.add_argument("--allow-provider-run", action="store_true")
    parser.add_argument("--max-provider-tokens", type=int)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("Choose a new output path; previous experiment reports are retained")
    if not 0 < args.budget_fraction <= 1:
        raise SystemExit("Budget fraction must be in (0, 1]")
    if args.with_tabpfn and not (args.allow_provider_run and args.max_provider_tokens and args.max_provider_tokens > 0):
        raise SystemExit("Provider mode needs --allow-provider-run and --max-provider-tokens")
    splits, frozen = load_experiment(args.dataset, args.manifest)
    train = splits["train"]
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "dataset_sha256": frozen["dataset_sha256"], "seed": frozen["seed"],
        "positive_class": "exact posting not found in complete first-party feed at recorded time",
        "budget_fraction": args.budget_fraction,
        "test_use": "fixed settings; no test-set selection or tuning",
        "provider_called": False, "splits": {},
        "limitations": ["A retrospective labeled sample is not evidence of future production accuracy.",
                        "Sampling and source coverage can bias results; confidence intervals are not supplied."],
    }
    for name in ("validation", "test"):
        rows = splits[name]
        labels = [target(row) for row in rows]
        ids = [row["id"] for row in rows]
        budget = max(1, math.floor(len(rows) * args.budget_fraction))
        report["splits"][name] = {
            "age_heuristic": priority_metrics(labels, age_scores(train, rows), ids, budget),
            "logistic_regression": priority_metrics(labels, logistic_scores(train, rows), ids, budget),
        }
    if args.with_tabpfn:
        if not os.environ.get("TABPFN_TOKEN"):
            raise SystemExit("Missing TABPFN_TOKEN; no provider call made")
        state_path = args.output.with_suffix(".tabpfn-state.json")
        if state_path.exists():
            raise SystemExit("Provider state already exists; inspect it before starting another run")
        import numpy as np
        from tabpfn_client import TabPFNClassifier, estimate_cost
        encoder = Encoder(train)
        x_train = np.asarray(encoder.transform(train), dtype=float)[:, 1:]
        combined = splits["validation"] + splits["test"]
        x_test = np.asarray(encoder.transform(combined), dtype=float)[:, 1:]
        # One standard prediction; no thinking fits, cache retries, or seed search.
        quote = estimate_cost(x_train, x_test, model_version="v3.5", n_estimators=4)
        if quote.pricing_version != "quota_v3" or quote.estimated_cost > args.max_provider_tokens:
            raise SystemExit("Provider quote unavailable in token units or exceeds ceiling; no prediction submitted")
        report["quote"] = quote.model_dump(mode="json")
        report["tabpfn_client_version"] = version("tabpfn-client")
        report["tabpfn_model_alias"] = "v3.5_default"
        report["limitations"].append("The version alias can move to a newer checkpoint; resolved checkpoint not guaranteed by this client.")
        model = TabPFNClassifier.create_default_for_version("v3.5", n_estimators=4, random_state=frozen["seed"])
        start = time.monotonic()
        def timed_out(_signum, _frame):
            raise TimeoutError("Provider wait exceeded 300 seconds; inspect saved state before any retry")
        previous_handler = signal.signal(signal.SIGALRM, timed_out)
        signal.alarm(300)
        try:
            report["provider_called"] = True
            model.fit(x_train, np.asarray([target(row) for row in train]))
            model.save_model(state_path)
            model.submit_predict(x_test, output_type="probas")
            model.save_model(state_path)
            probabilities = model.wait_for_predict()
            positive_index = list(model.classes_).index(1)
            scores = probabilities[:, positive_index].tolist()
            report["provider_elapsed_seconds"] = time.monotonic() - start
            report["provider_timings"] = model.get_timings()
            offset = 0
            for name in ("validation", "test"):
                rows = splits[name]
                portion = scores[offset:offset + len(rows)]
                report["splits"][name]["tabpfn_api"] = priority_metrics(
                    [target(row) for row in rows], portion, [row["id"] for row in rows],
                    max(1, math.floor(len(rows) * args.budget_fraction)),
                )
                offset += len(rows)
            report["provider_status"] = "completed"
        except BaseException:
            report["provider_status"] = "interrupted_or_failed; inspect state and quota before resubmitting"
            write_json(args.output, report)
            raise
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGALRM, previous_handler)
    write_json(args.output, report)
    print(f"Wrote {'provider + baseline' if args.with_tabpfn else 'local baseline'} report to {args.output}")


if __name__ == "__main__":
    try:
        main()
    except DataError as exc:
        raise SystemExit(str(exc)) from exc
