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
command = sys.argv[2:]
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
    return {"entries": len(rows), "sha256": hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()}


def dist_paths():
    return sorted(p for base in [root / "packages", root / "apps"] for p in base.glob("*/dist") if p.exists())


outputs = dist_paths()
before = {str(p.relative_to(root)): digest_tree(p) for p in outputs}
receipt = {
    "phase": phase,
    "root": str(root),
    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "command": command,
    "workingConfigSha256": hashlib.sha256((root / "vitest.config.ts").read_bytes()).hexdigest(),
    "maskedBuildOutputs": before,
    "environmentScrubbed": ["NODE_OPTIONS", "NODE_ENV", "npm_config_*"],
    "environmentForced": {"EFOREST_TEST_PREBUILT": "1", "NO_COLOR": "1"},
}
moved = []
code = None
try:
    for output in outputs:
        target = holding / str(output.relative_to(root)).replace("/", "__")
        output.rename(target)
        moved.append((output, target))
    receipt["remainingWorkspaceDistBeforeCommand"] = [str(p.relative_to(root)) for p in dist_paths()]
    env = {k: v for k, v in os.environ.items() if k not in ("NODE_OPTIONS", "NODE_ENV") and not k.lower().startswith("npm_config_")}
    env.update(receipt["environmentForced"])
    started = time.monotonic()
    with (work / (phase + ".stdout.log")).open("wb") as stdout, (work / (phase + ".stderr.log")).open("wb") as stderr:
        code = subprocess.run(command, cwd=root, env=env, stdout=stdout, stderr=stderr).returncode
    receipt["elapsedSeconds"] = time.monotonic() - started
    receipt["exitCode"] = code
finally:
    created = dist_paths()
    receipt["workspaceDistCreatedByCommand"] = [str(p.relative_to(root)) for p in created]
    for output in created:
        target = work / (phase + "-new-outputs") / output.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        output.rename(target)
    for output, target in reversed(moved):
        target.rename(output)
    after = {str(p.relative_to(root)): digest_tree(p) for p in outputs}
    receipt["restoredBuildOutputs"] = after
    receipt["buildOutputsRestoredByteExact"] = before == after
    for stream in ["stdout", "stderr"]:
        receipt[stream + "Sha256"] = hashlib.sha256((work / (phase + "." + stream + ".log")).read_bytes()).hexdigest()
    (work / (phase + ".json")).write_text(json.dumps(receipt, indent=2) + "\n")
    holding.rmdir()
print(json.dumps({"phase": phase, "exitCode": code, "maskedDirectories": len(outputs), "restoredByteExact": receipt["buildOutputsRestoredByteExact"], "generatedOutputDirectories": receipt["workspaceDistCreatedByCommand"], "elapsedSeconds": receipt.get("elapsedSeconds")}))
sys.exit(code if code else (2 if receipt["workspaceDistCreatedByCommand"] else 0))
