import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time

root = pathlib.Path(__file__).resolve().parents[7]
work = pathlib.Path(__file__).resolve().parent
phase = sys.argv[1]
holding = work / ("masked-dist-" + phase)
holding.mkdir()


def digest_tree(path):
    rows = []
    for entry in sorted(path.rglob("*")):
        if entry.is_symlink():
            rows.append([str(entry.relative_to(path)), "symlink", os.readlink(entry)])
        elif entry.is_file():
            rows.append([
                str(entry.relative_to(path)),
                "file",
                entry.stat().st_mode & 0o777,
                hashlib.sha256(entry.read_bytes()).hexdigest(),
            ])
    raw = json.dumps(rows, separators=(",", ":")).encode()
    return {"entries": len(rows), "sha256": hashlib.sha256(raw).hexdigest()}


outputs = sorted((root / "packages").glob("*/dist"))
outputs.extend(sorted((root / "apps").glob("*/dist")))
outputs = [p for p in outputs if p.is_dir()]
before = {str(p.relative_to(root)): digest_tree(p) for p in outputs}
receipt = {
    "phase": phase,
    "root": str(root),
    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "command": ["pnpm", "typecheck"],
    "maskedBuildOutputs": before,
    "environmentScrubbed": ["NODE_OPTIONS", "NODE_ENV", "npm_config_*"],
}
moved = []
code = None
try:
    for output in outputs:
        target = holding / str(output.relative_to(root)).replace("/", "__")
        output.rename(target)
        moved.append((output, target))
    receipt["remainingWorkspaceDistBeforeTypecheck"] = [
        str(p.relative_to(root))
        for base in [root / "packages", root / "apps"]
        for p in base.glob("*/dist")
        if p.exists()
    ]
    env = {
        k: v for k, v in os.environ.items()
        if k not in ("NODE_OPTIONS", "NODE_ENV") and not k.lower().startswith("npm_config_")
    }
    started = time.monotonic()
    with (work / (phase + ".stdout.log")).open("wb") as stdout:
        with (work / (phase + ".stderr.log")).open("wb") as stderr:
            code = subprocess.run(["pnpm", "typecheck"], cwd=root, env=env, stdout=stdout, stderr=stderr).returncode
    receipt["elapsedSeconds"] = time.monotonic() - started
    receipt["exitCode"] = code
    receipt["workspaceDistCreatedByTypecheck"] = [
        str(p.relative_to(root))
        for output, _ in moved
        for p in [output]
        if p.exists()
    ]
finally:
    for output, target in reversed(moved):
        if output.exists():
            raise RuntimeError("Typecheck unexpectedly emitted output at " + str(output))
        target.rename(output)
    after = {str(p.relative_to(root)): digest_tree(p) for p in outputs}
    receipt["restoredBuildOutputs"] = after
    receipt["buildOutputsRestoredByteExact"] = before == after
    receipt["stdoutSha256"] = hashlib.sha256((work / (phase + ".stdout.log")).read_bytes()).hexdigest()
    receipt["stderrSha256"] = hashlib.sha256((work / (phase + ".stderr.log")).read_bytes()).hexdigest()
    (work / (phase + ".json")).write_text(json.dumps(receipt, indent=2) + "\n")
    holding.rmdir()
print(json.dumps({"phase": phase, "exitCode": code, "maskedDirectories": len(outputs), "restoredByteExact": receipt["buildOutputsRestoredByteExact"], "elapsedSeconds": receipt.get("elapsedSeconds")}))
sys.exit(code if code is not None else 1)
