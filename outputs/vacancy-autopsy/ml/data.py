"""Auditable experiment records and conservative, jointly grouped holdouts.

No network access or third-party dependencies. Validation cannot establish that a
human's provenance statement is truthful; the captured files remain reviewable.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

FEATURES = (
    "listing_age_days", "repost_count", "employer_name_similarity",
    "title_consistency", "ats_link_present", "source_type",
)
NUMERIC_FEATURES = FEATURES[:-1]
GOLD_FIELDS = ("employer", "title", "job_id", "ats")
SOURCE_TYPES = ("job_board", "search_cache", "official")
RECORD_FIELDS = {
    "id", "provenance", "employer_group", "template_group", "dedup_key",
    "advertisement_url", "advertisement_text", "advertisement_sha256",
    "advertisement_captured_at", "features_captured_at", "features",
    "verification", "gold",
}
VERIFICATION_FIELDS = {
    "source_url", "checked_at", "evidence_sha256", "complete",
    "identity_confirmed", "outcome", "reviewed_by", "label_method",
}


class DataError(ValueError):
    """Input cannot support the requested experiment."""


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def digest_records(records: list[dict[str, Any]]) -> str:
    return sha256(json.dumps(records, sort_keys=True, separators=(",", ":"), ensure_ascii=False))


def timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise DataError("Timestamps must be timezone-aware ISO strings")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise DataError("Invalid timestamp") from exc
    if result.tzinfo is None:
        raise DataError("Timezone required")
    return result


def public_url(value: Any) -> None:
    if not isinstance(value, str) or len(value) > 2048:
        raise DataError("URL must be a bounded string")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise DataError("Provenance URLs must be HTTPS without credentials")


def exact_keys(value: Any, keys: set[str], what: str) -> None:
    if not isinstance(value, dict) or set(value) != keys:
        raise DataError(f"{what}: expected exactly {sorted(keys)}")


def validate_record(row: dict[str, Any], *, allow_synthetic: bool = False) -> dict[str, Any]:
    exact_keys(row, RECORD_FIELDS, "record")
    provenance = row["provenance"]
    if provenance != "real_public" and not (allow_synthetic and provenance == "synthetic_test"):
        raise DataError("Only real_public records may enter a benchmark")
    for key in ("id", "employer_group", "template_group", "dedup_key"):
        if not isinstance(row[key], str) or not row[key].strip() or len(row[key]) > 256:
            raise DataError(f"Invalid {key}")
    text = row["advertisement_text"]
    if not isinstance(text, str) or not 1 <= len(text) <= 32000:
        raise DataError("Advertisement text must contain 1–32,000 characters")
    if sha256(text) != row["advertisement_sha256"]:
        raise DataError("Advertisement content hash mismatch")
    public_url(row["advertisement_url"])
    ad_at = timestamp(row["advertisement_captured_at"])
    features_at = timestamp(row["features_captured_at"])
    verification = row["verification"]
    exact_keys(verification, VERIFICATION_FIELDS, "verification")
    checked_at = timestamp(verification["checked_at"])
    if not ad_at <= features_at < checked_at:
        raise DataError("Features must be frozen before independent verification")
    if (checked_at - features_at).total_seconds() > 86400:
        raise DataError("Verification exceeds the preregistered 24-hour label window")
    public_url(verification["source_url"])
    if urlsplit(verification["source_url"]).hostname not in {
        "boards-api.greenhouse.io", "boards-api.eu.greenhouse.io",
        "api.lever.co", "api.eu.lever.co", "api.ashbyhq.com",
    }:
        raise DataError("Verification must reference a supported first-party ATS API")
    evidence_hash = verification["evidence_sha256"]
    if not isinstance(evidence_hash, str) or len(evidence_hash) != 64 or any(c not in "0123456789abcdef" for c in evidence_hash):
        raise DataError("Verification requires a SHA-256 evidence reference")
    if verification["complete"] is not True or verification["identity_confirmed"] is not True:
        raise DataError("Incomplete or ambiguous verification cannot become a label")
    if verification["outcome"] not in ("verified_open", "not_listed"):
        raise DataError("Inconclusive findings must be excluded, never labeled stale")
    if verification["label_method"] != "independent_first_party_review":
        raise DataError("Model predictions and heuristics cannot supply ground truth")
    if not isinstance(verification["reviewed_by"], str) or not verification["reviewed_by"].strip():
        raise DataError("A reviewer identifier is required")
    features = row["features"]
    exact_keys(features, set(FEATURES), "features (no extra, post-verification fields)")
    for name in NUMERIC_FEATURES:
        value = features[name]
        if value is None:
            continue
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1_000_000:
            raise DataError(f"Invalid numeric feature: {name}")
        if name in ("employer_name_similarity", "title_consistency", "ats_link_present") and value > 1:
            raise DataError(f"Feature {name} must be between 0 and 1")
        if name in ("repost_count", "ats_link_present") and int(value) != value:
            raise DataError(f"Feature {name} must be integral")
    if features["source_type"] not in SOURCE_TYPES:
        raise DataError("Unknown source_type")
    gold = row["gold"]
    exact_keys(gold, set(GOLD_FIELDS), "gold")
    for key, value in gold.items():
        if value is not None and (not isinstance(value, str) or not value.strip() or len(value) > 500):
            raise DataError(f"Invalid extraction label: {key}")
    if not gold["employer"] or not gold["title"]:
        raise DataError("Gold employer and title require independent annotation")
    if gold["ats"] not in ("greenhouse", "lever", "ashby", None):
        raise DataError("Invalid gold ATS")
    return row


def load_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    ids: set[str] = set()
    if path.stat().st_size > 32_000_000:
        raise DataError("Dataset exceeds the 32 MB experiment limit")
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = validate_record(json.loads(line))
        except (ValueError, TypeError) as exc:
            raise DataError(f"Row {number}: {exc}") from exc
        if row["id"] in ids:
            raise DataError("Duplicate record ID")
        ids.add(row["id"])
        records.append(row)
    if not records:
        raise DataError("No real labeled records; benchmark is blocked")
    return records


def target(row: dict[str, Any]) -> int:
    return int(row["verification"]["outcome"] == "not_listed")


def deduplicate(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep earliest observation of either the same job or identical ad content.

    Repeated checks are not independent samples. A changed outcome over time is
    expected and does not justify including the same job in both partitions.
    """
    seen_keys: set[str] = set()
    seen_content: set[str] = set()
    unique = []
    for row in sorted(records, key=lambda r: (timestamp(r["features_captured_at"]), r["id"])):
        if row["dedup_key"] not in seen_keys and row["advertisement_sha256"] not in seen_content:
            unique.append(row)
        seen_keys.add(row["dedup_key"])
        seen_content.add(row["advertisement_sha256"])
    return unique


