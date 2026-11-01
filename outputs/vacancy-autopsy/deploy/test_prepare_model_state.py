"""Synthetic startup regressions; no credentials or provider requests."""
import hashlib
import importlib.util
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

    def test_unmounted_filesystem_is_rejected_before_writing(self):
        with patch.object(Path, "is_mount", return_value=False), self.assertRaisesRegex(ValueError, "persistent"):
            module.prepare(self.root, self.secrets)
        self.assertEqual(list(self.root.iterdir()), [])

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
        with self.assertRaisesRegex(ValueError, "Model changed"):
            self.prepare()
        self.assertEqual((self.root / "priority" / "model-context.json").read_bytes(), original)

    def test_cross_project_checkpoint_and_traversal_are_rejected(self):
        with patch.object(Path, "is_mount", return_value=True), patch.dict(os.environ, {"TINKER_PROJECT_ID": "different-project"}), self.assertRaisesRegex(ValueError, "Project"):
            module.prepare(self.root, self.secrets)
        self.context["model_state_path"] = "../outside.json"
        (self.secrets / "priority-context.json").write_text(json.dumps(self.context))
        with self.assertRaisesRegex(ValueError, "plain JSON filename"):
            self.prepare()
        self.assertFalse((self.root / "outside.json").exists())


if __name__ == "__main__":
    unittest.main()
