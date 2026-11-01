"""Materialize private model metadata, preserving accepted TabPFN operations.

No network requests or credential output. The full-model candidate deliberately
fails if the persistent mount or reviewed secret files are unavailable.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ml"))
from serve_extractor import validate_artifact
from tabpfn_service import load_context

ROOT = Path("/var/lib/vacancy-autopsy")
SECRETS = Path("/etc/secrets")
SAFE_CODES = frozenset(
    f"{stage}_{failure}"
    for stage in ("TINKER", "CONTEXT", "STATE", "PERSISTED_STATE", "PERSISTED_CONTEXT")
    for failure in ("MISSING", "UNREADABLE", "READ_FAILED", "TOO_LARGE")
) | {
    "MOUNT_REQUIRED", "MOUNT_UNREADABLE", "MOUNT_CHECK_FAILED", "TINKER_INVALID_JSON",
    "TINKER_INVALID", "TINKER_PROJECT_MISMATCH", "CONTEXT_INVALID_JSON", "STATE_INVALID_JSON",
    "STATE_FILENAME_INVALID", "CONTEXT_HASH_INVALID", "STATE_HASH_MISMATCH",
    "CONTEXT_STATE_INVALID", "PERSISTENCE_UNWRITABLE", "PERSISTED_STATE_CHANGED",
    "PERSISTED_CONTEXT_CHANGED", "PERSISTED_STATE_WRITE_FAILED", "PERSISTED_CONTEXT_WRITE_FAILED",
    "PERSISTED_VALIDATION_FAILED", "UNEXPECTED_FAILURE",
}


class StartupError(ValueError):
    """A constant diagnostic code; never include private metadata or exceptions."""

    def __init__(self, code: str):
        self.code = code if code in SAFE_CODES else "UNEXPECTED_FAILURE"
        super().__init__(self.code)


def bounded(path: Path, maximum: int) -> bytes:
    with path.open("rb") as handle:
        value = handle.read(maximum + 1)
    if len(value) > maximum:
        raise ValueError("Model metadata exceeds its bound")
    return value


def read_metadata(path: Path, maximum: int, stage: str) -> bytes:
    try:
        return bounded(path, maximum)
    except FileNotFoundError:
        raise StartupError(f"{stage}_MISSING") from None
    except PermissionError:
        raise StartupError(f"{stage}_UNREADABLE") from None
    except OSError:
        raise StartupError(f"{stage}_READ_FAILED") from None
    except ValueError:
        raise StartupError(f"{stage}_TOO_LARGE") from None


def parse_metadata(content: bytes, stage: str) -> dict:
    try:
        value = json.loads(content)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, UnicodeError):
        raise StartupError(f"{stage}_INVALID_JSON") from None


def restore_frozen_state(path: Path, content: bytes) -> None:
    """Atomically install already validated bytes; never rewrite runtime state."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".restore-", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def preserve(path: Path, content: bytes, stage: str, *, restore_state_final_lf: bool = False) -> None:
    try:
        if path.exists():
            existing = read_metadata(path, 64_000, stage)
            if existing != content:
                if restore_state_final_lf and stage == "PERSISTED_STATE" and existing + b"\n" == content:
                    restore_frozen_state(path, content)
                else:
                    raise StartupError(f"{stage}_CHANGED")
            return
        with path.open("xb") as handle:
            os.chmod(path, 0o600)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError:
        raise StartupError(f"{stage}_WRITE_FAILED") from None


def prepare(root: Path = ROOT, secrets: Path = SECRETS) -> None:
    try:
        root.stat()
        if not os.access(root, os.X_OK):
            raise StartupError("MOUNT_UNREADABLE")
        if not root.is_mount():
            raise StartupError("MOUNT_REQUIRED")
    except FileNotFoundError:
        raise StartupError("MOUNT_REQUIRED") from None
    except PermissionError:
        raise StartupError("MOUNT_UNREADABLE") from None
    except OSError:
        raise StartupError("MOUNT_CHECK_FAILED") from None
    training = parse_metadata(read_metadata(secrets / "tinker-training.json", 200_000, "TINKER"), "TINKER")
    try:
        training = validate_artifact(training)
    except Exception:
        raise StartupError("TINKER_INVALID") from None
    if training["project_id"] != os.environ.get("TINKER_PROJECT_ID"):
        raise StartupError("TINKER_PROJECT_MISMATCH")
    context_bytes = read_metadata(secrets / "priority-context.json", 64_000, "CONTEXT")
    context = parse_metadata(context_bytes, "CONTEXT")
    state_name = context.get("model_state_path")
    if (not isinstance(state_name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+\.json", state_name)
            or state_name == "model-context.json"):
        raise StartupError("STATE_FILENAME_INVALID")
    state_bytes = read_metadata(secrets / "priority-model-state.json", 64_000, "STATE")
    parse_metadata(state_bytes, "STATE")
    expected_hash = context.get("model_state_sha256")
    if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
        raise StartupError("CONTEXT_HASH_INVALID")
    if hashlib.sha256(state_bytes).hexdigest() != expected_hash:
        # Render's textarea transport can omit one final LF. Restore only that
        # exact byte when it reproduces the original reviewed checksum.
        if hashlib.sha256(state_bytes + b"\n").hexdigest() != expected_hash:
            raise StartupError("STATE_HASH_MISMATCH")
        state_bytes += b"\n"
    priority = root / "priority"
    try:
        priority.mkdir(mode=0o700, exist_ok=True)
        # Validate both reviewed files before installing immutable persisted
        # copies. An invalid secret must not poison a new disk on first boot.
        with tempfile.TemporaryDirectory(prefix=".startup-", dir=priority) as directory:
            staging = Path(directory)
            (staging / state_name).write_bytes(state_bytes)
            (staging / "model-context.json").write_bytes(context_bytes)
            try:
                load_context(staging / "model-context.json")
            except Exception:
                raise StartupError("CONTEXT_STATE_INVALID") from None
    except OSError:
        raise StartupError("PERSISTENCE_UNWRITABLE") from None
    context_path = priority / "model-context.json"
    if context_path.exists():
        # A changed frozen context must block even the narrowly permitted
        # bootstrap-state restoration before it mutates persisted bytes.
        preserve(context_path, context_bytes, "PERSISTED_CONTEXT")
    preserve(priority / state_name, state_bytes, "PERSISTED_STATE", restore_state_final_lf=True)
    preserve(context_path, context_bytes, "PERSISTED_CONTEXT")
    try:
        load_context(priority / "model-context.json")
    except Exception:
        raise StartupError("PERSISTED_VALIDATION_FAILED") from None


def main() -> int:
    try:
        prepare()
    except StartupError as error:
        print(f"Model startup blocked [{error.code}].", file=sys.stderr)
        return 1
    except BaseException:
        print("Model startup blocked [UNEXPECTED_FAILURE].", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
