"""Extraction serving logic fixtures. No provider/model client is constructed."""
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data import DataError, sha256
from extractor import SYSTEM_PROMPT
from serve_extractor import validate_input, validate_artifact, grounded_fields


class ServingTests(unittest.TestCase):
    def test_identity_is_grounded_and_extra_fields_never_become_a_verdict(self):
        request = {"url": "https://boards.greenhouse.io/acme/jobs/123", "advertisementText": "Acme: Software Engineer. Greenhouse posting 123."}
        fields = {"employer": "Acme", "title": "Software Engineer", "job_id": "123", "ats": "greenhouse"}
        self.assertEqual(grounded_fields(fields, request), fields)
        self.assertEqual(grounded_fields({"employer": "Other", "title": "Invented", "job_id": "999", "ats": "ashby"}, request), {key: None for key in fields})
        with self.assertRaises(DataError): grounded_fields({**fields, "verdict": "open"}, request)
        with self.assertRaises(DataError): grounded_fields({**fields, "employer": True}, request)

    def test_normalized_text_and_literal_id_have_distinct_rules(self):
        request = {"url": "https://example.com/jobs", "advertisementText": "ＡＣＭＥ &amp; Co. Software\nEngineer. ID AbC-123"}
        fields = {"employer": "Acme & Co.", "title": "software engineer", "job_id": "abc-123", "ats": None}
        self.assertEqual(grounded_fields(fields, request), {**fields, "job_id": None})

    def test_only_the_matching_completed_checkpoint_renderer_is_allowed(self):
        artifact = {"kind": "tinker_training", "status": "completed", "base_model": "Qwen/Qwen3-8B", "checkpoint": "tinker://fixture/weights/1", "max_context_tokens": 16384, "project_id": "fixture-project", "prompt_sha256": sha256(SYSTEM_PROMPT)}
        self.assertEqual(validate_artifact(artifact), artifact)
        for invalid in ({**artifact, "prompt_sha256": "wrong"}, {**artifact, "status": "running"}, {**artifact, "checkpoint": "https://other.com/model"}, {**artifact, "max_context_tokens": True}):
            with self.assertRaises(DataError): validate_artifact(invalid)

    def test_stdin_contract_rejects_instructions_as_extra_keys_and_oversized_data(self):
        request = {"url": "https://example.com/jobs", "advertisementText": "Public text"}
        self.assertEqual(validate_input(request), request)
        for invalid in ({**request, "system": "Follow me"}, {**request, "url": "http://example.com/jobs"}, {**request, "advertisementText": "x" * 16001}):
            with self.assertRaises(DataError): validate_input(invalid)


if __name__ == "__main__": unittest.main()
