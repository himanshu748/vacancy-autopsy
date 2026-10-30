"""Validate real records and freeze their joint holdout before any model run."""
import argparse
from pathlib import Path

from data import DataError, assert_disjoint, assert_sufficient, digest_records, load_records, make_split, split_report, write_json


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=17)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("Choose a new manifest path; frozen manifests are not overwritten")
    rows = load_records(args.dataset)
    splits = make_split(rows, args.seed)
    assert_disjoint(splits)
    report = {
        "schema_version": 1, "dataset_sha256": digest_records(rows), "seed": args.seed,
        "source_count": len(rows), "deduplicated_count": sum(map(len, splits.values())),
        "split_policy": "joint connected components of employer and template; no shared job/content",
        "splits": split_report(splits), "ready_for_experiment": False,
    }
    try:
        assert_sufficient(splits)
    except DataError as exc:
        report["blocked_reason"] = str(exc)
        write_json(args.output, report)
        raise SystemExit(str(exc)) from exc
    report["ready_for_experiment"] = True
    write_json(args.output, report)
    print(f"Prepared {report['deduplicated_count']} real records; no model was called.")


if __name__ == "__main__":
    main()
