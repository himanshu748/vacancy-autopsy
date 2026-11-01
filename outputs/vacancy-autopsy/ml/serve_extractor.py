"""One bounded Tinker checkpoint sample over stdin; stdout contains four fields only.

This is candidate identity extraction, never an opening-status verdict. The caller
must review candidates and independently verify any employer-source relationship.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import html
import json
import os
from pathlib import Path
import signal
import sys
import unicodedata
from typing import Any
from urllib.parse import urlsplit

from data import DataError, sha256
from extractor import SYSTEM_PROMPT
from tinker_runner import prompt_tokens

FIELDS = {"employer", "title", "job_id", "ats"}
MAX_INPUT_BYTES = 80_000
MAX_OUTPUT_BYTES = 12_000


def normalized(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", html.unescape(value)).casefold().split())


def validate_input(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"url", "advertisementText"}:
        raise DataError("Invalid extraction input")
    url, text = value["url"], value["advertisementText"]
    if not isinstance(url, str) or not 1 <= len(url) <= 2000 or not isinstance(text, str) or len(text) > 16000:
        raise DataError("Invalid extraction input")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port:
        raise DataError("Invalid extraction input")
    return {"url": url, "advertisementText": text}


def validate_artifact(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("kind") != "tinker_training" or value.get("status") != "completed":
        raise DataError("A completed training artifact is required")
    if value.get("prompt_sha256") != sha256(SYSTEM_PROMPT) or value.get("base_model") != "Qwen/Qwen3-8B":
        raise DataError("Training renderer does not match")
    if not isinstance(value.get("project_id"), str) or not value["project_id"].strip():
        raise DataError("A project-specific checkpoint is required")
    checkpoint = value.get("checkpoint")
    if not isinstance(checkpoint, str) or not checkpoint.startswith("tinker://") or len(checkpoint) > 1000 or any(c.isspace() for c in checkpoint):
        raise DataError("A checkpoint is required")
    context = value.get("max_context_tokens")
    if type(context) is not int or not 512 <= context <= 16384:
        raise DataError("Invalid context limit")
    return value


def grounded_fields(value: Any, request: dict[str, str]) -> dict[str, str | None]:
    if not isinstance(value, dict) or set(value) != FIELDS:
        raise DataError("Extractor did not return exactly four fields")
    limits = {"employer": 300, "title": 500, "job_id": 100}
    result: dict[str, str | None] = {}
    visible = request["url"] + "\n" + request["advertisementText"]
    canonical = normalized(visible)
    for field, maximum in limits.items():
        item = value[field]
        if item is not None and (not isinstance(item, str) or len(item) > maximum):
            raise DataError("Invalid extracted field")
        item = item.strip() if isinstance(item, str) else None
        if not item or (field == "job_id" and item not in visible) or (field != "job_id" and normalized(item) not in canonical):
            item = None
        result[field] = item
    ats = value["ats"]
    if ats not in ("greenhouse", "lever", "ashby", None):
        raise DataError("Invalid ATS field")
    result["ats"] = ats if ats and ats in canonical else None
    return result


def sample_identity(request: dict[str, str], artifact: dict[str, Any], *, tokenizer_cache: Path) -> dict[str, str | None]:
    # Keep tokenizer files local, and never use model code from a remote repository.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["HF_HUB_CACHE"] = str(tokenizer_cache.resolve())
    # Do not execute a global credential command or reuse a different endpoint.
    os.environ.pop("TINKER_CREDENTIAL_CMD", None)
    os.environ.pop("TINKER_BASE_URL", None)
    project_id = os.environ.get("TINKER_PROJECT_ID")
    if not project_id or artifact.get("project_id") != project_id:
        raise DataError("Checkpoint project does not match")
    from tinker.lib.retry_handler import RetryConfig
    import tinker
    service = tinker.ServiceClient(api_key=os.environ["TINKER_API_KEY"], project_id=project_id,
                                   base_url="https://tinker.thinkingmachines.dev/services/tinker-prod",
                                   display_name="Vacancy Autopsy reviewed identity extraction")
    status = "errored"
    try:
        sampler = service.create_sampling_client(model_path=artifact["checkpoint"],
            retry_config=RetryConfig(enable_retry_logic=False, max_connections=1, progress_timeout=35))
        if sampler.get_base_model() != artifact["base_model"]:
            raise DataError("Checkpoint renderer does not match")
        tokenizer = sampler.get_tokenizer()
        if tokenizer.eos_token_id is None:
            raise DataError("Tokenizer has no EOS token")
        tokens = prompt_tokens(tokenizer, {"advertisement_url": request["url"], "advertisement_text": request["advertisementText"]})
        if len(tokens) + 512 > artifact["max_context_tokens"]:
            raise DataError("Input exceeds checkpoint context")
        # One logical sample; no caller retry or base-model fallback. The pinned
        # SDK may retry idempotent transport/backpressure internally until the
        # enclosing process deadline. It never receives tool/publication access.
        response = sampler.sample(prompt=tinker.types.ModelInput.from_ints(tokens), num_samples=1,
            sampling_params=tinker.types.SamplingParams(max_tokens=512, temperature=0.0, stop=[tokenizer.eos_token_id])).result(timeout=35)
        if len(response.sequences) != 1 or len(response.sequences[0].tokens) > 512:
            raise DataError("Unexpected model response")
        raw = tokenizer.decode(response.sequences[0].tokens, skip_special_tokens=True)
        if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise DataError("Invalid model response")
        result = grounded_fields(json.loads(raw), request)
        status = "success"
        return result
    finally:
        try:
            service.close(status=status, detail="Single reviewed identity candidate").result(timeout=2)
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--tokenizer-cache", type=Path)
    args = parser.parse_args()
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        raise DataError("Input exceeds limit")
    request = validate_input(json.loads(data.decode("utf-8", errors="strict")))
    if args.artifact.stat().st_size > 200_000:
        raise DataError("Training artifact exceeds limit")
    artifact = validate_artifact(json.loads(args.artifact.read_text()))
    if not os.environ.get("TINKER_API_KEY"):
        raise DataError("Tinker is not configured")
    def deadline(_signum, _frame):
        raise TimeoutError("Extraction deadline reached")
    previous = signal.signal(signal.SIGALRM, deadline)
    signal.alarm(40)
    try:
        with redirect_stdout(sys.stderr):
            fields = sample_identity(request, artifact, tokenizer_cache=args.tokenizer_cache or args.artifact.resolve().parent.parent / "model-tokenizers")
        print(json.dumps(fields, ensure_ascii=False), flush=True)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Native SDK exceptions may carry model inputs, URLs or credentials.
        print("Identity extraction could not finish.", file=sys.stderr)
        raise SystemExit(1) from None
