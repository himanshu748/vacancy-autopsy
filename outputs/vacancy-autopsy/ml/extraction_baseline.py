"""Fixed zero-model extraction baseline using only stated input fields.

No employer-specific dictionary, gold field, template group or counterpart is
consulted. An ATS board slug is not silently promoted to an employer legal name.
This extracts candidate facts only, never a verification verdict.
"""
from __future__ import annotations

import argparse
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from data import DataError, write_json
from extraction_data import load_extraction_experiment
from metrics import extraction_metrics


class Headings(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.active = None
        self.values = {"title": [], "h1": []}
    def handle_starttag(self, tag, attrs):
        if tag in self.values:
            self.active = tag
    def handle_endtag(self, tag):
        if tag == self.active:
            self.active = None
    def handle_data(self, data):
        if self.active:
            self.values[self.active].append(data)


def _identity(url: str):
    parsed = urlsplit(url)
    parts = parsed.path.strip("/").split("/")
    if parsed.hostname in {"boards.greenhouse.io", "job-boards.greenhouse.io"} and len(parts) == 3 and parts[1] == "jobs" and parts[2].isdigit():
        return "greenhouse", parts[2]
    if parsed.hostname in {"jobs.lever.co", "jobs.eu.lever.co", "jobs.ashbyhq.com"} and len(parts) >= 2 and re.fullmatch(r"[0-9a-fA-F-]{36}", parts[1]):
        return ("ashby" if parsed.hostname == "jobs.ashbyhq.com" else "lever"), parts[1]
    return None, None


def extract(url: str, text: str) -> dict[str, str | None]:
    ats, job_id = _identity(url)
    result = {"employer": None, "title": None, "job_id": job_id, "ats": ats}
    try:
        value = json.loads(text)
    except (ValueError, TypeError):
        value = None
    if isinstance(value, dict):
        for field in ("title", "text"):
            if isinstance(value.get(field), str) and value[field].strip():
                result["title"] = value[field].strip()
                break
        for field in ("company_name", "companyName", "employer"):
            if isinstance(value.get(field), str) and value[field].strip():
                result["employer"] = value[field].strip()
                break
        if isinstance(value.get("company"), dict) and isinstance(value["company"].get("name"), str):
            result["employer"] = value["company"]["name"].strip() or None
        for field in ("hostedUrl", "jobUrl", "absolute_url"):
            if isinstance(value.get(field), str):
                candidate = _identity(value[field])
                if candidate[0] is not None and (result["ats"] is None or candidate == (result["ats"], result["job_id"])):
                    result["ats"], result["job_id"] = candidate
                    break
        return result
    headings = Headings()
    headings.feed(text)
    title = " ".join(headings.values["title"]).strip()
    # Common explicit page-title wording; this does not infer aliases from URL
    # slugs or learn per-employer rules from the held-out labels.
    candidate_lines = [title] + text.splitlines()[:12]
    for line in candidate_lines:
        match = re.fullmatch(r"\s*Job Application for (.+?) at (.+?)\s*", html.unescape(line))
        if match:
            result["title"], result["employer"] = match.group(1).strip(), match.group(2).strip()
            break
    if result["title"] is None and headings.values["h1"]:
        result["title"] = " ".join(headings.values["h1"]).strip()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--partition", choices=("validation", "test"), default="validation")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("Choose a new output path; baseline artifacts are retained")
    splits, frozen = load_extraction_experiment(args.dataset, args.manifest)
    rows = splits[args.partition]
    predictions = [{"id": row["id"], "raw": json.dumps(extract(row["advertisement_url"], row["advertisement_text"]))} for row in rows]
    write_json(args.output, {"kind": "deterministic_extraction_baseline", "provider_called": False,
        "partition": args.partition, "dataset_sha256": frozen["dataset_sha256"],
        "rule_version": "native-fields-and-explicit-headings-v1", "predictions": predictions,
        "metrics": extraction_metrics([row["gold"] for row in rows], [row["raw"] for row in predictions]),
        "limitations": ["Publisher-native JSON fields may make this task largely deterministic.",
                        "This does not validate third-party ad discovery, job status, or employer intent."]})
    print(f"Wrote deterministic baseline to {args.output}; no provider called.")


if __name__ == "__main__":
    try:
        main()
    except DataError as exc:
        raise SystemExit(str(exc)) from exc
