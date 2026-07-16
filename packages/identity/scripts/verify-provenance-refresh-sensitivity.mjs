import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sensorPath = "packages/identity/scripts/verify-provenance-refresh.mjs";
const evidenceRoot = ".eforest/tasks/epic-1-the-trunk/E1-T11-the-first-repo/evidence";
const provenancePath = `${evidenceRoot}/transport-provenance.json`;
const manifestPath = `${evidenceRoot}/evidence-manifest.json`;
const scratch = mkdtempSync(join(tmpdir(), "eforest-e2-provenance-sensitivity-"));
const fixture = join(scratch, "repo");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(command, arguments_, cwd) {
  return spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function sensorResult() {
  return run(process.execPath, [sensorPath], fixture);
}

function assertSensorPasses(label) {
  const result = sensorResult();
  assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
}

function assertSensorFails(label, expectedMessage) {
  const result = sensorResult();
  assert.notEqual(result.status, 0, `${label} unexpectedly passed: ${result.stdout}`);
  assert.match(
    `${result.stdout}${result.stderr}`,
    expectedMessage,
    `${label} failed through the wrong sensor: ${result.stdout}${result.stderr}`,
  );
}

function withRestoredFiles(paths, attack) {
  const originals = new Map(paths.map((path) => [path, readFileSync(join(fixture, path))]));
  try {
    attack();
  } finally {
    for (const [path, bytes] of originals) writeFileSync(join(fixture, path), bytes);
  }
}

const attacks = [];
try {
  const clone = run("git", ["clone", "--quiet", "--no-hardlinks", root, fixture], scratch);
  assert.equal(clone.status, 0, `clone provenance fixture: ${clone.stdout}${clone.stderr}`);
  copyFileSync(join(root, sensorPath), join(fixture, sensorPath));
  for (const workspacePackage of ["cli", "client", "protocol", "server", "streamfs"]) {
    const source = join(root, "packages", workspacePackage, "dist");
    const target = join(fixture, "packages", workspacePackage, "dist");
    rmSync(target, { force: true, recursive: true });
    cpSync(source, target, { dereference: true, recursive: true });
  }
  for (const workspacePackage of ["client", "server"]) {
    const packageName = `@durable-streams/${workspacePackage}`;
    const source = join(root, "packages", workspacePackage, "node_modules", packageName);
    const target = join(fixture, "packages", workspacePackage, "node_modules", packageName);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { dereference: true, recursive: true });
  }

  assertSensorPasses("baseline exact provenance");

  const externalVerifier = "tools/verify/e1_capstone_external.mjs";
  withRestoredFiles([externalVerifier], () => {
    appendFileSync(join(fixture, externalVerifier), "\n// provenance sensitivity mutation\n");
    assertSensorFails("unlisted frozen verifier mutation", /drifted outside the three/);
  });
  attacks.push("unlisted-frozen-verifier");
  assertSensorPasses("restored verifier");

  withRestoredFiles([provenancePath, manifestPath], () => {
    const provenance = JSON.parse(readFileSync(join(fixture, provenancePath), "utf8"));
    provenance.files.push(structuredClone(provenance.files[0]));
    const provenanceBytes = Buffer.from(`${JSON.stringify(provenance)}\n`);
    writeFileSync(join(fixture, provenancePath), provenanceBytes);
    const manifest = JSON.parse(readFileSync(join(fixture, manifestPath), "utf8"));
    manifest.artifacts["transport-provenance.json"] = digest(provenanceBytes);
    writeFileSync(join(fixture, manifestPath), `${JSON.stringify(manifest)}\n`);
    assertSensorFails("duplicate provenance path mutation", /contains duplicate paths/);
  });
  attacks.push("duplicate-provenance-path");
  assertSensorPasses("restored provenance artifacts");

  withRestoredFiles([manifestPath], () => {
    const manifest = readFileSync(join(fixture, manifestPath), "utf8");
    writeFileSync(join(fixture, manifestPath), `{"schema":999,${manifest.slice(1)}`);
    assertSensorFails("shadowed manifest member mutation", /not the exact canonical base artifact/);
  });
  attacks.push("shadowed-manifest-member");
  assertSensorPasses("restored manifest");

  const rogueEvidence = join(fixture, evidenceRoot, "untracked-rogue.bin");
  writeFileSync(rogueEvidence, Buffer.from([0x00, 0xff, 0x01, 0xfe]));
  try {
    assertSensorFails("untracked binary evidence mutation", /E1 evidence file set changed/);
  } finally {
    rmSync(rogueEvidence, { force: true });
  }
  attacks.push("untracked-binary-evidence");
  assertSensorPasses("restored evidence file set");

  const rogueClosure = join(fixture, "packages/streamfs/src/untracked-closure-input.ts");
  mkdirSync(dirname(rogueClosure), { recursive: true });
  writeFileSync(rogueClosure, "export const provenanceMutation = true;\n");
  try {
    assertSensorFails("untracked closure file mutation", /E1 provenance file set changed/);
  } finally {
    rmSync(rogueClosure, { force: true });
  }
  attacks.push("untracked-closure-file");
  assertSensorPasses("final restored baseline");

  const installedTransportFile = "packages/client/node_modules/@durable-streams/client/LICENSE";
  withRestoredFiles([installedTransportFile], () => {
    appendFileSync(join(fixture, installedTransportFile), "\nprovenance sensitivity mutation\n");
    assertSensorFails(
      "installed transport mutation",
      /@durable-streams\/client\/LICENSE bytes drifted/,
    );
  });
  attacks.push("installed-transport-bytes");
  assertSensorPasses("restored installed transport bytes");

  process.stdout.write(`${JSON.stringify({ attacks, baseline: "green", restored: "green" })}\n`);
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
