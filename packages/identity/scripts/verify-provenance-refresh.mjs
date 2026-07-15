import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scopeBase = "4b70c57b5f1d21ac7a914c18faae11dee12d777c";
const evidenceRoot = ".eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence";
const provenancePath = `${evidenceRoot}/transport-provenance.json`;
const manifestPath = `${evidenceRoot}/evidence-manifest.json`;
const expectedChangedInputs = ["Makefile", "package.json", "pnpm-lock.yaml"];
const expectedE1Changes = [manifestPath, provenancePath].sort();
const verifierPaths = ["tools/verify/e1_capstone.mjs", "tools/verify/e1_capstone_sabotage.mjs"];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(arguments_, label) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
  return result.stdout;
}

function fromCommit(path) {
  return git(["show", `${scopeBase}:${path}`], `read ${path} at scope base`);
}

const baseProvenance = JSON.parse(fromCommit(provenancePath));
const currentProvenanceBytes = readFileSync(join(root, provenancePath));
const currentProvenance = JSON.parse(currentProvenanceBytes);
const baseFiles = new Map(baseProvenance.files.map((file) => [file.path, file.sha256]));
const currentFiles = new Map(currentProvenance.files.map((file) => [file.path, file.sha256]));

assert.deepEqual([...currentFiles.keys()], [...baseFiles.keys()], "E1 provenance file set changed");
const actualChangedInputs = [...currentFiles]
  .filter(([path, sha256]) => baseFiles.get(path) !== sha256)
  .map(([path]) => path)
  .sort();
assert.deepEqual(
  actualChangedInputs,
  expectedChangedInputs,
  "only the three human-approved E2 integration inputs may change E1 provenance",
);
for (const path of expectedChangedInputs) {
  assert.equal(
    currentFiles.get(path),
    digest(readFileSync(join(root, path))),
    `${path} provenance does not bind current bytes`,
  );
}

const withoutFiles = ({ files: _files, ...value }) => value;
assert.deepEqual(
  withoutFiles(currentProvenance),
  withoutFiles(baseProvenance),
  "E1 provenance changed outside its file-hash entries",
);

const baseManifest = JSON.parse(fromCommit(manifestPath));
const currentManifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
const expectedManifest = structuredClone(baseManifest);
expectedManifest.artifacts["transport-provenance.json"] = digest(currentProvenanceBytes);
assert.deepEqual(
  currentManifest,
  expectedManifest,
  "E1 evidence manifest changed outside the refreshed provenance digest",
);

const changedE1Paths = git(
  ["diff", "--name-only", scopeBase, "--", evidenceRoot],
  "enumerate E1 evidence changes",
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .sort();
assert.deepEqual(
  changedE1Paths,
  expectedE1Changes,
  "only the two human-approved derived E1 artifacts may change",
);
git(
  ["diff", "--exit-code", scopeBase, "--", ...verifierPaths],
  "prove E1 provenance verifier unchanged",
);

process.stdout.write(
  `${JSON.stringify({
    changedE1Paths,
    changedInputs: actualChangedInputs,
    manifestProvenanceDigest: currentManifest.artifacts["transport-provenance.json"],
    scopeBase,
    verifierPaths,
  })}\n`,
);
