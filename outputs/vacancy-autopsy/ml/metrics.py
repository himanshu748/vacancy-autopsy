"""Dependency-free metrics, with explicit treatment of ties and malformed JSON."""
from __future__ import annotations

import json
import math
import re
import unicodedata
from typing import Any

from data import GOLD_FIELDS


def priority_metrics(labels: list[int], scores: list[float], ids: list[str], budget: int) -> dict[str, Any]:
    if not labels or len(labels) != len(scores) or len(labels) != len(ids) or len(set(ids)) != len(ids):
        raise ValueError("Aligned nonempty labels, scores, and unique IDs required")
    if set(labels) != {0, 1} or any(type(label) is not int for label in labels) or any(not math.isfinite(s) for s in scores):
        raise ValueError("Both classes and finite scores are required")
    if type(budget) is not int or not 1 <= budget <= len(labels):
        raise ValueError("Budget must be between one and the cohort size")
    ranked = sorted(zip(labels, scores, ids), key=lambda item: (-item[1], item[2]))
    positives = sum(labels)
    tp = total = 0
    ap = 0.0
    # Non-interpolated AP: each tied score group introduces one recall increment.
    position = 0
    while position < len(ranked):
        end = position + 1
        while end < len(ranked) and ranked[end][1] == ranked[position][1]:
            end += 1
        new_positives = sum(row[0] for row in ranked[position:end])
        tp += new_positives
        total += end - position
        ap += (new_positives / positives) * (tp / total)
        position = end
    selected = ranked[:budget]
    selected_tp = sum(row[0] for row in selected)
    return {
        "average_precision": ap,
        "metric_definition": "non-interpolated average precision; not trapezoidal PR-AUC",
        "positive_prevalence": positives / len(labels),
        "count": len(labels), "positive_count": positives,
        "investigation_budget": budget,
        "recall_at_budget": selected_tp / positives,
        "precision_at_budget": selected_tp / budget,
        "false_positives_at_budget": budget - selected_tp,
        "false_negatives_at_budget": positives - selected_tp,
        "selected_ids": [row[2] for row in selected],
        "budget_tie_rule": "score descending, record ID ascending",
    }


def normalize_name(value: str | None) -> str | None:
    if value is None:
        return None
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value).casefold()).strip()


def parse_prediction(raw: str) -> dict[str, str | None] | None:
    if not isinstance(raw, str) or len(raw) > 10000:
        return None
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(value, dict) or set(value) != set(GOLD_FIELDS):
        return None
    if any(item is not None and (not isinstance(item, str) or len(item) > 500 or not item.strip()) for item in value.values()):
        return None
    if value["ats"] not in (None, "greenhouse", "lever", "ashby"):
        return None
    return value


def extraction_metrics(gold: list[dict[str, Any]], raw_predictions: list[str]) -> dict[str, Any]:
    if not gold or len(gold) != len(raw_predictions):
        raise ValueError("Aligned nonempty gold and predictions required")
    correct = dict.fromkeys(GOLD_FIELDS, 0)
    present_correct = dict.fromkeys(GOLD_FIELDS, 0)
    tp = fp = fn = malformed = exact = 0
    for truth, raw in zip(gold, raw_predictions):
        prediction = parse_prediction(raw)
        malformed += prediction is None
        row_correct = 0
        for field in GOLD_FIELDS:
            expected = truth[field]
            actual = prediction[field] if prediction is not None else None
            # IDs deliberately preserve case/punctuation; only human names/titles normalize.
            comparable = normalize_name if field in ("employer", "title") else lambda value: value
            match = prediction is not None and comparable(actual) == comparable(expected)
            correct[field] += int(match)
            present_correct[field] += int(match and expected is not None)
            row_correct += int(match)
            if actual is not None and expected is not None and match:
                tp += 1
            else:
                fp += actual is not None
                fn += expected is not None
        exact += row_correct == len(GOLD_FIELDS)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    return {
        "count": len(gold), "invalid_json_count": malformed,
        "exact_record_accuracy": exact / len(gold),
        "job_id_exact_accuracy": correct["job_id"] / len(gold),
        "job_id_present_count": sum(row["job_id"] is not None for row in gold),
        "job_id_present_exact_accuracy": (
            sum(parse_prediction(raw) is not None and parse_prediction(raw)["job_id"] == row["job_id"]
                for row, raw in zip(gold, raw_predictions) if row["job_id"] is not None)
            / sum(row["job_id"] is not None for row in gold)
        ) if any(row["job_id"] is not None for row in gold) else None,
        "employer_normalized_accuracy": correct["employer"] / len(gold),
        "field_accuracy": {key: count / len(gold) for key, count in correct.items()},
        "field_present_count": {key: sum(row[key] is not None for row in gold) for key in GOLD_FIELDS},
        "field_present_accuracy": {
            key: present_correct[key] / sum(row[key] is not None for row in gold)
            if any(row[key] is not None for row in gold) else None for key in GOLD_FIELDS
        },
        "field_micro_precision": precision, "field_micro_recall": recall,
        "field_micro_f1": 2 * precision * recall / (precision + recall) if precision + recall else 0.0,
        "normalization": "NFKC, casefold, collapse whitespace for employer/title only; no alias guesses",
    }
