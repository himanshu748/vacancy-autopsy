"""Cache the reviewed public tokenizer revision, without weights or model code."""
import os
from pathlib import Path
import sys

from huggingface_hub import snapshot_download
from transformers import AutoTokenizer

REVISION = "b968826d9c46dd6066d109eabc6255188de91218"
MODEL = "Qwen/Qwen3-8B"

if __name__ == "__main__":
    cache = Path(sys.argv[1]).resolve()
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    snapshot_download(MODEL, revision=REVISION, cache_dir=cache, token=False,
                      allow_patterns=["config.json", "tokenizer.json", "tokenizer_config.json",
                                      "vocab.json", "merges.txt", "LICENSE"])
    # The SDK asks for the model's default revision at inference. Pin that local
    # alias to the same immutable revision; inference itself is offline.
    reference = cache / "models--Qwen--Qwen3-8B" / "refs" / "main"
    reference.parent.mkdir(parents=True, exist_ok=True)
    reference.write_text(REVISION)
    tokenizer = AutoTokenizer.from_pretrained(MODEL, cache_dir=cache,
                                              trust_remote_code=False, local_files_only=True, token=False)
    assert tokenizer.eos_token_id is not None
    assert not list(cache.rglob("*.safetensors"))
