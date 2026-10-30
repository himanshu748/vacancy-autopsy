"""Freeze real extraction-only records without inventing priority negatives."""
import argparse
from pathlib import Path

from data import DataError, assert_disjoint, digest_records, write_json
from extraction_data import (MANIFEST_KIND, assert_extraction_sufficient,
                             extraction_split_report, load_extraction_records,
                             make_extraction_split)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=17)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("Choose a new extraction manifest path; frozen manifests are not overwritten")
    rows = load_extraction_records(args.dataset)
    splits = make_extraction_split(rows, args.seed)
    assert_disjoint(splits)
    report = {"kind": MANIFEST_KIND, "schema_version": 1, "dataset_sha256": digest_records(rows),
              "seed": args.seed, "source_count": len(rows), "deduplicated_count": sum(map(len, splits.values())),
              "split_policy": "joint connected components of employer and real template; no shared job/content",
              "splits": extraction_split_report(splits), "ready_for_experiment": False,
              "scope": "Extraction only. Does not establish current/stale classification or messy third-party generalization."}
    try:
        assert_extraction_sufficient(splits)
    except DataError as exc:
        report["blocked_reason"] = str(exc)
        write_json(args.output, report)
        raise SystemExit(str(exc)) from exc
    report["ready_for_experiment"] = True
    write_json(args.output, report)
    print(f"Prepared {report['deduplicated_count']} real extraction records; no provider was called.")


if __name__ == "__main__":
    try:
        main()
    except DataError as exc:
        raise SystemExit(str(exc)) from exc
