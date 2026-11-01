"""Synthetic startup regressions; no credentials or provider requests."""
import hashlib
import importlib.util
from contextlib import redirect_stderr
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("prepare_model_state", Path(__file__).with_name("prepare-model-state.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

from data import NUMERIC_FEATURES, SOURCE_TYPES, sha256
from extractor import SYSTEM_PROMPT


def fixture(secrets):
    training = {"kind": "tinker_training", "status": "completed", "prompt_sha256": sha256(SYSTEM_PROMPT),
                "base_model": "Qwen/Qwen3-8B", "project_id": "synthetic-project",
                "checkpoint": "tinker://synthetic/checkpoint", "max_context_tokens": 16384}
    state = {"task": "classification", "classes": [0, 1], "n_train_rows": 82,
             "fit_status": "completed", "pending_prediction": None,
             "params": {"model_path": "v3.5_default", "n_estimators": 4, "random_state": 17}}
    state_bytes = json.dumps(state).encode()
    context = {"schema_version": 1, "project": "Vacancy Autopsy", "task": "relative_verification_priority",
               "numeric_features": list(NUMERIC_FEATURES), "source_types": list(SOURCE_TYPES),
               "model_version": "v3.5", "n_estimators": 4, "seed": 17,
               "training_dataset_sha256": "a" * 64, "training_rows": 82,
               "encoder": {"centers": dict.fromkeys(NUMERIC_FEATURES, 0),
                           "scales": dict.fromkeys(NUMERIC_FEATURES, 1)},
               "model_state_path": "model.json", "model_state_sha256": hashlib.sha256(state_bytes).hexdigest()}
    (secrets / "tinker-training.json").write_text(json.dumps(training))
    (secrets / "priority-model-state.json").write_bytes(state_bytes)
    (secrets / "priority-context.json").write_text(json.dumps(context))
    return context


class ModelStartupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name) / "disk"
        self.secrets = Path(self.directory.name) / "secrets"
        self.root.mkdir(); self.secrets.mkdir()
        self.context = fixture(self.secrets)

    def prepare(self):
        with patch.object(Path, "is_mount", return_value=True), patch.dict(os.environ, {"TINKER_PROJECT_ID": "synthetic-project"}):
            module.prepare(self.root, self.secrets)

    def assert_code(self, code, operation=None):
        with self.assertRaises(module.StartupError) as raised:
            (operation or self.prepare)()
        self.assertEqual(raised.exception.code, code)

    def test_unmounted_filesystem_is_rejected_before_writing(self):
        with patch.object(Path, "is_mount", return_value=False):
            self.assert_code("MOUNT_REQUIRED", lambda: module.prepare(self.root, self.secrets))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_untraversable_mount_is_distinct_from_missing_mount(self):
        with patch.object(os, "access", return_value=False):
            self.assert_code("MOUNT_UNREADABLE")
        self.assertEqual(list(self.root.iterdir()), [])
        self.assert_code("MOUNT_REQUIRED", lambda: module.prepare(self.root / "missing", self.secrets))

    def test_restart_preserves_pending_operation_bytes_and_private_permissions(self):
        self.prepare()
        pending = self.root / "priority" / "runtime"
        pending.mkdir(); (pending / "active.json").write_text('{"synthetic":"accepted request"}')
        self.prepare()
        self.assertEqual((pending / "active.json").read_text(), '{"synthetic":"accepted request"}')
        self.assertEqual((self.root / "priority" / "model-context.json").stat().st_mode & 0o777, 0o600)

    def test_changed_model_is_blocked_without_overwriting_pending_context(self):
        self.prepare()
        original = (self.root / "priority" / "model-context.json").read_bytes()
        self.context["training_dataset_sha256"] = "b" * 64
        (self.secrets / "priority-context.json").write_text(json.dumps(self.context))
        self.assert_code("PERSISTED_CONTEXT_CHANGED")
        self.assertEqual((self.root / "priority" / "model-context.json").read_bytes(), original)

    def test_cross_project_checkpoint_and_traversal_are_rejected(self):
        with patch.object(Path, "is_mount", return_value=True), patch.dict(os.environ, {"TINKER_PROJECT_ID": "different-project"}):
            self.assert_code("TINKER_PROJECT_MISMATCH", lambda: module.prepare(self.root, self.secrets))
        self.context["model_state_path"] = "../outside.json"
        (self.secrets / "priority-context.json").write_text(json.dumps(self.context))
        self.assert_code("STATE_FILENAME_INVALID")
        self.assertFalse((self.root / "outside.json").exists())

    def test_tinker_missing_unreadable_and_invalid_metadata_are_distinct(self):
        path = self.secrets / "tinker-training.json"
        original = path.read_bytes()
        path.unlink()
        self.assert_code("TINKER_MISSING")
        path.write_bytes(original)
        with patch.object(module, "bounded", side_effect=PermissionError("/private/checkpoint")):
            self.assert_code("TINKER_UNREADABLE")
        path.write_text("not JSON: private checkpoint")
        self.assert_code("TINKER_INVALID_JSON")
        path.write_text('{}')
        self.assert_code("TINKER_INVALID")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_context_and_state_read_failures_identify_the_stage(self):
        for filename, code in (("priority-context.json", "CONTEXT_MISSING"),
                               ("priority-model-state.json", "STATE_MISSING")):
            with self.subTest(code=code):
                path = self.secrets / filename
                original = path.read_bytes()
                path.unlink()
                self.assert_code(code)
                path.write_bytes(original)

    def test_hash_mismatch_does_not_install_immutable_state(self):
        path = self.secrets / "priority-model-state.json"
        state = json.loads(path.read_bytes()); state["n_train_rows"] += 1
        path.write_text(json.dumps(state))
        self.assert_code("STATE_HASH_MISMATCH")
        self.assertEqual(list(self.root.iterdir()), [])

    def reviewed_state_with_final_lf(self):
        state = (self.secrets / "priority-model-state.json").read_bytes() + b'\n'
        self.context["model_state_sha256"] = hashlib.sha256(state).hexdigest()
        context = json.dumps(self.context).encode()
        (self.secrets / "priority-context.json").write_bytes(context)
        return state, context

    def test_missing_single_final_lf_is_reconstructed_only_by_exact_reviewed_hash(self):
        state, context = self.reviewed_state_with_final_lf()
        self.prepare()  # The textarea-transmitted secret is still missing its LF.
        self.assertEqual((self.root / "priority" / "model.json").read_bytes(), state)
        self.assertEqual((self.root / "priority" / "model-context.json").read_bytes(), context)
        self.assertEqual((self.secrets / "priority-model-state.json").read_bytes(), state[:-1])
        self.assertEqual(hashlib.sha256(state).hexdigest(), self.context["model_state_sha256"])

    def test_old_bootstrap_state_recovers_without_touching_accepted_or_uncertain_operations(self):
        state, context = self.reviewed_state_with_final_lf()
        priority = self.root / "priority"; priority.mkdir()
        (priority / "model.json").write_bytes(state[:-1])
        (priority / "model-context.json").write_bytes(context)
        runtime = priority / "runtime"; runtime.mkdir()
        (runtime / "active.json").write_bytes(b'{"phase":"submitting","accepted":"unknown"}')
        batch = runtime / "batch"; batch.mkdir()
        (batch / "pending-model.json").write_bytes(b'accepted provider request bytes')
        before = {str(path.relative_to(runtime)): path.read_bytes() for path in runtime.rglob('*') if path.is_file()}
        self.prepare()
        self.assertEqual((priority / "model.json").read_bytes(), state)
        self.assertEqual((priority / "model.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((priority / "model-context.json").read_bytes(), context)
        after = {str(path.relative_to(runtime)): path.read_bytes() for path in runtime.rglob('*') if path.is_file()}
        self.assertEqual(after, before)
        self.prepare()  # A normal subsequent restart remains idempotent.
        self.assertEqual((priority / "model.json").read_bytes(), state)

    def test_failed_atomic_restoration_leaves_original_state_and_runtime_intact(self):
        state, context = self.reviewed_state_with_final_lf()
        priority = self.root / "priority"; priority.mkdir()
        path = priority / "model.json"; path.write_bytes(state[:-1])
        (priority / "model-context.json").write_bytes(context)
        runtime = priority / "runtime"; runtime.mkdir()
        marker = runtime / "active.json"; marker.write_bytes(b'accepted operation')
        with patch.object(os, "replace", side_effect=OSError("private transport failure")):
            self.assert_code("PERSISTED_STATE_WRITE_FAILED")
        self.assertEqual(path.read_bytes(), state[:-1])
        self.assertEqual(marker.read_bytes(), b'accepted operation')
        self.assertEqual(list(priority.glob('.restore-*')), [])
        self.prepare()
        self.assertEqual(path.read_bytes(), state)

    def test_arbitrary_truncation_and_other_whitespace_do_not_pass_the_reviewed_hash(self):
        state, _ = self.reviewed_state_with_final_lf()
        path = self.secrets / "priority-model-state.json"
        cases = ((state[:-1] + b' ', "STATE_HASH_MISMATCH"),
                 (state[:-1] + b'\r', "STATE_HASH_MISMATCH"),
                 (state[:-1] + b'\t', "STATE_HASH_MISMATCH"),
                 (b' ' + state[:-1], "STATE_HASH_MISMATCH"),
                 (state + b'\n', "STATE_HASH_MISMATCH"),
                 (state.replace(b'82', b'83'), "STATE_HASH_MISMATCH"),
                 (state[:-2], "STATE_INVALID_JSON"))
        for content, code in cases:
            with self.subTest(content=content[-12:]):
                path.write_bytes(content)
                self.assert_code(code)
                self.assertEqual(list(self.root.iterdir()), [])
        # Appending a single LF cannot reconstruct a transport loss of two LFs.
        self.context["model_state_sha256"] = hashlib.sha256(state + b'\n').hexdigest()
        (self.secrets / "priority-context.json").write_text(json.dumps(self.context))
        path.write_bytes(state[:-1])
        self.assert_code("STATE_HASH_MISMATCH")

    def test_other_persisted_corruption_is_never_repaired(self):
        state, context = self.reviewed_state_with_final_lf()
        priority = self.root / "priority"; priority.mkdir()
        path = priority / "model.json"
        (priority / "model-context.json").write_bytes(context)
        runtime = priority / "runtime"; runtime.mkdir()
        marker = runtime / "active.json"; marker.write_bytes(b'uncertain accepted operation')
        for content in (state[:-1] + b' ', state[:-1] + b'\r', state[:-2], state.replace(b'82', b'83')):
            with self.subTest(content=content[-12:]):
                path.write_bytes(content)
                self.assert_code("PERSISTED_STATE_CHANGED")
                self.assertEqual(path.read_bytes(), content)
                self.assertEqual(marker.read_bytes(), b'uncertain accepted operation')

    def test_changed_frozen_context_prevents_even_missing_lf_state_restoration(self):
        state, context = self.reviewed_state_with_final_lf()
        priority = self.root / "priority"; priority.mkdir()
        path = priority / "model.json"; path.write_bytes(state[:-1])
        stored_context = priority / "model-context.json"
        stored_context.write_bytes(context + b' ')
        self.assert_code("PERSISTED_CONTEXT_CHANGED")
        self.assertEqual(path.read_bytes(), state[:-1])
        self.assertEqual(stored_context.read_bytes(), context + b' ')

    def test_invalid_state_is_rejected_before_persisting_then_corrected_secret_can_start(self):
        path = self.secrets / "priority-model-state.json"
        state = json.loads(path.read_bytes()); state["fit_status"] = "failed"
        content = json.dumps(state).encode(); path.write_bytes(content)
        self.context["model_state_sha256"] = hashlib.sha256(content).hexdigest()
        (self.secrets / "priority-context.json").write_text(json.dumps(self.context))
        self.assert_code("CONTEXT_STATE_INVALID")
        self.assertEqual(list((self.root / "priority").iterdir()), [])
        fixture(self.secrets)
        self.prepare()
        self.assertTrue((self.root / "priority" / "model-context.json").is_file())

    def test_context_schema_validation_is_distinct_from_json_and_hash_failures(self):
        path = self.secrets / "priority-context.json"
        path.write_text('[]')
        self.assert_code("CONTEXT_INVALID_JSON")
        self.context["model_state_sha256"] = "invalid"
        path.write_text(json.dumps(self.context))
        self.assert_code("CONTEXT_HASH_INVALID")
        self.context = fixture(self.secrets)
        self.context["model_version"] = "unknown"
        path.write_text(json.dumps(self.context))
        self.assert_code("CONTEXT_STATE_INVALID")

    def test_changed_state_and_pending_operations_are_not_overwritten(self):
        self.prepare()
        state = self.root / "priority" / "model.json"
        original = state.read_bytes()
        runtime = self.root / "priority" / "runtime"; runtime.mkdir()
        pending = runtime / "active.json"; pending.write_bytes(b'accepted operation')
        state.write_bytes(original + b' ')
        self.assert_code("PERSISTED_STATE_CHANGED")
        self.assertEqual(state.read_bytes(), original + b' ')
        self.assertEqual(pending.read_bytes(), b'accepted operation')

    def test_persistence_read_and_write_failures_have_constant_codes(self):
        path = self.root / "private-state.json"; path.write_bytes(b'{}')
        with patch.object(Path, "open", side_effect=PermissionError("/private/state")):
            self.assert_code("PERSISTED_STATE_UNREADABLE", lambda: module.preserve(path, b'{}', "PERSISTED_STATE"))
        with patch.object(Path, "open", side_effect=OSError("private checkpoint")):
            self.assert_code("PERSISTED_CONTEXT_WRITE_FAILED", lambda: module.preserve(self.root / "new.json", b'{}', "PERSISTED_CONTEXT"))

    def test_diagnostics_never_print_raw_exception_path_or_checkpoint(self):
        private = "/private/project/tinker://sensitive-checkpoint"
        for error, code in ((module.StartupError("TINKER_PROJECT_MISMATCH"), "TINKER_PROJECT_MISMATCH"),
                            (module.StartupError(private), "UNEXPECTED_FAILURE"),
                            (RuntimeError(private), "UNEXPECTED_FAILURE")):
            with self.subTest(code=code), patch.object(module, "prepare", side_effect=error):
                output = io.StringIO()
                with redirect_stderr(output):
                    self.assertEqual(module.main(), 1)
                self.assertEqual(output.getvalue(), f"Model startup blocked [{code}].\n")
                self.assertNotIn(private, output.getvalue())


if __name__ == "__main__":
    unittest.main()