def joint_components(records: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Connect records sharing employer OR template; no group crosses a split."""
    parents = list(range(len(records)))

    def root(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    seen: dict[tuple[str, str], int] = {}
    for index, row in enumerate(records):
        for field in ("employer_group", "template_group"):
            key = field, row[field].strip().casefold()
            if key in seen:
                parents[root(index)] = root(seen[key])
            else:
                seen[key] = index
    groups: dict[int, list[dict[str, Any]]] = {}
    for index, row in enumerate(records):
        groups.setdefault(root(index), []).append(row)
    return list(groups.values())


def make_split(records: list[dict[str, Any]], seed: int = 17) -> dict[str, list[dict[str, Any]]]:
    unique = deduplicate(records)
    groups = joint_components(unique)
    if len(groups) < 3:
        raise DataError("Fewer than three independent employer/template components; a joint holdout is impossible")
    groups.sort(key=lambda group: min(row["id"] for row in group))
    random.Random(seed).shuffle(groups)
    # Use groups, not labels, to select partitions. No seed search for good metrics.
    validation_count = max(1, len(groups) // 5)
    test_count = max(1, len(groups) // 5)
    partitions = {
        "test": groups[:test_count],
        "validation": groups[test_count:test_count + validation_count],
        "train": groups[test_count + validation_count:],
    }
    return {name: [row for group in chunks for row in group] for name, chunks in partitions.items()}


def assert_disjoint(splits: dict[str, list[dict[str, Any]]]) -> None:
    for field in ("id", "dedup_key", "advertisement_sha256", "employer_group", "template_group"):
        seen: set[str] = set()
        for rows in splits.values():
            values = {row[field].strip().casefold() for row in rows}
            if seen & values:
                raise DataError(f"Holdout leakage across {field}")
            seen.update(values)


def load_experiment(dataset: Path, manifest: Path) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    """Revalidate frozen data/IDs instead of trusting a ready flag in a manifest."""
    rows = load_records(dataset)
    frozen = json.loads(manifest.read_text())
    if frozen.get("schema_version") != 1 or frozen.get("dataset_sha256") != digest_records(rows):
        raise DataError("Dataset differs from the frozen experiment manifest")
    if type(frozen.get("seed")) is not int:
        raise DataError("Frozen split seed is missing")
    splits = make_split(rows, frozen["seed"])
    assert_disjoint(splits)
    assert_sufficient(splits)
    if frozen.get("splits") != split_report(splits) or frozen.get("ready_for_experiment") is not True:
        raise DataError("Frozen partitions were changed or are not ready")
    return splits, frozen


def split_report(splits: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    return {
        name: {
            "count": len(rows), "class_counts": {str(key): value for key, value in Counter(target(row) for row in rows).items()},
            "employers": sorted({row["employer_group"] for row in rows}),
            "templates": sorted({row["template_group"] for row in rows}),
            "ids": [row["id"] for row in rows],
        }
        for name, rows in splits.items()
    }


def assert_sufficient(splits: dict[str, list[dict[str, Any]]]) -> None:
    # These are a modest demonstration gate, not a statistical power guarantee.
    for name, minimum in (("train", 80), ("validation", 20), ("test", 30)):
        rows = splits[name]
        counts = Counter(target(row) for row in rows)
        if len(rows) < minimum or min(counts.get(0, 0), counts.get(1, 0)) < 5:
            raise DataError(f"Insufficient {name}: need {minimum} rows and at least five per class")
        if len({row["employer_group"].casefold() for row in rows}) < 2:
            raise DataError(f"Insufficient {name}: need at least two employers")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
