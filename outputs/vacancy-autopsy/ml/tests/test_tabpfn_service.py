import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from baselines import Encoder
from data import NUMERIC_FEATURES, SOURCE_TYPES
from tabpfn_service import RankingError, encode, load_context, rank, validate_request


def features(age=None):
    return {"listing_age_days": age, "repost_count": None, "employer_name_similarity": None,
            "title_consistency": None, "ats_link_present": None, "source_type": "job_board"}


def rows():
    return [{"id": "a", "features": features(2)}, {"id": "b", "features": features(30)}]


def context():
    return {"model_state_sha256": "a" * 64, "model_version": "v3.5", "training_dataset_sha256": "b" * 64,
            "encoder": {"centers": dict.fromkeys(NUMERIC_FEATURES, 0.0), "scales": dict.fromkeys(NUMERIC_FEATURES, 1.0)}}


class FakeProvider:
    def __init__(self):
        self.submissions = 0
        self.resumptions = 0
        self.fail_wait = False
        self.fail_submit = False
        self.scores = [0.5, 0.5]

    def quote(self, matrix):
        return {"quotedTokens": 10000}

    def submit(self, matrix, path):
        self.submissions += 1
        if self.fail_submit:
            raise TimeoutError()
        path.write_text(json.dumps({"fixture": "accepted request"}))
        return None

    def resume(self, path):
        self.resumptions += 1
        return None

    def wait(self, model):
        if self.fail_wait:
            raise TimeoutError()
        return self.scores


class ShortlistRequestTests(unittest.TestCase):
    def test_unknown_ats_presence_remains_missing_and_encoder_matches_frozen_protocol(self):
        requested = validate_request({"rows": rows()})
        self.assertIsNone(requested[0]["features"]["ats_link_present"])
        fitted = Encoder(requested)
        actual = encode(requested, {"encoder": {"centers": fitted.centers, "scales": fitted.scales}})
        self.assertEqual(actual, [row[1:] for row in fitted.transform(requested)])
        self.assertEqual(len(actual[0]), 13)

    def test_post_verification_fields_and_invalid_numeric_values_are_rejected(self):
        for mutation in [lambda x: x[0]["features"].update({"verdict": "not_listed"}),
                         lambda x: x[0]["features"].update({"listing_age_days": float("nan")}),
                         lambda x: x[0]["features"].update({"listing_age_days": -1}),
                         lambda x: x[0]["features"].update({"repost_count": 1.5}),
                         lambda x: x[0]["features"].update({"ats_link_present": 0.5}),
                         lambda x: x[0]["features"].update({"employer_name_similarity": 1.1}),
                         lambda x: x[0]["features"].update({"source_type": "verification"})]:
            requested = rows(); mutation(requested)
            with self.subTest(requested=requested), self.assertRaises(RankingError):
                validate_request({"rows": requested})

    def test_request_size_and_duplicate_identifiers_are_rejected(self):
        for value in [{"rows": rows(), "target": 1}, {"rows": rows()[:1]},
                      {"rows": [{"id": str(i), "features": features()} for i in range(21)]},
                      {"rows": [rows()[0], rows()[0]]}]:
            with self.assertRaises(RankingError): validate_request(value)

    def test_context_checks_model_identity_hash_and_local_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); state = root / "model.json"
            saved = {"task": "classification", "classes": [0, 1], "n_train_rows": 82, "fit_status": "completed",
                     "pending_prediction": None, "params": {"model_path": "v3.5_default", "n_estimators": 4, "random_state": 17}}
            state.write_text(json.dumps(saved)); item = context()
            item.update({"schema_version": 1, "project": "Vacancy Autopsy", "task": "relative_verification_priority",
                         "model_state_path": "model.json", "model_state_sha256": hashlib.sha256(state.read_bytes()).hexdigest(),
                         "numeric_features": list(NUMERIC_FEATURES), "source_types": list(SOURCE_TYPES),
                         "training_rows": 82, "n_estimators": 4, "seed": 17})
            path = root / "context.json"; path.write_text(json.dumps(item)); self.assertEqual(load_context(path)["training_rows"], 82)
            item["model_state_path"] = "../model.json"; path.write_text(json.dumps(item))
            with self.assertRaises(RankingError): load_context(path)
            item["model_state_path"] = "model.json"; item["model_version"] = "v2"; path.write_text(json.dumps(item))
            with self.assertRaises(RankingError): load_context(path)


