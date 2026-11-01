"""Bounded JSON CLI for a fitted TabPFN verification-priority model.

The caller supplies pre-check features only. Scores order a shortlist; they are
not calibrated job-status probabilities or employer-intent findings. A saved
accepted request is resumed rather than submitted again after interruption.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import io
import json
import math
import os
import re
from pathlib import Path
import signal
import sys
from datetime import datetime, timezone
from typing import Any, Callable

from data import FEATURES, NUMERIC_FEATURES, SOURCE_TYPES

MAX_INPUT_BYTES = 64_000
MAX_ROWS = 20
DEADLINE_SECONDS = 30


class RankingError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def validate_request(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, dict) or set(value) != {"rows"}:
        raise RankingError("INVALID_INPUT", "Supply rows containing only IDs and pre-check features.")
    rows = value["rows"]
    if not isinstance(rows, list) or not 2 <= len(rows) <= MAX_ROWS:
        raise RankingError("INVALID_INPUT", "Supply between two and twenty shortlist rows.")
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"id", "features"}:
            raise RankingError("INVALID_INPUT", "Each row requires exactly id and features.")
        identity = row["id"]
        if not isinstance(identity, str) or not identity.strip() or len(identity) > 128 or identity in seen:
            raise RankingError("INVALID_INPUT", "Shortlist row IDs must be unique bounded strings.")
        seen.add(identity)
        features = row["features"]
        if not isinstance(features, dict) or set(features) != set(FEATURES):
            raise RankingError("INVALID_INPUT", "Use only the six pre-verification feature fields.")
        for name in NUMERIC_FEATURES:
            number = features[name]
            if number is None:
                continue
            if type(number) not in (int, float) or not math.isfinite(number) or not 0 <= number <= 1_000_000:
                raise RankingError("INVALID_INPUT", "Numeric features must be finite, nonnegative or null.")
            if name in {"employer_name_similarity", "title_consistency", "ats_link_present"} and number > 1:
                raise RankingError("INVALID_INPUT", "Similarity and ATS-link fields must be between zero and one.")
            if name in {"repost_count", "ats_link_present"} and int(number) != number:
                raise RankingError("INVALID_INPUT", "Repost count and ATS-link fields must be integral.")
        if features["source_type"] not in SOURCE_TYPES:
            raise RankingError("INVALID_INPUT", "Unknown shortlist source type.")
    return rows


def load_context(path: Path) -> dict[str, Any]:
    try:
        if path.stat().st_size > MAX_INPUT_BYTES:
            raise ValueError()
        context = json.loads(path.read_text())
        if (context["schema_version"] != 1 or context["project"] != "Vacancy Autopsy"
                or context["task"] != "relative_verification_priority"
                or context["numeric_features"] != list(NUMERIC_FEATURES)
                or context["source_types"] != list(SOURCE_TYPES)
                or context["model_version"] != "v3.5" or context["n_estimators"] != 4 or context["seed"] != 17
                or not re.fullmatch(r"[0-9a-f]{64}", context["training_dataset_sha256"])):
            raise ValueError()
        for key in ("centers", "scales"):
            values = context["encoder"][key]
            if set(values) != set(NUMERIC_FEATURES):
                raise ValueError()
            if any(type(x) not in (int, float) or not math.isfinite(x)
                   or abs(x) > 1_000_000_000 or (key == "scales" and x <= 0) for x in values.values()):
                raise ValueError()
        state = (path.parent / context["model_state_path"]).resolve()
        if not state.is_relative_to(path.parent.resolve()) or state.stat().st_size > MAX_INPUT_BYTES:
            raise ValueError()
        if hashlib.sha256(state.read_bytes()).hexdigest() != context["model_state_sha256"]:
            raise ValueError()
        if type(context["training_rows"]) is not int or context["training_rows"] <= 0:
            raise ValueError()
        saved = json.loads(state.read_text())
        if (saved["task"] != "classification" or saved["classes"] != [0, 1]
                or saved["n_train_rows"] != context["training_rows"]
                or saved["fit_status"] != "completed" or saved["pending_prediction"] is not None
                or saved["params"]["model_path"] != "v3.5_default"
                or saved["params"]["n_estimators"] != 4 or saved["params"]["random_state"] != 17):
            raise ValueError()
        context["state_path"] = state
        return context
    except (OSError, KeyError, TypeError, ValueError, OverflowError):
        raise RankingError("INVALID_CONTEXT", "The fitted priority model is missing or invalid.") from None


def encode(rows: list[dict[str, Any]], context: dict[str, Any]) -> list[list[float]]:
    output = []
    for row in rows:
        vector = []
        for name in NUMERIC_FEATURES:
            value = row["features"][name]
            vector.extend((0.0 if value is None else
                           (value - context["encoder"]["centers"][name]) / context["encoder"]["scales"][name],
                           float(value is None)))
        vector.extend(float(row["features"]["source_type"] == kind) for kind in SOURCE_TYPES)
        if any(not math.isfinite(x) for x in vector):
            raise RankingError("INVALID_CONTEXT", "Priority feature encoding exceeded its numeric bounds.")
        output.append(vector)
    return output


def atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as handle:
        json.dump(value, handle, ensure_ascii=False, allow_nan=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def read_json(path: Path) -> Any:
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise RankingError("INVALID_CONTEXT", "Saved priority operation exceeds its bound.")
    return json.loads(path.read_text())


def rank(rows: list[dict[str, Any]], context: dict[str, Any], context_path: Path,
         provider_factory: Callable[[dict[str, Any]], Any]) -> dict[str, Any]:
    """Serialize local operations and retain accepted remote state before waiting."""
    matrix = encode(rows, context)
    digest = hashlib.sha256(json.dumps({"state": context["model_state_sha256"], "rows": rows},
                                      sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    runtime = context_path.parent / "runtime"
    runtime.mkdir(mode=0o700, exist_ok=True)
    lock_path = runtime / "lock"
    with os.fdopen(os.open(lock_path, os.O_WRONLY | os.O_CREAT, 0o600), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RankingError("BUSY", "Another shortlist ranking is running. Please wait.") from None
        batch = runtime / digest
        if not batch.exists() and sum(1 for item in runtime.iterdir() if item.is_dir()) >= 1000:
            raise RankingError("STORAGE_FULL", "Saved priority operations need maintenance before another request.")
        batch.mkdir(mode=0o700, exist_ok=True)
        result_path = batch / "result.json"
        active_path = runtime / "active.json"
        if result_path.exists():
            result = read_json(result_path)
            result["operation"]["reused"] = True
            if active_path.exists():
                active = read_json(active_path)
                # The result is committed before the active marker is removed.
                # Recover a crash in that window while holding the same lock.
                # Unknown or unrelated state must continue blocking new work.
                if (isinstance(active, dict) and set(active) == {"batch", "phase"}
                        and active["batch"] == digest and active["phase"] == "pending"):
                    active_path.unlink(missing_ok=True)
            return result
        active = read_json(active_path) if active_path.exists() else None
        if active and active["batch"] != digest:
            raise RankingError("PENDING_RESULT", "A prior shortlist is still pending. Retry the same shortlist first.")
        pending = batch / "pending-model.json"
        if active and not pending.exists():
            raise RankingError("UNCERTAIN_SUBMISSION", "A prior request needs provider-state review before another prediction.")
        provider = provider_factory(context)
        if active:
            quote = read_json(batch / "quote.json")
            model = provider.resume(pending)
            # A prior submit can save the accepted model before the pending
            # marker is committed. Successful resume establishes that state.
            atomic_json(active_path, {"batch": digest, "phase": "pending"})
        else:
            quote = provider.quote(matrix)
            atomic_json(batch / "quote.json", quote)
            # The intent precedes the request: interruption during submission must
            # block a blind retry if the remote accepted it but its ID was not saved.
            atomic_json(active_path, {"batch": digest, "phase": "submitting", "startedAt": datetime.now(timezone.utc).isoformat()})
            model = provider.submit(matrix, pending)
            atomic_json(active_path, {"batch": digest, "phase": "pending"})
        scores = provider.wait(model)
        if len(scores) != len(rows) or any(type(x) not in (int, float) or not math.isfinite(x) or not 0 <= x <= 1 for x in scores):
            raise RankingError("PROVIDER_FAILED", "The priority provider returned an invalid ranking.")
        ordered = sorted(zip(rows, scores), key=lambda pair: (-pair[1], pair[0]["id"]))
        output = []
        prior = None
        position = 0
        for index, (row, score) in enumerate(ordered, 1):
            if prior is None or score != prior:
                position = index
            output.append({"id": row["id"], "priority": score, "rank": position})
            prior = score
        result = {"ranked": output, "model": {"provider": "TabPFN", "version": context["model_version"],
                  "basis": "relative_verification_priority", "trainingDataset": context["training_dataset_sha256"]},
                  "usage": quote, "operation": {"reused": bool(active), "completedAt": datetime.now(timezone.utc).isoformat()},
                  "limitations": ["Experimental relative priority, not a job-status or employer-intent finding.",
                                  "Missing pre-check information can leave candidates indistinguishable.",
                                  "A small retrospective benchmark does not establish production accuracy."]}
        atomic_json(result_path, result)
        active_path.unlink(missing_ok=True)
        return result


class TabPFNProvider:
    def __init__(self, context: dict[str, Any]):
        import numpy as np
        from tabpfn_client import TabPFNClassifier, estimate_cost
        from tabpfn_client.config import get_access_token
        from tabpfn_client.client import ServiceClient
        self.np = np
        self.classifier = TabPFNClassifier
        self.estimate = estimate_cost
        self.usage = lambda: ServiceClient.get_api_usage(get_access_token())
        self.context = context

    def quote(self, matrix: list[list[float]]) -> dict[str, Any]:
        # Only dimensions reach the quote endpoint; no training values are needed.
        usage = self.usage()
        limits = [usage["daily_limit"] - usage["daily_usage"], usage["monthly_limit"] - usage["monthly_usage"]]
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in limits):
            raise RankingError("QUOTA_EXHAUSTED", "Provider allowance could not be verified.")
        available = min(limits)
        quote = self.estimate(self.np.zeros((self.context["training_rows"], len(matrix[0]))),
                              self.np.asarray(matrix), model_version=self.context["model_version"],
                              n_estimators=self.context["n_estimators"])
        if quote.pricing_version != "quota_v3" or not 0 < quote.estimated_cost <= available:
            raise RankingError("QUOTA_EXHAUSTED", "The ranking quote exceeds the remaining provider allowance.")
        return {"quotedTokens": quote.estimated_cost, "dailyRemainingBefore": limits[0], "monthlyRemainingBefore": limits[1]}

    def submit(self, matrix: list[list[float]], path: Path):
        model = self.classifier.load_model(self.context["state_path"])
        model.submit_predict(self.np.asarray(matrix, dtype=float), output_type="probas")
        model.save_model(path)
        return model

    def resume(self, path: Path):
        return self.classifier.load_model(path)

    def wait(self, model) -> list[float]:
        probabilities = model.wait_for_predict()
        return probabilities[:, list(model.classes_).index(1)].tolist()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--context", type=Path, required=True)
    parser.add_argument("--allow-provider-run", action="store_true")
    args = parser.parse_args()
    try:
        content = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        if len(content) > MAX_INPUT_BYTES:
            raise RankingError("INVALID_INPUT", "The shortlist request exceeds its size bound.")
        try:
            rows = validate_request(json.loads(content))
        except (ValueError, TypeError):
            raise RankingError("INVALID_INPUT", "Supply a valid JSON shortlist.") from None
        if not args.allow_provider_run or not os.environ.get("TABPFN_TOKEN"):
            raise RankingError("NOT_CONFIGURED", "Project priority scoring is not connected.")
        context = load_context(args.context.resolve())
        os.environ.pop("TABPFN_CLIENT_API_URL", None)
        os.environ["TABPFN_CLIENT_TIMEOUT"] = "20"
        os.environ["TABPFN_CLIENT_UPLOAD_TIMEOUT"] = "20"
        os.environ["TABPFN_CLIENT_ASYNC_POLL_TIMEOUT"] = str(DEADLINE_SECONDS)
        def timeout(_signal, _frame):
            raise TimeoutError()
        signal.signal(signal.SIGALRM, timeout)
        signal.alarm(DEADLINE_SECONDS)
        # Do not expose SDK greeting messages, provider responses or credentials.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = rank(rows, context, args.context.resolve(), TabPFNProvider)
        signal.alarm(0)
        print(json.dumps(result, allow_nan=False))
        return 0
    except RankingError as error:
        response = {"error": {"code": error.code, "message": str(error)}}
    except TimeoutError:
        response = {"error": {"code": "TIMEOUT", "message": "Priority scoring timed out. Retry the same shortlist to resume its saved request."}}
    except BaseException:
        response = {"error": {"code": "PROVIDER_FAILED", "message": "Priority scoring could not finish. No automatic retry was made."}}
    finally:
        signal.alarm(0)
    print(json.dumps(response))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
