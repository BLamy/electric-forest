import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const task = resolve(root, ".eforest/tasks/epic-2-the-gates/E2-T05-cli-device-token-flow");
const evidence = resolve(task, "evidence");
const golden = (await readFile(resolve(evidence, "e2-t05-identity-golden.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
assert.deepEqual(
  golden
    .filter((record) => record.type.startsWith("identity.grant."))
    .map((record) => [record.type, record.payload.tokenKind ?? null]),
  [
    ["identity.grant.issued", "device"],
    ["identity.grant.issued", "web-mint"],
    ["identity.grant.revoked", null],
  ],
);
assert.ok(golden.every((record) => !("token" in record.payload) && !("secret" in record.payload)));

const manifest = JSON.parse(
  await readFile(resolve(evidence, "e2-t05-browser-artifacts.json"), "utf8"),
);
assert.equal(manifest.capturedTogether, true);
const trace = await readFile(resolve(task, manifest.trace.path));
assert.equal(createHash("sha256").update(trace).digest("hex"), manifest.trace.sha256);
const mp4Path = resolve(root, manifest.video.path);
try {
  await access(mp4Path);
  const mp4 = await readFile(mp4Path);
  assert.equal(createHash("sha256").update(mp4).digest("hex"), manifest.video.sha256);
  await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", mp4Path]);
  process.stdout.write("E2_T05_MP4_VERIFIED\n");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  process.stdout.write("E2_T05_MP4_LOCAL_ONLY manifest-hash-retained\n");
}

for (const name of ["e2-t05-transcript.txt", "e2-t05-browser.txt", "e2-t05-sensitivity.md"]) {
  const text = await readFile(resolve(evidence, name), "utf8");
  assert.ok(text.includes("OK") || text.includes("went red"), `${name} lacks a success marker`);
}
process.stdout.write("E2_T05_EVIDENCE_OK\n");
