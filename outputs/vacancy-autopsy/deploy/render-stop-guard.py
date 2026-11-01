#!/usr/bin/env python3
"""Optional external watchdog. This is NOT a Render credit or spending cap.

Dry-run by default. No provisioning, credential discovery, resume, or deployment.
Keep policy, billing observations and backups outside Git. See RENDER-CREDITS.md.
"""
import argparse
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.render.com/v1"
OWNER = "tea-csp7iobgbbvc73etlgg0"
REPO = "https://github.com/himanshu748/vacancy-autopsy"
MOUNT = "/var/lib/vacancy-autopsy"


class GuardError(Exception):
    pass


def timestamp(value):
    if not isinstance(value, str):
        raise GuardError("Missing timestamp")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(timezone.utc)
    except ValueError:
        raise GuardError("Invalid timezone-aware timestamp") from None


def validate_policy(policy):
    if not isinstance(policy, dict):
        raise GuardError("Invalid guard policy")
    if policy.get("owner_id") != OWNER or not re.fullmatch(r"srv-[a-z0-9]{20}", policy.get("service_id", "")):
        raise GuardError("Policy must identify one service in the approved workspace")
    if not re.fullmatch(r"dsk-[a-z0-9]{20}", policy.get("disk_id", "")):
        raise GuardError("Policy must identify its exact persistent disk")
    start, end = timestamp(policy.get("observed_at")), timestamp(policy.get("stop_at"))
    if not 0 < (end - start).total_seconds() <= 24 * 3600:
        raise GuardError("Shutdown lease must be positive and at most 24 hours")
    return start, end


def stop_reason(policy, observation, now):
    start, end = validate_policy(policy)
    if now < start:
        return "policy_clock_in_future"
    if now >= end:
        return "shutdown_deadline"
    try:
        if observation.get("owner_id") != OWNER:
            return "billing_workspace_mismatch"
        observed = timestamp(observation.get("observed_at"))
        age = (now - observed).total_seconds()
        if not 0 <= age <= 900:
            return "billing_observation_stale_or_future"
        # Operator-observed total WORKSPACE net credit, after accrued usage.
        # It is not obtained from, or claimed to be, a Render billing API.
        balance = observation.get("net_credit_usd")
        if type(balance) not in (int, float) or not math.isfinite(balance):
            return "billing_balance_unavailable"
        if balance <= 10:
            return "credit_reserve_reached"
    except (AttributeError, GuardError):
        return "billing_observation_unavailable"
    return None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise GuardError("Render API redirect refused")


class RenderAPI:
    def __init__(self, token):
        if not token or any(c.isspace() for c in token):
            raise GuardError("Set RENDER_API_KEY privately; do not pass it as an argument")
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, path):
        # Callers supply only paths built from validated IDs, never provider URLs.
        if not re.fullmatch(r"/(services/srv-[a-z0-9]{20}(/suspend)?|disks/dsk-[a-z0-9]{20})", path):
            raise GuardError("Unapproved Render API path")
        request = urllib.request.Request(API + path, method=method, headers={
            "Authorization": "Bearer " + self.token, "Accept": "application/json",
        })
        try:
            with self.opener.open(request, timeout=15) as response:
                body = response.read(256_001)
                if len(body) > 256_000:
                    raise GuardError("Render response exceeds limit")
                return response.status, json.loads(body) if body else None
        except urllib.error.HTTPError as error:
            # Never log response bodies, request headers, or raw exceptions.
            if error.code in (404, 410):
                return error.code, None
            raise GuardError("Render request failed with HTTP " + str(error.code)) from None
        except (OSError, ValueError):
            raise GuardError("Render request failed; stop is NOT verified") from None


def scoped_service(api, policy):
    code, service = api.request("GET", "/services/" + policy["service_id"])
    if code in (404, 410):
        raise GuardError("Service missing; disk billing status is unknown")
    if code != 200 or not isinstance(service, dict):
        raise GuardError("Unexpected service response")
    if any(service.get(k) != v for k, v in {
        "id": policy["service_id"], "ownerId": OWNER, "name": "vacancy-autopsy",
        "type": "web_service", "repo": REPO,
    }.items()):
        raise GuardError("Service identity mismatch; no mutation permitted")
    return service


