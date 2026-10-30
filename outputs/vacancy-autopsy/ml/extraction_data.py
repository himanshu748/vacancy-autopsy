"""Real extraction-only records and frozen, jointly grouped holdouts.

This contract deliberately has no stale/open target or priority features. It may
contain current postings only. It cannot be consumed as a TabPFN benchmark.
Source hashes make captured evidence inspectable; they cannot prove a labeler's
statement is truthful or that a public employer board belongs to a legal entity.
"""
from __future__ import annotations

import hashlib
import html
import json
from pathlib import Path
import random
import re
from typing import Any
from urllib.parse import unquote, urlsplit

from data import (DataError, GOLD_FIELDS, assert_disjoint, digest_records, exact_keys,
                  joint_components, public_url, sha256, timestamp)
from extractor import assert_extraction_labels
from metrics import normalize_name

FIELDS = {
    "id", "provenance", "employer_group", "template_group", "dedup_key",
    "advertisement_url", "advertisement_text", "advertisement_sha256",
    "advertisement_captured_at", "gold", "counterpart",
}
COUNTERPART_FIELDS = {
    "source_url", "checked_at", "evidence_sha256", "identity_confirmed",
    "label_method", "record_path",
}
ATS_HOSTS = {
    "boards-api.greenhouse.io", "boards-api.eu.greenhouse.io", "api.lever.co",
    "api.eu.lever.co", "api.ashbyhq.com",
}
MANIFEST_KIND = "vacancy_autopsy_extraction_split"


def validate_extraction_record(row: dict[str, Any], *, allow_synthetic: bool = False) -> dict[str, Any]:
    exact_keys(row, FIELDS, "extraction record")
    if row["provenance"] != "real_public" and not (allow_synthetic and row["provenance"] == "synthetic_test"):
        raise DataError("Only real_public extraction records may enter a benchmark")
    for field in ("id", "employer_group", "template_group", "dedup_key"):
        if not isinstance(row[field], str) or not row[field].strip() or len(row[field]) > 256:
            raise DataError(f"Invalid extraction {field}")
    text = row["advertisement_text"]
    if not isinstance(text, str) or not 1 <= len(text) <= 32000:
        raise DataError("Advertisement text must contain 1–32,000 characters")
    if sha256(text) != row["advertisement_sha256"]:
        raise DataError("Advertisement content hash mismatch")
    public_url(row["advertisement_url"])
    captured = timestamp(row["advertisement_captured_at"])
    counterpart = row["counterpart"]
    exact_keys(counterpart, COUNTERPART_FIELDS, "structured counterpart")
    checked = timestamp(counterpart["checked_at"])
    if not captured <= checked or (checked - captured).total_seconds() > 86400:
        raise DataError("Counterpart must be checked after capture within 24 hours")
    public_url(counterpart["source_url"])
    if urlsplit(counterpart["source_url"]).hostname not in ATS_HOSTS:
        raise DataError("Structured counterpart must reference a supported first-party ATS API")
    if counterpart["identity_confirmed"] is not True:
        raise DataError("Ambiguous counterpart identity cannot supply extraction labels")
    if counterpart["label_method"] not in {"automated_exact_structured_counterpart", "independent_first_party_review"}:
        raise DataError("Extraction labels require declared first-party counterpart review")
    digest = counterpart["evidence_sha256"]
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise DataError("Counterpart requires a SHA-256 evidence reference")
    path = counterpart["record_path"]
    if not isinstance(path, str) or not path or len(path) > 1024 or Path(path).is_absolute() or ".." in Path(path).parts:
        raise DataError("Counterpart record_path must remain relative to the dataset directory")
    gold = row["gold"]
    exact_keys(gold, set(GOLD_FIELDS), "gold")
    for field, value in gold.items():
        if value is not None and (not isinstance(value, str) or not value.strip() or len(value) > 500):
            raise DataError(f"Invalid extraction label: {field}")
    if gold["ats"] not in {"greenhouse", "lever", "ashby", None}:
        raise DataError("Invalid gold ATS")
    # Visible here means present in the exact model input, including native JSON
    # or HTML, not necessarily a browser-rendered text node. No hidden job-ID
    # labels may be supplied from the separate structured counterpart.
    input_text = html.unescape(unquote(row["advertisement_url"]) + " " + text)
    if gold["job_id"] is not None and gold["job_id"] not in row["advertisement_url"] + " " + text:
        raise DataError("Gold job ID is absent from extractor inputs; use null rather than an oracle label")
    normalized_input = normalize_name(re.sub(r"<[^>]*>", " ", input_text))
    for field in ("employer", "title"):
        if gold[field] is not None and normalize_name(gold[field]) not in normalized_input:
            raise DataError(f"Gold {field} is absent from extractor inputs; use null rather than an inferred alias")
    return row


