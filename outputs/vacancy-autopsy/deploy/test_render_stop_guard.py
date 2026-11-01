import copy
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location("render_guard", Path(__file__).with_name("render-stop-guard.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

NOW = datetime(2026, 11, 1, 3, tzinfo=timezone.utc)
SERVICE = "srv-" + "a" * 20
DISK = "dsk-" + "b" * 20
POLICY = {"owner_id": guard.OWNER, "service_id": SERVICE, "disk_id": DISK,
          "observed_at": (NOW - timedelta(minutes=1)).isoformat(),
          "stop_at": (NOW + timedelta(hours=2)).isoformat()}
BILLING = {"owner_id": guard.OWNER, "observed_at": NOW.isoformat(), "net_credit_usd": 50}


class FakeAPI:
    def __init__(self):
        self.calls = []
        self.service = {"id": SERVICE, "ownerId": guard.OWNER, "name": "vacancy-autopsy",
                        "type": "web_service", "repo": guard.REPO, "suspended": "not_suspended"}
        self.disk = {"id": DISK, "serviceId": SERVICE, "sizeGB": 1, "mountPath": guard.MOUNT}
        self.confirm_suspend = True
        self.confirm_delete = True

    def request(self, method, path):
        self.calls.append((method, path))
        if path == "/services/" + SERVICE and method == "GET":
            return 200, copy.deepcopy(self.service)
        if path == "/services/" + SERVICE + "/suspend" and method == "POST":
            if self.confirm_suspend:
                self.service["suspended"] = "suspended"
            return 202, None
        if path == "/disks/" + DISK and method == "GET":
            return (200, self.disk) if self.disk is not None else (404, None)
        if path == "/disks/" + DISK and method == "DELETE":
            if self.confirm_delete:
                self.disk = None
            return 204, None
        raise AssertionError("Unexpected resource mutation")


class CreditDecisionTests(unittest.TestCase):
    def test_fresh_workspace_observation_does_not_claim_a_cap(self):
        self.assertIsNone(guard.stop_reason(POLICY, BILLING, NOW))

    def test_unknown_malformed_and_wrong_workspace_credit_triggers_stop(self):
        for observation in (None, [], {}, {**BILLING, "net_credit_usd": None},
                            {**BILLING, "net_credit_usd": True},
                            {**BILLING, "net_credit_usd": float("nan")},
                            {**BILLING, "owner_id": "another-workspace"}):
            with self.subTest(observation=observation):
                self.assertIsNotNone(guard.stop_reason(POLICY, observation, NOW))

    def test_stale_future_and_reserve_boundary_stop(self):
        for observation in ({**BILLING, "observed_at": (NOW - timedelta(seconds=901)).isoformat()},
                            {**BILLING, "observed_at": (NOW + timedelta(seconds=1)).isoformat()},
                            {**BILLING, "net_credit_usd": 10}, {**BILLING, "net_credit_usd": -1}):
            self.assertIsNotNone(guard.stop_reason(POLICY, observation, NOW))

    def test_hard_deadline_applies_even_with_large_credit(self):
        self.assertEqual(guard.stop_reason({**POLICY, "stop_at": NOW.isoformat()}, BILLING, NOW), "shutdown_deadline")

    def test_unbounded_lease_path_injection_and_invalid_policy_rejected(self):
        for policy in ([], {**POLICY, "service_id": SERVICE + "/../other"},
                       {**POLICY, "owner_id": "another-workspace"},
                       {**POLICY, "stop_at": (NOW + timedelta(days=2)).isoformat()}):
            with self.assertRaises(guard.GuardError):
                guard.validate_policy(policy)


class ShutdownTests(unittest.TestCase):
    def setUp(self):
        self.api = FakeAPI()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.archive = Path(self.temp.name) / "private-state.tar"
        self.archive.write_bytes(b"synthetic pending-operation backup")
        os.chmod(self.archive, 0o600)
        self.receipt = Path(self.temp.name) / "backup.json"
        self.backup = {"service_id": SERVICE, "disk_id": DISK, "writers_quiesced": True,
                       "observed_at": NOW.isoformat(), "archive_path": str(self.archive),
                       "sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest()}
        self.write_receipt()

    def write_receipt(self):
        self.receipt.write_text(json.dumps(self.backup))

    def stop(self, **kwargs):
        return guard.stop(self.api, POLICY, NOW, pause=lambda _: None, **kwargs)

    def test_foreign_service_identity_prevents_all_mutations(self):
        for key, wrong in (("ownerId", "other"), ("repo", "https://example.com"),
                           ("name", "other-project"), ("id", "srv-" + "c" * 20)):
            self.api = FakeAPI()
            self.api.service[key] = wrong
            with self.assertRaises(guard.GuardError):
                self.stop()
            self.assertTrue(all(method == "GET" for method, _ in self.api.calls))

    def test_default_stop_preserves_disk_and_explicitly_reports_ongoing_billing(self):
        result = self.stop()
        self.assertEqual(result, {"compute": "suspended", "disk": "preserved_and_billable", "credits_only_cap": False})
        self.assertFalse(any(method == "DELETE" for method, _ in self.api.calls))

    def test_no_disk_deletion_if_suspend_is_only_accepted_but_not_verified(self):
        self.api.confirm_suspend = False
        with self.assertRaises(guard.GuardError):
            self.stop(retire_disk=DISK, backup_receipt=self.receipt)
        self.assertFalse(any(method == "DELETE" for method, _ in self.api.calls))

    def test_retirement_requires_exact_disk_and_local_backup(self):
        for kwargs in ({"retire_disk": "dsk-" + "c" * 20, "backup_receipt": self.receipt},
                       {"retire_disk": DISK}):
            with self.assertRaises(guard.GuardError):
                self.stop(**kwargs)
        self.assertFalse(any(method == "DELETE" for method, _ in self.api.calls))

    def test_foreign_disk_never_deleted(self):
        self.api.disk["serviceId"] = "srv-" + "c" * 20
        with self.assertRaises(guard.GuardError):
            self.stop(retire_disk=DISK, backup_receipt=self.receipt)
        self.assertFalse(any(method == "DELETE" for method, _ in self.api.calls))

    def test_tampered_stale_foreign_or_unquiesced_backup_never_deletes_disk(self):
        for patch in ({"sha256": "0" * 64}, {"writers_quiesced": False},
                      {"disk_id": "other"},
                      {"observed_at": (NOW - timedelta(minutes=16)).isoformat()}):
            self.api = FakeAPI()
            self.receipt.write_text(json.dumps({**self.backup, **patch}))
            with self.assertRaises(guard.GuardError):
                self.stop(retire_disk=DISK, backup_receipt=self.receipt)
            self.assertFalse(any(method == "DELETE" for method, _ in self.api.calls))

    def test_publicly_readable_backup_prevents_deletion(self):
        os.chmod(self.archive, 0o644)
        with self.assertRaises(guard.GuardError):
            self.stop(retire_disk=DISK, backup_receipt=self.receipt)

    def test_explicit_retirement_is_scoped_verified_and_idempotent(self):
        for _ in range(2):
            result = self.stop(retire_disk=DISK, backup_receipt=self.receipt)
            self.assertEqual(result["disk"], "absent")
            self.assertFalse(result["credits_only_cap"])
        self.assertEqual(sum(method == "DELETE" for method, _ in self.api.calls), 1)
        self.assertEqual(sum(method == "POST" for method, _ in self.api.calls), 1)

    def test_delete_acceptance_without_confirmation_is_not_reported_as_success(self):
        self.api.confirm_delete = False
        with self.assertRaises(guard.GuardError):
            self.stop(retire_disk=DISK, backup_receipt=self.receipt)

    def test_transport_failure_does_not_claim_stop(self):
        def fail(*_):
            raise guard.GuardError("Render request failed; stop is NOT verified")
        self.api.request = fail
        with self.assertRaisesRegex(guard.GuardError, "NOT verified"):
            self.stop()


class TransportTests(unittest.TestCase):
    def test_redirects_and_arbitrary_paths_are_refused(self):
        with self.assertRaises(guard.GuardError):
            guard.NoRedirect().redirect_request(None, None, 302, "", {}, "https://attacker.invalid")
        api = guard.RenderAPI("synthetic-key")
        for path in ("https://example.com", "/services", "/services/" + SERVICE + "/resume",
                     "/services/" + SERVICE + "?token=secret"):
            with self.assertRaises(guard.GuardError):
                api.request("GET", path)

    def test_default_cli_stop_plan_does_not_require_a_key_or_contact_render(self):
        with tempfile.TemporaryDirectory() as directory:
            policy_path = Path(directory) / "policy.json"
            policy_path.write_text(json.dumps(POLICY))
            result = subprocess.run([sys.executable, str(Path(guard.__file__)), "--policy", str(policy_path)],
                                    env={k: v for k, v in os.environ.items() if k != "RENDER_API_KEY"},
                                    capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            self.assertEqual(output["action"], "stop")
            self.assertEqual(output["mode"], "dry_run")
            self.assertFalse(output["credits_only_cap"])


if __name__ == "__main__":
    unittest.main()
