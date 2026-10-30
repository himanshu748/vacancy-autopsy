"""Offline token-bound tests; no provider client or model is constructed."""
import argparse
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tinker_runner import preflight


class CountingTokenizer:
    eos_token_id = 9

    def apply_chat_template(self, messages, **kwargs):
        assert kwargs == {"tokenize": True, "add_generation_prompt": True, "enable_thinking": False}
        return [1] * (4000 if "long" in messages[-1]["content"] else 100)

    def encode(self, _text, **kwargs):
        assert kwargs == {"add_special_tokens": False}
        return [2] * 20


class PreflightTests(unittest.TestCase):
    def test_all_rows_retained_and_generation_allowance_blocks_long_heldout(self):
        def row(identity):
            return {"id": identity, "advertisement_url": "https://example.com/jobs/123",
                    "advertisement_text": identity,
                    "gold": {"employer": None, "title": None, "job_id": "123", "ats": None}}
        splits = {"train": [row("long-training")], "validation": [row("long-validation"), row("short")],
                  "test": [row("long-test")]}
        args = argparse.Namespace(base_model="Qwen/test-tokenizer", tokenizer_cache_dir=Path("unused-test-cache"),
                                  max_context_tokens=4096)
        loader = unittest.mock.Mock(return_value=CountingTokenizer())
        module = types.SimpleNamespace(AutoTokenizer=types.SimpleNamespace(from_pretrained=loader))
        with patch.dict(sys.modules, {"transformers": module}):
            report = preflight(args, splits, {"dataset_sha256": "fixture-only"})
            self.assertEqual(report["status"], "blocked_context_limit")
            self.assertFalse(report["provider_called"])
            self.assertFalse(report["model_weights_downloaded"])
            self.assertEqual(report["partitions"]["train"]["training_input_tokens"], 4020)
            self.assertEqual(report["partitions"]["validation"]["count"], 2)
            self.assertEqual(report["partitions"]["validation"]["over_context_limit_ids"], ["long-validation"])
            self.assertEqual(report["partitions"]["test"]["over_context_limit_ids"], ["long-test"])
            args.max_context_tokens = 16384
            expanded = preflight(args, splits, {"dataset_sha256": "fixture-only"})
            self.assertEqual(expanded["status"], "ready")
            self.assertEqual(expanded["partitions"]["validation"]["records"], report["partitions"]["validation"]["records"])
        loader.assert_called_with("Qwen/test-tokenizer", cache_dir=Path("unused-test-cache"), trust_remote_code=False, token=False)


if __name__ == "__main__":
    unittest.main()