class ShortlistRecoveryTests(unittest.TestCase):
    def test_accepted_submit_crash_resumes_and_normalizes_marker_before_result_cleanup_crash(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = FakeProvider(); path = Path(directory) / "context.json"
            active_path = path.parent / "runtime" / "active.json"
            submit = provider.submit
            def accepted_then_interrupted(matrix, pending_path):
                submit(matrix, pending_path)
                raise TimeoutError()
            with patch.object(provider, "submit", side_effect=accepted_then_interrupted):
                with self.assertRaises(TimeoutError):
                    rank(rows(), context(), path, lambda _: provider)
            active = json.loads(active_path.read_text())
            self.assertEqual(active["phase"], "submitting")
            self.assertTrue((active_path.parent / active["batch"] / "pending-model.json").exists())
            with patch.object(Path, "unlink", side_effect=OSError("crash after resumed result commit")):
                with self.assertRaisesRegex(OSError, "resumed result"):
                    rank(rows(), context(), path, lambda _: provider)
            self.assertEqual(json.loads(active_path.read_text()), {"batch": active["batch"], "phase": "pending"})
            self.assertEqual(provider.submissions, 1)
            self.assertEqual(provider.resumptions, 1)
            cached = rank(rows(), context(), path, lambda _: self.fail("Resumed result must not call provider again"))
            self.assertTrue(cached["operation"]["reused"])
            self.assertFalse(active_path.exists())
            self.assertEqual(provider.submissions, 1)
            self.assertEqual(provider.resumptions, 1)

    def test_cached_retry_recovers_crash_after_result_commit_and_unblocks_next_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = FakeProvider(); path = Path(directory) / "context.json"
            active_path = path.parent / "runtime" / "active.json"
            with patch.object(Path, "unlink", side_effect=OSError("crash before active cleanup")):
                with self.assertRaisesRegex(OSError, "active cleanup"):
                    rank(rows(), context(), path, lambda _: provider)
            self.assertTrue(active_path.exists())
            self.assertEqual(provider.submissions, 1)
            cached = rank(rows(), context(), path, lambda _: self.fail("Committed result must not call provider"))
            self.assertTrue(cached["operation"]["reused"])
            self.assertFalse(active_path.exists())
            self.assertEqual(provider.submissions, 1)
            changed = rows(); changed[0]["features"]["listing_age_days"] = 3
            rank(changed, context(), path, lambda _: provider)
            self.assertEqual(provider.submissions, 2)
            self.assertEqual(provider.resumptions, 0)
            self.assertFalse(active_path.exists())

    def test_cached_other_batch_preserves_pending_operation_and_does_not_unlock_new_work(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = FakeProvider(); path = Path(directory) / "context.json"
            rank(rows(), context(), path, lambda _: provider)
            changed = rows(); changed[0]["features"]["listing_age_days"] = 3
            provider.fail_wait = True
            with self.assertRaises(TimeoutError):
                rank(changed, context(), path, lambda _: provider)
            active_path = path.parent / "runtime" / "active.json"
            pending = active_path.read_bytes()
            cached = rank(rows(), context(), path, lambda _: self.fail("Cached result must not call provider"))
            self.assertTrue(cached["operation"]["reused"])
            self.assertEqual(active_path.read_bytes(), pending)
            another = rows(); another[0]["features"]["listing_age_days"] = 4
            with self.assertRaisesRegex(RankingError, "prior shortlist"):
                rank(another, context(), path, lambda _: self.fail("Pending other batch must block provider"))
            self.assertEqual(provider.submissions, 2)

    def test_cached_result_never_clears_unvalidated_active_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = FakeProvider(); path = Path(directory) / "context.json"
            rank(rows(), context(), path, lambda _: provider)
            runtime = path.parent / "runtime"
            digest = next(item.name for item in runtime.iterdir() if item.is_dir())
            active_path = runtime / "active.json"
            for marker in [{"batch": digest, "phase": "submitting"},
                           {"batch": digest, "phase": "pending", "unknown": True},
                           {"batch": digest}, [digest, "pending"]]:
                with self.subTest(marker=marker):
                    active_path.write_text(json.dumps(marker))
                    before = active_path.read_bytes()
                    cached = rank(rows(), context(), path, lambda _: self.fail("Cached result must not call provider"))
                    self.assertTrue(cached["operation"]["reused"])
                    self.assertEqual(active_path.read_bytes(), before)
            self.assertEqual(provider.submissions, 1)

    def test_pending_request_resumes_without_second_submission_and_ties_stay_tied(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = FakeProvider(); provider.fail_wait = True; path = Path(directory) / "context.json"
            with self.assertRaises(TimeoutError): rank(rows(), context(), path, lambda _: provider)
            self.assertEqual(provider.submissions, 1)
            provider.fail_wait = False
            result = rank(rows(), context(), path, lambda _: provider)
            self.assertEqual(provider.submissions, 1); self.assertEqual(provider.resumptions, 1)
            self.assertEqual([row["rank"] for row in result["ranked"]], [1, 1])
            repeated = rank(rows(), context(), path, lambda _: self.fail("Completed cache must not call a provider"))
            self.assertTrue(repeated["operation"]["reused"])

    def test_different_pending_batch_and_uncertain_submission_cannot_blindly_resubmit(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = FakeProvider(); provider.fail_submit = True; path = Path(directory) / "context.json"
            with self.assertRaises(TimeoutError): rank(rows(), context(), path, lambda _: provider)
            with self.assertRaisesRegex(RankingError, "provider-state review"):
                rank(rows(), context(), path, lambda _: self.fail("Uncertain request must not call provider"))
            changed = rows(); changed[0]["features"]["listing_age_days"] = 3
            with self.assertRaisesRegex(RankingError, "prior shortlist"):
                rank(changed, context(), path, lambda _: self.fail("Different pending request must not call provider"))
            self.assertEqual(provider.submissions, 1)

    def test_invalid_provider_scores_never_become_a_ranking(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = FakeProvider(); provider.scores = [float("nan"), 0.5]
            with self.assertRaisesRegex(RankingError, "invalid ranking"):
                rank(rows(), context(), Path(directory) / "context.json", lambda _: provider)


if __name__ == "__main__": unittest.main()
