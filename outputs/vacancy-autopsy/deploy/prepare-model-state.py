"""Materialize private model metadata, preserving accepted TabPFN operations.

No network requests or credential output. The full-model candidate deliberately
fails if the persistent mount or reviewed secret files are unavailable.
"""
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ml"))
from serve_extractor import validate_artifact
from tabpfn_service import load_context

ROOT = Path("/var/lib/vacancy-autopsy")
SECRETS = Path("/etc/secrets")


def bounded(path: Path, maximum: int) -> bytes:
    with path.open("rb") as handle:
        value = handle.read(maximum + 1)
    if len(value) > maximum:
        raise ValueError("Model metadata exceeds its bound")
    return value


def preserve(path: Path, content: bytes) -> None:
    if path.exists():
        if bounded(path, 64_000) != content:
            raise ValueError("Model changed; review pending operations before replacing context")
        return
    with path.open("xb") as handle:
        os.chmod(path, 0o600)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def prepare(root: Path = ROOT, secrets: Path = SECRETS) -> None:
    if not root.is_mount():
        raise ValueError("Full-model hosting requires the persistent model-state mount")
    training = validate_artifact(json.loads(bounded(secrets / "tinker-training.json", 200_000)))
    if training["project_id"] != os.environ.get("TINKER_PROJECT_ID"):
        raise ValueError("Project checkpoint does not match")
    context_bytes = bounded(secrets / "priority-context.json", 64_000)
    context = json.loads(context_bytes)
    state_name = context.get("model_state_path")
    if not isinstance(state_name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+\.json", state_name):
        raise ValueError("Model state must use a plain JSON filename")
    priority = root / "priority"
    priority.mkdir(mode=0o700, exist_ok=True)
    preserve(priority / state_name, bounded(secrets / "priority-model-state.json", 64_000))
    preserve(priority / "model-context.json", context_bytes)
    load_context(priority / "model-context.json")


if __name__ == "__main__":
    try:
        prepare()
    except BaseException:
        print("Model startup blocked. Check the persistent mount and reviewed project metadata.", file=sys.stderr)
        raise SystemExit(1) from None
