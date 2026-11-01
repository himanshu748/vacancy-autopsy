#!/usr/bin/env python3
"""Package shareable source only; never include tool caches or local evidence."""
from hashlib import sha256
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
destination = root.parent / "vacancy-autopsy.zip"
folders = {"src", "tests", "docs", "scripts", "ml", "public", "deploy"}
root_files = {".env.example", ".gitignore", "AGENTS.md", "CLAUDE.md", "LICENSE", "README.md",
              "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "index.html",
              "Dockerfile", ".dockerignore"}
excluded = {"node_modules", ".tools", ".git", "dist", "data", ".venv", "__pycache__",
            ".pytest_cache", "artifacts", "test-results", "playwright-report"}
suffixes = {".ts", ".tsx", ".css", ".html", ".mjs", ".cjs", ".py", ".md", ".json", ".txt",
            ".toml", ".yaml", ".yml", ".svg", ".ttf", ".woff", ".woff2", ".sh"}
files = []
for file in root.rglob("*"):
    relative = file.relative_to(root)
    if not file.is_file() or file.is_symlink() or any(part in excluded for part in relative.parts):
        continue
    # A symlinked parent must not pull files from outside this source tree.
    if any(parent.is_symlink() for parent in file.parents if parent != root.parent):
        continue
    include = (len(relative.parts) == 1 and file.name in root_files) or (
        relative.parts[0] in folders
        and (file.suffix in suffixes or relative.as_posix() == "deploy/render-full.yaml.example")
        and not file.name.startswith(".env")
        and ".local." not in file.name
    ) or relative.as_posix() == ".entire/agent-guide.md"
    if include:
        files.append(file)
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for file in sorted(files):
        archive.write(file, Path("vacancy-autopsy") / file.relative_to(root))
print(f"Packaged {len(files)} source files: {destination}")
print(f"SHA-256: {sha256(destination.read_bytes()).hexdigest()}")
