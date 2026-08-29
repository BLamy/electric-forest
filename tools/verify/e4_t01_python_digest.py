#!/usr/bin/env python3
"""Independently derive the frozen E4-T01 worktree digest."""

from __future__ import annotations

import hashlib
import json
import sys
import unicodedata
from pathlib import Path


def projection(root: Path) -> dict[str, dict[str, dict[str, int | str]]]:
    files: dict[str, dict[str, int | str]] = {}
    exclude_root_ef = (root / ".ef").is_dir()
    for path in sorted(root.rglob("*"), key=lambda item: item.relative_to(root).as_posix()):
        relative = path.relative_to(root).as_posix()
        if exclude_root_ef and (relative == ".ef" or relative.startswith(".ef/")):
            continue
        if not path.is_file():
            continue
        if unicodedata.normalize("NFC", relative) != relative:
            raise ValueError(f"non-NFC path: {relative!r}")
        data = path.read_bytes()
        files[relative] = {
            "contentSha256": hashlib.sha256(data).hexdigest(),
            "size": len(data),
        }
    return {"files": files}


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <fixture-dir> <expected-digest>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1]).resolve()
    expected = Path(sys.argv[2]).read_text(encoding="utf-8").strip()
    canonical = json.dumps(
        projection(root), ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    actual = hashlib.sha256(canonical).hexdigest()
    if actual != expected:
        print(f"PYTHON-DIGEST: {actual} EXPECTED {expected}", file=sys.stderr)
        return 1
    print(f"PYTHON-DIGEST: {actual}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
