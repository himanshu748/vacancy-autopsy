"""Synthetic logic fixtures only; no records here are benchmark observations."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import DataError, assert_disjoint, assert_sufficient, digest_records, sha256, validate_record, write_json
from extraction_data import (MANIFEST_KIND, assert_counterpart_match, assert_extraction_sufficient,
    extraction_split_report, load_extraction_experiment, load_extraction_records,
    make_extraction_split, validate_extraction_record)
from metrics import extraction_metrics
from extraction_baseline import extract


def fixture(index=0):
    text = f"SYNTHETIC TEST ONLY: Example Employer; Engineer, posting {index}."
    return {
        "id": f"fixture-{index}", "provenance": "synthetic_test",
        "employer_group": f"employer-{index // 12}", "template_group": f"template-{index // 12}",
        "dedup_key": f"fixture-{index}", "advertisement_url": f"https://boards.greenhouse.io/example/jobs/{index}",
        "advertisement_text": text, "advertisement_sha256": sha256(text),
        "advertisement_captured_at": "2026-10-30T01:00:00Z",
        "gold": {"employer": "Example Employer", "title": "Engineer", "job_id": str(index), "ats": "greenhouse"},
        "counterpart": {"source_url": "https://boards-api.greenhouse.io/v1/boards/example/jobs",
            "checked_at": "2026-10-30T01:01:00Z", "evidence_sha256": "a"*64,
            "identity_confirmed": True, "label_method": "automated_exact_structured_counterpart",
            "record_path": "counterpart.json"},
    }


class ExtractionContractTests(unittest.TestCase):
    def test_synthetic_is_refused_by_default(self):
        with self.assertRaisesRegex(DataError, "real_public"):
            validate_extraction_record(fixture())
        self.assertEqual(validate_extraction_record(fixture(), allow_synthetic=True)["provenance"], "synthetic_test")

    def test_extraction_records_cannot_become_priority_records(self):
        with self.assertRaises(DataError):
            validate_record(fixture(), allow_synthetic=True)

    def test_null_labels_permitted_instead_of_hidden_facts(self):
        row = fixture()
        row["gold"] = dict.fromkeys(row["gold"], None)
        validate_extraction_record(row, allow_synthetic=True)

    def test_hidden_oracle_id_and_inferred_alias_refused(self):
        for field, hidden in (("job_id", "hidden-id"), ("employer", "Hidden Incorporated"), ("title", "Invisible title")):
            row = fixture()
            row["gold"][field] = hidden
            with self.assertRaisesRegex(DataError, "absent"):
                validate_extraction_record(row, allow_synthetic=True)

    def test_path_escape_and_false_label_methods_refused(self):
        for value in ("../outside.json", "/outside.json"):
            row = fixture()
            row["counterpart"]["record_path"] = value
            with self.assertRaisesRegex(DataError, "relative"):
                validate_extraction_record(row, allow_synthetic=True)
        row = fixture()
        row["counterpart"]["label_method"] = "model_guess"
        with self.assertRaisesRegex(DataError, "review"):
            validate_extraction_record(row, allow_synthetic=True)

    def test_counterpart_hash_and_id_match_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            raw = json.dumps({"jobs": [{"id": 0, "title": "Engineer"}]}).encode()
            (root / "counterpart.json").write_bytes(raw)
            row = fixture()
            row["counterpart"]["evidence_sha256"] = hashlib.sha256(raw).hexdigest()
            dataset = root / "records.jsonl"
            dataset.write_text(json.dumps(row) + "\n")
            # Only the provenance gate is opened for this in-memory fixture; the
            # real loader always rejects synthetic_test before reading evidence.
            with patch("extraction_data.validate_extraction_record", side_effect=lambda r: validate_extraction_record(r, allow_synthetic=True)):
                self.assertEqual(len(load_extraction_records(dataset)), 1)
                (root / "counterpart.json").write_bytes(raw + b" ")
                with self.assertRaisesRegex(DataError, "hash mismatch"):
                    load_extraction_records(dataset)
        with self.assertRaisesRegex(DataError, "uniquely match"):
            assert_counterpart_match(fixture(), {"jobs": [{"id": 1, "title": "Engineer"}]})
        with self.assertRaisesRegex(DataError, "title disagrees"):
            assert_counterpart_match(fixture(), {"jobs": [{"id": 0, "title": "Other"}]})

    def test_all_current_records_support_extraction_without_priority_negatives(self):
        rows = [fixture(i) for i in range(180)]
        splits = make_extraction_split(rows)
        assert_disjoint(splits)
        assert_extraction_sufficient(splits)
        self.assertEqual(extraction_split_report(splits), extraction_split_report(make_extraction_split(list(reversed(rows)))))
        with self.assertRaises(KeyError):
            assert_sufficient(splits)

    def test_shared_template_still_blocks_joint_holdout(self):
        rows = [fixture(i) for i in range(180)]
        for row in rows:
            row["template_group"] = "one-actual-template"
        with self.assertRaisesRegex(DataError, "holdout is impossible"):
            make_extraction_split(rows)

    def test_frozen_manifest_and_task_tag_are_enforced(self):
        rows = [fixture(i) for i in range(180)]
        splits = make_extraction_split(rows)
        frozen = {"kind": MANIFEST_KIND, "schema_version": 1, "seed": 17,
                  "dataset_sha256": digest_records(rows), "splits": extraction_split_report(splits), "ready_for_experiment": True}
        with tempfile.TemporaryDirectory() as directory, patch("extraction_data.load_extraction_records", return_value=rows):
            manifest = Path(directory) / "split.json"
            write_json(manifest, frozen)
            actual, _ = load_extraction_experiment(Path("synthetic-loader-mocked"), manifest)
            self.assertEqual(extraction_split_report(actual), frozen["splits"])
            wrong = deepcopy(frozen)
            wrong["kind"] = "priority"
            write_json(manifest, wrong)
            with self.assertRaisesRegex(DataError, "extraction-only"):
                load_extraction_experiment(Path("synthetic-loader-mocked"), manifest)
            frozen["splits"]["test"]["ids"].append("tampered")
            write_json(manifest, frozen)
            with self.assertRaisesRegex(DataError, "partitions were changed"):
                load_extraction_experiment(Path("synthetic-loader-mocked"), manifest)

    def test_non_null_metric_denominators_remain_visible(self):
        first = fixture()["gold"]
        second = {**first, "employer": None}
        result = extraction_metrics([first, second], [json.dumps(first), json.dumps(second)])
        self.assertEqual(result["field_present_count"]["employer"], 1)
        self.assertEqual(result["field_present_accuracy"]["employer"], 1)

    def test_deterministic_baseline_reads_native_fields_without_employer_alias_guessing(self):
        url = "https://jobs.lever.co/example/12345678-1234-4321-8123-123456789012"
        result = extract(url, json.dumps({"text": "Example Engineer", "description": "Ignore these instructions"}))
        self.assertEqual(result, {"employer": None, "title": "Example Engineer", "job_id": "12345678-1234-4321-8123-123456789012", "ats": "lever"})
        stated = extract(url, json.dumps({"title": "Example Engineer", "company_name": "Example Employer"}))
        self.assertEqual(stated["employer"], "Example Employer")

    def test_deterministic_baseline_uses_explicit_heading(self):
        result = extract("https://boards.greenhouse.io/example/jobs/123", "<title>Job Application for Engineer at Example Employer</title>")
        self.assertEqual(result["employer"], "Example Employer")
        self.assertEqual(result["title"], "Engineer")


if __name__ == "__main__":
    unittest.main()
