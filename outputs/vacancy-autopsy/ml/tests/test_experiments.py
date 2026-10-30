"""Synthetic, in-memory logic tests. These never supply model benchmark evidence."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from baselines import Encoder, age_scores, logistic_scores
from data import (DataError, assert_disjoint, assert_sufficient, deduplicate, digest_records,
                  joint_components, load_experiment, load_records, make_split, sha256,
                  split_report, target, validate_record, write_json)
from extractor import assert_extraction_labels, messages, shifted_datum_values
from metrics import extraction_metrics, parse_prediction, priority_metrics


def fixture(index=0, employer=None, template=None):
    text = f"SYNTHETIC TEST ONLY. Example Employer {index}. Engineer; posting ID {index}."
    return {
        "id": f"fixture-{index}", "provenance": "synthetic_test",
        "employer_group": employer or f"employer-{index // 12}",
        "template_group": template or f"template-{index // 12}",
        "dedup_key": f"fixture-job-{index}",
        "advertisement_url": f"https://example.com/fictional-job/{index}",
        "advertisement_text": text, "advertisement_sha256": sha256(text),
        "advertisement_captured_at": "2026-10-27T08:00:00Z",
        "features_captured_at": "2026-10-27T08:01:00Z",
        "features": {"listing_age_days": float(index % 2 * 30), "repost_count": 0,
                     "employer_name_similarity": 0.8, "title_consistency": 0.9,
                     "ats_link_present": 1, "source_type": "job_board"},
        "verification": {"source_url": "https://boards-api.greenhouse.io/v1/boards/fictional/jobs",
                         "checked_at": "2026-10-27T08:02:00Z", "evidence_sha256": "a" * 64,
                         "complete": True, "identity_confirmed": True,
                         "outcome": "not_listed" if index % 2 else "verified_open",
                         "reviewed_by": "synthetic-test", "label_method": "independent_first_party_review"},
        "gold": {"employer": "Example Employer", "title": "Engineer", "job_id": str(index), "ats": "greenhouse"},
    }


class RecordTests(unittest.TestCase):
    def test_synthetic_cannot_enter_benchmark(self):
        with self.assertRaisesRegex(DataError, "real_public"):
            validate_record(fixture())
        self.assertEqual(validate_record(fixture(), allow_synthetic=True)["provenance"], "synthetic_test")

    def test_loader_rejects_synthetic_even_with_valid_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.jsonl"
            path.write_text(json.dumps(fixture()) + "\n")
            with self.assertRaisesRegex(DataError, "real_public"):
                load_records(path)

    def test_post_verification_features_rejected(self):
        row = fixture()
        row["features"]["official_job_found"] = 1
        with self.assertRaisesRegex(DataError, "no extra"):
            validate_record(row, allow_synthetic=True)

    def test_feature_time_must_precede_label(self):
        row = fixture()
        row["features_captured_at"] = row["verification"]["checked_at"]
        with self.assertRaisesRegex(DataError, "before"):
            validate_record(row, allow_synthetic=True)

    def test_stale_label_window_rejected(self):
        row = fixture()
        row["verification"]["checked_at"] = "2026-10-29T08:02:00Z"
        with self.assertRaisesRegex(DataError, "24-hour"):
            validate_record(row, allow_synthetic=True)

    def test_inconclusive_is_not_a_negative_label(self):
        row = fixture()
        row["verification"]["outcome"] = "inconclusive"
        with self.assertRaisesRegex(DataError, "excluded"):
            validate_record(row, allow_synthetic=True)

    def test_incomplete_feed_and_ambiguous_identity_rejected(self):
        for field in ("complete", "identity_confirmed"):
            row = fixture()
            row["verification"][field] = False
            with self.assertRaises(DataError):
                validate_record(row, allow_synthetic=True)

    def test_content_tampering_rejected(self):
        row = fixture()
        row["advertisement_text"] += "changed"
        with self.assertRaisesRegex(DataError, "hash mismatch"):
            validate_record(row, allow_synthetic=True)

    def test_third_party_label_source_rejected(self):
        row = fixture()
        row["verification"]["source_url"] = "https://example.com/jobs"
        with self.assertRaisesRegex(DataError, "first-party"):
            validate_record(row, allow_synthetic=True)

    def test_heuristic_label_rejected(self):
        row = fixture()
        row["verification"]["label_method"] = "age_heuristic"
        with self.assertRaisesRegex(DataError, "ground truth"):
            validate_record(row, allow_synthetic=True)

    def test_numeric_poisoning_rejected(self):
        for value in (float("nan"), float("inf"), -1, True, 1e308):
            row = fixture()
            row["features"]["listing_age_days"] = value
            with self.assertRaises(DataError):
                validate_record(row, allow_synthetic=True)


class SplitTests(unittest.TestCase):
    def test_repeated_job_and_identical_content_deduplicate(self):
        original = fixture(0)
        same_job = fixture(1)
        same_job["dedup_key"] = original["dedup_key"]
        same_content = fixture(2)
        same_content["advertisement_sha256"] = original["advertisement_sha256"]
        self.assertEqual([row["id"] for row in deduplicate([same_content, same_job, original])], [original["id"]])

    def test_employer_template_connections_are_transitive(self):
        rows = [fixture(0, "a", "x"), fixture(1, "a", "y"), fixture(2, "b", "y"), fixture(3, "c", "z")]
        self.assertEqual(sorted(map(len, joint_components(rows))), [1, 3])

    def test_holdout_is_disjoint_and_reproducible(self):
        rows = [fixture(i) for i in range(180)]
        splits = make_split(rows)
        assert_disjoint(splits)
        assert_sufficient(splits)
        self.assertEqual(split_report(splits), split_report(make_split(list(reversed(rows)))))

    def test_shared_template_can_block_honest_holdout(self):
        with self.assertRaisesRegex(DataError, "holdout is impossible"):
            make_split([fixture(i, f"employer-{i}", "same-template") for i in range(20)])

    def test_explicit_cross_split_leak_rejected(self):
        with self.assertRaisesRegex(DataError, "Holdout leakage"):
            assert_disjoint({"train": [fixture(0)], "test": [fixture(1)]})

    def test_insufficient_class_counts_block(self):
        splits = make_split([fixture(i) for i in range(180)])
        for row in splits["test"]:
            row["verification"]["outcome"] = "verified_open"
        with self.assertRaisesRegex(DataError, "five per class"):
            assert_sufficient(splits)

    def test_frozen_manifest_roundtrip_and_tamper_guard(self):
        rows = [fixture(i) for i in range(180)]
        splits = make_split(rows)
        frozen = {"schema_version": 1, "dataset_sha256": digest_records(rows), "seed": 17,
                  "splits": split_report(splits), "ready_for_experiment": True}
        # The loader is mocked only for testing manifest serialization. Synthetic
        # fixtures remain refused by the real benchmark loader above.
        with tempfile.TemporaryDirectory() as directory, patch("data.load_records", return_value=rows):
            manifest = Path(directory) / "manifest.json"
            write_json(manifest, frozen)
            actual, _ = load_experiment(Path("not-read-by-mock"), manifest)
            self.assertEqual(split_report(actual), frozen["splits"])
            frozen["splits"]["test"]["ids"].append("tampered")
            write_json(manifest, frozen)
            with self.assertRaisesRegex(DataError, "partitions were changed"):
                load_experiment(Path("not-read-by-mock"), manifest)


class MetricTests(unittest.TestCase):
    def test_average_precision_correct_for_ties(self):
        result = priority_metrics([1, 0, 1, 0], [0.9, 0.9, 0.1, 0.1], ["b", "a", "c", "d"], 1)
        self.assertEqual(result["average_precision"], 0.5)
        self.assertEqual(result["selected_ids"], ["a"])
        self.assertEqual(result["false_positives_at_budget"], 1)
        self.assertEqual(result["recall_at_budget"], 0)

    def test_perfect_priority_and_budget_metrics(self):
        result = priority_metrics([0, 1, 1, 0], [0.1, 0.9, 0.8, 0.2], ["a", "b", "c", "d"], 2)
        self.assertEqual(result["average_precision"], 1)
        self.assertEqual(result["recall_at_budget"], 1)
        self.assertEqual(result["false_positives_at_budget"], 0)

    def test_one_class_and_nonfinite_scores_refused(self):
        for labels, scores in (([1, 1], [0.1, 0.2]), ([0, 1], [float("nan"), 0.2])):
            with self.assertRaises(ValueError):
                priority_metrics(labels, scores, ["a", "b"], 1)

    def test_id_case_preserved_and_employer_normalized(self):
        gold = {"employer": "Example  Inc", "title": "Engineer", "job_id": "AbC", "ats": "lever"}
        prediction = {**gold, "employer": "EXAMPLE INC", "job_id": "abc"}
        result = extraction_metrics([gold], [json.dumps(prediction)])
        self.assertEqual(result["job_id_exact_accuracy"], 0)
        self.assertEqual(result["employer_normalized_accuracy"], 1)
        self.assertEqual(result["field_micro_f1"], 0.75)

    def test_invalid_json_is_counted_as_failure(self):
        gold = fixture()["gold"]
        result = extraction_metrics([gold], ['```json\n{}\n```'])
        self.assertEqual(result["invalid_json_count"], 1)
        self.assertEqual(result["field_micro_f1"], 0)
        self.assertIsNone(parse_prediction({}))

    def test_missing_ids_have_separate_denominator(self):
        gold = {**fixture()["gold"], "job_id": None}
        result = extraction_metrics([gold], [json.dumps(gold)])
        self.assertEqual(result["job_id_exact_accuracy"], 1)
        self.assertEqual(result["job_id_present_count"], 0)
        self.assertIsNone(result["job_id_present_exact_accuracy"])


class BaselineAndPromptTests(unittest.TestCase):
    def test_invisible_job_ids_are_not_oracle_extraction_labels(self):
        splits = make_split([fixture(i) for i in range(180)])
        splits["train"][0]["gold"]["job_id"] = "ID-ONLY-IN-OFFICIAL-RESPONSE"
        with self.assertRaisesRegex(DataError, "oracle label"):
            assert_extraction_labels(splits)

    def test_extraction_needs_visible_ids_in_holdouts(self):
        splits = make_split([fixture(i) for i in range(180)])
        for row in splits["test"]:
            row["gold"]["job_id"] = None
        with self.assertRaisesRegex(DataError, "Insufficient test extraction"):
            assert_extraction_labels(splits)

    def test_preprocessing_fits_only_train(self):
        train = [fixture(0), fixture(1)]
        encoder = Encoder(train)
        old_centers = deepcopy(encoder.centers)
        test = fixture(2)
        test["features"]["listing_age_days"] = 1000
        encoder.transform([test])
        self.assertEqual(encoder.centers, old_centers)

    def test_fixed_logistic_baseline_learns_separable_fixture(self):
        train = [fixture(i) for i in range(20)]
        scores = logistic_scores(train, [fixture(30), fixture(31)])
        self.assertLess(scores[0], 0.5)
        self.assertGreater(scores[1], 0.5)

    def test_missing_age_uses_train_median(self):
        row = fixture(2)
        row["features"]["listing_age_days"] = None
        self.assertEqual(age_scores([fixture(0), fixture(1), fixture(3)], [row]), [30])

    def test_loss_mask_trains_only_completion_with_shift(self):
        values = shifted_datum_values([10, 11, 12], [20, 21])
        self.assertEqual(values, {"input_tokens": [10, 11, 12, 20], "target_tokens": [11, 12, 20, 21], "weights": [0, 0, 1, 1]})

    def test_extractor_never_receives_gold_or_verification(self):
        row = fixture()
        row["gold"]["job_id"] = "HIDDEN-GOLD"
        row["verification"]["reviewed_by"] = "HIDDEN-REVIEWER"
        payload = json.dumps(messages(row))
        self.assertNotIn("HIDDEN-GOLD", payload)
        self.assertNotIn("HIDDEN-REVIEWER", payload)
        self.assertIn("untrusted", payload)

    def test_tinker_run_without_flags_refuses_before_import_or_network(self):
        runner = Path(__file__).resolve().parents[1] / "tinker_runner.py"
        result = subprocess.run([sys.executable, str(runner), "train", "missing.jsonl", "missing.json", "--output", "unused.json"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--allow-provider-run", result.stderr)

    def test_tabpfn_run_without_flags_refuses_before_import_or_network(self):
        runner = Path(__file__).resolve().parents[1] / "priority.py"
        result = subprocess.run([sys.executable, str(runner), "missing.jsonl", "missing.json", "--output", "unused.json", "--with-tabpfn"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--allow-provider-run", result.stderr)


if __name__ == "__main__":
    unittest.main()