def load_extraction_records(path: Path) -> list[dict[str, Any]]:
    if path.stat().st_size > 32_000_000:
        raise DataError("Dataset exceeds the 32 MB experiment limit")
    root = path.parent.resolve()
    rows: list[dict[str, Any]] = []
    ids: set[str] = set()
    checked_sources: dict[tuple[Path, str], Any] = {}
    evidence_bytes = 0
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = validate_extraction_record(json.loads(line))
            if row["id"] in ids:
                raise DataError("Duplicate extraction record ID")
            evidence = (root / row["counterpart"]["record_path"]).resolve()
            if not evidence.is_relative_to(root) or not evidence.is_file():
                raise DataError("Referenced counterpart evidence is missing or outside the dataset directory")
            expected = row["counterpart"]["evidence_sha256"]
            key = evidence, expected
            if key not in checked_sources:
                if evidence.stat().st_size > 32_000_000:
                    raise DataError("Counterpart evidence exceeds 32 MB")
                raw = evidence.read_bytes()
                evidence_bytes += len(raw)
                if evidence_bytes > 64_000_000:
                    raise DataError("Referenced counterpart evidence exceeds the aggregate 64 MB budget")
                if hashlib.sha256(raw).hexdigest() != expected:
                    raise DataError("Counterpart evidence hash mismatch")
                payload = json.loads(raw.decode("utf-8"))
                if not isinstance(payload, (dict, list)):
                    raise DataError("Counterpart must contain a captured structured API object or array")
                checked_sources[key] = payload
            assert_counterpart_match(row, checked_sources[key])
            ids.add(row["id"])
            rows.append(row)
        except (ValueError, TypeError, OSError) as exc:
            raise DataError(f"Row {number}: {exc}") from exc
    if not rows:
        raise DataError("No real extraction records; benchmark is blocked")
    return rows


def assert_counterpart_match(row: dict[str, Any], payload: Any) -> None:
    """Check labeled IDs/titles against the retained source's native records."""
    source = urlsplit(row["counterpart"]["source_url"])
    if isinstance(payload, dict) and isinstance(payload.get("jobs"), list):
        jobs = payload["jobs"]
    elif isinstance(payload, list):
        jobs = payload
    elif isinstance(payload, dict) and ("id" in payload or "jobUrl" in payload):
        jobs = [payload]
    else:
        raise DataError("Counterpart is not a recognized public ATS record collection")
    # A null ID is permitted when the ad does not expose it. Such rows retain
    # provenance for audit but cannot have their source linkage proved by ID.
    job_id = row["gold"]["job_id"]
    if job_id is None:
        return
    matched = []
    for item in jobs:
        if not isinstance(item, dict):
            raise DataError("Counterpart contains a malformed posting record")
        if source.hostname == "api.ashbyhq.com":
            url = item.get("jobUrl")
            parts = urlsplit(url).path.strip("/").split("/") if isinstance(url, str) else []
            identity = parts[1] if len(parts) >= 2 else item.get("id")
        else:
            identity = str(item.get("id", ""))
        if identity == job_id:
            matched.append(item)
    if len(matched) != 1:
        raise DataError("Gold job ID does not uniquely match the retained structured counterpart")
    title = row["gold"]["title"]
    if title is not None and normalize_name(matched[0].get("title", matched[0].get("text"))) != normalize_name(title):
        raise DataError("Gold title disagrees with the retained structured counterpart")


def make_extraction_split(rows: list[dict[str, Any]], seed: int = 17) -> dict[str, list[dict[str, Any]]]:
    seen_jobs: set[str] = set()
    seen_content: set[str] = set()
    unique = []
    for row in sorted(rows, key=lambda row: (timestamp(row["advertisement_captured_at"]), row["id"])):
        if row["dedup_key"] not in seen_jobs and row["advertisement_sha256"] not in seen_content:
            unique.append(row)
        seen_jobs.add(row["dedup_key"])
        seen_content.add(row["advertisement_sha256"])
    groups = joint_components(unique)
    if len(groups) < 3:
        raise DataError("Fewer than three independent employer/template components; a joint extraction holdout is impossible")
    groups.sort(key=lambda group: min(row["id"] for row in group))
    random.Random(seed).shuffle(groups)
    validation_count = max(1, len(groups) // 5)
    test_count = max(1, len(groups) // 5)
    parts = {"test": groups[:test_count], "validation": groups[test_count:test_count + validation_count],
             "train": groups[test_count + validation_count:]}
    return {name: [row for group in chunks for row in group] for name, chunks in parts.items()}


def assert_extraction_sufficient(splits: dict[str, list[dict[str, Any]]]) -> None:
    for name, minimum in (("train", 80), ("validation", 20), ("test", 30)):
        rows = splits[name]
        if len(rows) < minimum:
            raise DataError(f"Insufficient extraction {name}: need {minimum} rows")
        if len({row["employer_group"].strip().casefold() for row in rows}) < 2:
            raise DataError(f"Insufficient extraction {name}: need at least two employers")
    assert_extraction_labels(splits)


def extraction_split_report(splits: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    return {name: {"count": len(rows), "employers": sorted({row["employer_group"] for row in rows}),
                   "templates": sorted({row["template_group"] for row in rows}),
                   "ids": [row["id"] for row in rows],
                   "non_null_labels": {field: sum(row["gold"][field] is not None for row in rows) for field in GOLD_FIELDS}}
            for name, rows in splits.items()}


def load_extraction_experiment(dataset: Path, manifest: Path) -> tuple[dict[str, list[dict[str, Any]]], dict[str, Any]]:
    rows = load_extraction_records(dataset)
    frozen = json.loads(manifest.read_text())
    if frozen.get("schema_version") != 1 or frozen.get("kind") != MANIFEST_KIND:
        raise DataError("An explicit extraction-only manifest is required")
    if frozen.get("dataset_sha256") != digest_records(rows) or type(frozen.get("seed")) is not int:
        raise DataError("Extraction dataset differs from its frozen manifest")
    splits = make_extraction_split(rows, frozen["seed"])
    assert_disjoint(splits)
    assert_extraction_sufficient(splits)
    if frozen.get("ready_for_experiment") is not True or frozen.get("splits") != extraction_split_report(splits):
        raise DataError("Frozen extraction partitions were changed or are not ready")
    return splits, frozen
