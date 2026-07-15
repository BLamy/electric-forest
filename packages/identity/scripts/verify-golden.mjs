import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, replay } from "../../protocol/dist/src/index.js";
import { emptyView, identityReducer, viewDigest } from "../dist/src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const evidence = join(root, ".eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/evidence");
const golden = join(evidence, "golden-identity.jsonl");
const digestPath = join(evidence, "golden-identity.digest");
const prototypeGolden = join(evidence, "prototype-keys.jsonl");
const prototypeDigestPath = join(evidence, "prototype-keys.digest");
const membershipRevokedDigestPath = join(evidence, "membership-revoked-prefix.digest");
const reducerPath = join(root, "packages/identity/reducer.mjs");
const cliPath = join(root, "packages/cli/dist/src/bin.js");
const summaryPath = join(evidence, "verification-summary.json");
const differentialPath = join(evidence, "differential-transcript.txt");
const purityPath = join(evidence, "purity-transcript.txt");
const propertyTranscriptPath = join(evidence, "ordering-property-transcript.txt");
const updateEvidence = process.argv.includes("--update-evidence");
assert.deepEqual(
  process.argv.slice(2).filter((argument) => argument !== "--update-evidence"),
  [],
  "usage: node packages/identity/scripts/verify-golden.mjs [--update-evidence]",
);

assert.ok(existsSync(golden), "missing committed golden identity log");
assert.ok(existsSync(digestPath), "missing committed golden identity digest");
assert.ok(existsSync(prototypeGolden), "missing committed prototype-key identity log");
assert.ok(existsSync(prototypeDigestPath), "missing committed prototype-key identity digest");
assert.ok(existsSync(membershipRevokedDigestPath), "missing revoked-membership prefix digest");
const expected = readFileSync(digestPath, "utf8").trim();
assert.match(expected, /^[0-9a-f]{64}$/);

function runCli(arguments_, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...arguments_], {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

function requireDigest(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, "", `${label}: unexpected stderr`);
  assert.match(result.stdout, /^[0-9a-f]{64}\n$/);
  return result.stdout.trim();
}

const replayArgs = ["replay", golden, "--digest", "--reducer", reducerPath];
const first = requireDigest(runCli(replayArgs), "first replay process");
const second = requireDigest(
  runCli(replayArgs, {
    cwd: join(root, "packages/identity"),
    env: { LANG: "C", TZ: "Pacific/Kiritimati" },
  }),
  "second replay process",
);
assert.equal(first, second);
assert.equal(first, expected);

const records = readFileSync(golden, "utf8")
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line));
const events = records.map(({ offset: _offset, ...event }) => event);
const protocolDigest = viewDigest(replay(events, identityReducer, emptyView()));
let direct = emptyView();
for (const event of events) direct = identityReducer(direct, event);
const directDigest = viewDigest(direct);
assert.equal(protocolDigest, expected);
assert.equal(directDigest, expected);
const membershipRevokedDigest = viewDigest(
  replay(events.slice(0, 5), identityReducer, emptyView()),
);
const expectedMembershipRevokedDigest = readFileSync(membershipRevokedDigestPath, "utf8").trim();
assert.equal(membershipRevokedDigest, expectedMembershipRevokedDigest);

const expectedPrototypeDigest = readFileSync(prototypeDigestPath, "utf8").trim();
assert.match(expectedPrototypeDigest, /^[0-9a-f]{64}$/);
const prototypeDigest = requireDigest(
  runCli(["replay", prototypeGolden, "--digest", "--reducer", reducerPath]),
  "prototype-key replay process",
);
assert.equal(prototypeDigest, expectedPrototypeDigest);

