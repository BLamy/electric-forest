#!/usr/bin/env python3
"""E6-T04 differential normalizer: run the REAL tools/build_queue.py over a task-folder
tree rendered from a frozen graph fixture and print its decision as canonical JSON.

Usage: python3 tools/verify/queue_differential.py --tree <dir-with-epic-*/E*-T*/readme.md>

Nothing here re-implements queue semantics. The script copies the committed
build_queue.py (unchanged) into a scratch layout `<scratch>/tools/build_queue.py` with the
given tree at `<scratch>/.eforest/tasks/`, runs it, and parses the QUEUE.md it wrote:
the current gate, the next-up list, and every task line's (id, status, priority, deps,
capstone) tuple. `selected` is the gate when one exists, else the first next-up entry,
else null — exactly what the Python board tells a builder to do next.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
BUILD_QUEUE = ROOT / "tools" / "build_queue.py"

ICON_STATUS = {
    " ": "pending",
    "~": "in-progress",
    "?": "implemented",
    "!": "refuted",
    "x": "verified",
    "-": "cancelled",
}
GATE = re.compile(r"^1\. \*\*(?P<id>[^*]+)\*\* — .* \*\((?P<action>[^)]*)\)\*$")
ENTRY = re.compile(r"^1\. \*\*(?P<id>[^*]+)\*\* — ")
TASK = re.compile(
    r"^- \[(?P<icon>.)\] `\s*(?P<priority>[0-9.]+)` \[(?P<id>[^\]]+)\]\((?P<rel>[^)]*)\) — "
    r"(?P<title>.*?)(?P<cap> \*\*\[CAPSTONE\]\*\*)? \*\(deps: (?P<deps>.*)\)\*$"
)


def parse_queue(text: str) -> dict:
    section = None
    gate = None
    next_up: list[str] = []
    unlocks: list[str] = []
    tuples: list[list] = []
    for line in text.splitlines():
        if line.startswith("## "):
            section = line[3:]
            continue
        if section == "Current gate":
            m = GATE.match(line)
            if m:
                gate = m.group("id")
        elif section is not None and section.startswith("Next up"):
            m = ENTRY.match(line)
            if m:
                next_up.append(m.group("id"))
        elif section is not None and section.startswith("Unlocks when"):
            m = ENTRY.match(line)
            if m:
                unlocks.append(m.group("id"))
        m = TASK.match(line)
        if m and section is not None and section.startswith("Epic "):
            deps = [] if m.group("deps") == "—" else [d.strip() for d in m.group("deps").split(",")]
            tuples.append(
                [
                    m.group("id"),
                    ICON_STATUS[m.group("icon")],
                    m.group("priority"),
                    deps,
                    m.group("cap") is not None,
                ]
            )
    selected = gate if gate is not None else (next_up[0] if next_up else None)
    return {
        "gate": gate,
        "nextUp": next_up,
        "selected": selected,
        "tuples": tuples,
        "unlocks": unlocks,
    }


def run(tree: Path) -> dict:
    scratch = Path(tempfile.mkdtemp(prefix="e6-t04-py-"))
    try:
        (scratch / "tools").mkdir()
        shutil.copyfile(BUILD_QUEUE, scratch / "tools" / "build_queue.py")
        shutil.copytree(tree, scratch / ".eforest" / "tasks")
        proc = subprocess.run(
            [sys.executable, str(scratch / "tools" / "build_queue.py")],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            raise SystemExit(f"build_queue.py failed ({proc.returncode}): {proc.stderr}")
        markdown = (scratch / ".eforest" / "tasks" / "QUEUE.md").read_text(encoding="utf-8")
        result = parse_queue(markdown)
        result["markdown"] = markdown
        result["warnings"] = [w for w in proc.stderr.splitlines() if w.startswith("warning:")]
        return result
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tree", required=True)
    args = parser.parse_args()
    result = run(Path(args.tree))
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