def verified_backup(policy, receipt_path, now):
    receipt = json.loads(Path(receipt_path).read_text())
    if not isinstance(receipt, dict):
        raise GuardError("Invalid backup receipt")
    if any(receipt.get(k) != policy[k] for k in ("service_id", "disk_id")):
        raise GuardError("Backup belongs to another resource")
    if receipt.get("writers_quiesced") is not True:
        raise GuardError("Backup requires an explicit quiesced-writer attestation")
    age = (now - timestamp(receipt.get("observed_at"))).total_seconds()
    if not 0 <= age <= 900:
        raise GuardError("Backup receipt must be at most 15 minutes old")
    archive = Path(receipt["archive_path"])
    if not archive.is_file() or archive.is_symlink() or archive.stat().st_size == 0:
        raise GuardError("Nonempty local backup required")
    if archive.stat().st_mode & 0o077:
        raise GuardError("Backup must have owner-only permissions")
    digest = hashlib.sha256()
    with archive.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != receipt.get("sha256"):
        raise GuardError("Backup hash mismatch")
    # Integrity and an operator attestation do not prove remote completeness.


def stop(api, policy, now, retire_disk=None, backup_receipt=None, pause=time.sleep):
    validate_policy(policy)
    service = scoped_service(api, policy)
    if service.get("suspended") != "suspended":
        code, _ = api.request("POST", "/services/" + policy["service_id"] + "/suspend")
        if code != 202:
            raise GuardError("Suspension was not accepted")
        for attempt in range(5):
            if attempt:
                pause(2)
            service = scoped_service(api, policy)
            if service.get("suspended") == "suspended":
                break
        else:
            raise GuardError("Suspension not verified; disk was preserved")
    if retire_disk is None:
        return {"compute": "suspended", "disk": "preserved_and_billable", "credits_only_cap": False}
    if retire_disk != policy["disk_id"] or backup_receipt is None:
        raise GuardError("Exact disk confirmation and verified backup receipt required")
    code, disk = api.request("GET", "/disks/" + retire_disk)
    if code not in (404, 410):
        if code != 200 or not isinstance(disk, dict) or any(disk.get(k) != v for k, v in {
            "id": retire_disk, "serviceId": policy["service_id"], "sizeGB": 1, "mountPath": MOUNT,
        }.items()):
            raise GuardError("Disk identity mismatch; no deletion permitted")
        verified_backup(policy, backup_receipt, now)
        code, _ = api.request("DELETE", "/disks/" + retire_disk)
        if code != 204:
            raise GuardError("Disk deletion was not accepted")
        code, _ = api.request("GET", "/disks/" + retire_disk)
        if code not in (404, 410):
            raise GuardError("Disk deletion not verified")
    return {"compute": "suspended", "disk": "absent", "credits_only_cap": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--billing-observation", type=Path)
    parser.add_argument("--apply-suspend", action="store_true")
    parser.add_argument("--retire-disk", help="Irreversible: exact separately approved disk ID")
    parser.add_argument("--backup-receipt", type=Path)
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    try:
        policy = json.loads(args.policy.read_text())
        try:
            observation = json.loads(args.billing_observation.read_text()) if args.billing_observation else None
        except (OSError, ValueError):
            observation = None  # Failure to read credits triggers stop, never continued spending.
        reason = stop_reason(policy, observation, now)
        result = {"reason": reason, "action": "stop" if reason else "no_stop_trigger", "credits_only_cap": False}
        if args.retire_disk and not args.apply_suspend:
            raise GuardError("Disk retirement requires --apply-suspend")
        if args.apply_suspend and (reason or args.retire_disk):
            result.update(stop(RenderAPI(os.environ.get("RENDER_API_KEY")), policy, now,
                               args.retire_disk, args.backup_receipt))
        else:
            result["mode"] = "dry_run" if not args.apply_suspend else "watchdog_observation"
        print(json.dumps(result))
        return 0
    except (GuardError, KeyError, TypeError, OSError, ValueError) as error:
        # GuardError text is controlled. Other exception text could contain private paths/content.
        print(json.dumps({"error": str(error) if isinstance(error, GuardError) else "Invalid local guard input",
                          "stop_verified": False, "credits_only_cap": False}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