const sourceRoot = join(root, "packages/identity/src");
const forbidden =
  /Math\.random|\bnew Date\b|Date\.now|performance\.now|hrtime|setTimeout|setInterval|crypto\.(?:getRandomValues|randomUUID|randomBytes)|process\.env|(?:from ["']|require\(["']|import\(["'])(?:node:)?(?:fs|net|http|https|child_process)["'/]?/;
const sourceFiles = readdirSync(sourceRoot)
  .filter((name) => name.endsWith(".ts"))
  .sort();
for (const name of sourceFiles) {
  assert.doesNotMatch(readFileSync(join(sourceRoot, name), "utf8"), forbidden, name);
}

const scratch = mkdtempSync(join(tmpdir(), "eforest-identity-golden-"));
let mutationByte;
let mutatedOffset;
try {
  const issuedIndex = records.findIndex(({ type }) => type === "identity.grant.issued");
  assert.notEqual(issuedIndex, -1);
  const issued = structuredClone(records);
  const issuedPayload = issued[issuedIndex].payload;
  const originalHash = issuedPayload.tokenHash;
  issuedPayload.tokenHash = `${originalHash[0] === "a" ? "c" : "d"}${originalHash.slice(1)}`;
  mutatedOffset = issued[issuedIndex].offset;
  const originalText = readFileSync(golden, "utf8");
  mutationByte = originalText.indexOf(originalHash);
  assert.ok(mutationByte >= 0);
  const mutatedPath = join(scratch, "issued-mutated.jsonl");
  writeFileSync(mutatedPath, `${issued.map((record) => canonicalJson(record)).join("\n")}\n`);
  const mutated = requireDigest(
    runCli(["replay", mutatedPath, "--digest", "--reducer", reducerPath]),
    "issued mutation replay",
  );
  assert.notEqual(mutated, expected);
  const bisect = runCli(["bisect", golden, mutatedPath, "--reducer", reducerPath]);
  assert.equal(bisect.status, 1, `${bisect.stdout}${bisect.stderr}`);
  const bisectResult = JSON.parse(bisect.stdout);
  assert.equal(bisectResult.kind, "divergence");
  assert.equal(bisectResult.bOffset, mutatedOffset);

  const revokedIndex = records.findIndex(({ type }) => type === "identity.grant.revoked");
  assert.notEqual(revokedIndex, -1);
  const revoked = structuredClone(records);
  revoked[revokedIndex].payload.grantId = `${revoked[revokedIndex].payload.grantId}x`;
  const revokedPath = join(scratch, "revoked-mutated.jsonl");
  writeFileSync(revokedPath, `${revoked.map((record) => canonicalJson(record)).join("\n")}\n`);
  const revokedResult = runCli(["replay", revokedPath, "--digest", "--reducer", reducerPath]);
  assert.equal(revokedResult.status, 1);
  assert.match(revokedResult.stderr, /line 9:.*identity\/unknown-grant/);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const propertyCounts = JSON.parse(readFileSync(join(evidence, "ordering-properties.json"), "utf8"));
assert.ok(propertyCounts.validHistories >= 500);
assert.ok(propertyCounts.independentInterleavings >= 500);
assert.ok(propertyCounts.preconditionViolations >= 500);

const summary = `${canonicalJson({
  bisectOffset: mutatedOffset,
  directDigest,
  environmentDigest: second,
  goldenDigest: expected,
  membershipRevokedDigest,
  mutationByte,
  propertyCounts,
  protocolDigest,
  prototypeDigest,
  reducerProcessDigests: [first, second],
  sourceFiles,
})}\n`;
const differential = [
  `cli-process-1=${first}`,
  `cli-process-2=${second}`,
  `protocol-replay=${protocolDigest}`,
  `direct-fold=${directDigest}`,
  `expected=${expected}`,
  `membership-revoked-prefix=${membershipRevokedDigest}`,
  `prototype-keys=${prototypeDigest}`,
  "DIFFERENTIAL OK",
  "",
].join("\n");
const purity = [
  `files=${sourceFiles.join(",")}`,
  "forbidden-patterns=0",
  `default=${first}`,
  `TZ=Pacific/Kiritimati LANG=C cwd=packages/identity=${second}`,
  "PURITY OK",
  "",
].join("\n");
const propertyTranscript = [
  `seed=${propertyCounts.seed}`,
  `valid-histories=${propertyCounts.validHistories} OK`,
  `independent-interleavings=${propertyCounts.independentInterleavings} OK`,
  `precondition-violations=${propertyCounts.preconditionViolations} OK`,
  "ORDERING PROPERTIES OK",
  "",
].join("\n");

if (updateEvidence) {
  writeFileSync(summaryPath, summary, "utf8");
  writeFileSync(differentialPath, differential, "utf8");
  writeFileSync(purityPath, purity, "utf8");
  writeFileSync(propertyTranscriptPath, propertyTranscript, "utf8");
} else {
  assert.equal(readFileSync(summaryPath, "utf8"), summary, "identity verification summary drifted");
  assert.equal(
    readFileSync(differentialPath, "utf8"),
    differential,
    "identity differential transcript drifted",
  );
  assert.equal(readFileSync(purityPath, "utf8"), purity, "identity purity transcript drifted");
  assert.equal(
    readFileSync(propertyTranscriptPath, "utf8"),
    propertyTranscript,
    "identity ordering property transcript drifted",
  );
}

process.stdout.write(summary);
process.stdout.write(
  `MUTATION fixture=golden-identity byte=${mutationByte} digest-mismatch bisect=${mutatedOffset} EXPECTED-FAIL OK\n`,
);
