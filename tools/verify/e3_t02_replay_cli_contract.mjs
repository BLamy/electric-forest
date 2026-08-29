#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  buildTrustedReplayEnvironment,
  computeInstalledDependencyClosure,
  replayCliIdentity,
  resolvePinnedReplayCli,
} from "../replay/e3_t02_replay_cli_contract.mjs";

const first = resolvePinnedReplayCli(process.cwd());
const hostile = {
  ...process.env,
  PATH: "/tmp/e3-t02-attacker-bin",
  NODE_OPTIONS: "--require=/tmp/e3-t02-attacker.cjs",
  NODE_PATH: "/tmp/e3-t02-attacker-modules",
  npm_config_node_options: "--import=/tmp/e3-t02-attacker.mjs",
  ELECTRON_RUN_AS_NODE: "1",
  HOME: "/tmp/e3-t02-attacker-home",
  USER: "attacker",
  LOGNAME: "attacker",
};
const second = resolvePinnedReplayCli(process.cwd());
assert.deepEqual(second, first);
assert.equal(first.packageRoot.includes(`replayio@${replayCliIdentity.version}_`), true);
assert.equal(first.binPath.endsWith("/node_modules/replayio/bin.js"), true);
assert.deepEqual(
  {
    target: first.closure.target,
    packages: first.closure.packages,
    files: first.closure.files,
    edges: first.closure.edges,
    missing: first.closure.missing,
    sha256: first.closure.sha256,
  },
  {
    target: replayCliIdentity.target,
    packages: replayCliIdentity.closurePackages,
    files: replayCliIdentity.closureFiles,
    edges: replayCliIdentity.closureEdges,
    missing: replayCliIdentity.closureMissing,
    sha256: replayCliIdentity.closureSha256,
  },
);
const chalk = first.closure.entries.find(
  (entry) => entry.name === "chalk" && entry.version === "4.1.2",
);
assert.ok(chalk);
const alternateAnsiStyles = first.closure.entries.find(
  (entry) => entry.name === "ansi-styles" && entry.version === "6.2.3",
);
assert.ok(alternateAnsiStyles);

const fixtureRoot = mkdtempSync(join(tmpdir(), "e3-t02-replay-closure-"));
cpSync(resolve(first.root, "package.json"), resolve(fixtureRoot, "package.json"));
cpSync(resolve(first.root, "pnpm-lock.yaml"), resolve(fixtureRoot, "pnpm-lock.yaml"));
const clone = spawnSync(
  "/bin/cp",
  ["-cR", resolve(first.root, "node_modules"), resolve(fixtureRoot, "node_modules")],
  { encoding: "utf8" },
);
assert.equal(clone.status, 0, clone.stderr);
const fixtureStore = realpathSync(resolve(fixtureRoot, "node_modules/.pnpm"));
assert.equal(
  computeInstalledDependencyClosure(
    realpathSync(resolve(fixtureRoot, "node_modules/replayio")),
    fixtureStore,
  ).sha256,
  replayCliIdentity.closureSha256,
);

const trustedUploader = resolve(first.root, "tools/replay/e3_t02_trusted_uploader.mjs");
function assertContractRejected(label) {
  assert.throws(() => resolvePinnedReplayCli(fixtureRoot), /dependency closure does not match/);
  const helper = spawnSync(
    process.execPath,
    [
      trustedUploader,
      "--project-root",
      fixtureRoot,
      "--replay-cli-shim",
      realpathSync(resolve(fixtureRoot, "node_modules/.bin/replayio")),
      "--replay-cli-bin",
      realpathSync(resolve(fixtureRoot, "node_modules/replayio/bin.js")),
      "--recording-directory",
      fixtureRoot,
      "--recording-id",
      "00000000-0000-4000-8000-000000000001",
    ],
    {
      cwd: fixtureRoot,
      env: buildTrustedReplayEnvironment(process.env),
      input: "{}",
      encoding: "utf8",
    },
  );
  assert.notEqual(helper.status, 0);
  assert.match(helper.stderr, /dependency closure does not match/);
  process.stdout.write(`${label}: EXPECTED-RED resolver=red helper-preflight=red\n`);
}

function assertMutationRejected(path, label) {
  const original = readFileSync(path);
  appendFileSync(path, " ");
  assertContractRejected(label);
  writeFileSync(path, original);
  assert.equal(resolvePinnedReplayCli(fixtureRoot).closure.sha256, replayCliIdentity.closureSha256);
}

assertMutationRejected(
  resolve(fixtureStore, chalk.storeIdentity, "source/index.js"),
  "transitive-chalk-one-byte-mutation",
);
assertMutationRejected(
  realpathSync(resolve(fixtureRoot, "node_modules/replayio/bin.js")),
  "direct-replayio-one-byte-mutation",
);
const chalkAnsiStylesLink = resolve(
  dirname(resolve(fixtureStore, chalk.storeIdentity)),
  "ansi-styles",
);
const originalAnsiStylesLink = readlinkSync(chalkAnsiStylesLink);
unlinkSync(chalkAnsiStylesLink);
symlinkSync(
  relative(dirname(chalkAnsiStylesLink), resolve(fixtureStore, alternateAnsiStyles.storeIdentity)),
  chalkAnsiStylesLink,
);
assertContractRejected("transitive-edge-rewire");
unlinkSync(chalkAnsiStylesLink);
symlinkSync(originalAnsiStylesLink, chalkAnsiStylesLink);
assert.equal(resolvePinnedReplayCli(fixtureRoot).closure.sha256, replayCliIdentity.closureSha256);

const scrubbed = buildTrustedReplayEnvironment(hostile, "/tmp/e3-t02-recordings");
const identity = userInfo();
assert.equal(scrubbed.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
assert.equal(scrubbed.RECORD_REPLAY_DIRECTORY, "/tmp/e3-t02-recordings");
assert.equal(scrubbed.HOME, identity.homedir);
assert.equal(scrubbed.USER, identity.username);
assert.equal(scrubbed.LOGNAME, identity.username);
for (const injected of [
  "NODE_OPTIONS",
  "NODE_PATH",
  "npm_config_node_options",
  "ELECTRON_RUN_AS_NODE",
]) {
  assert.equal(Object.hasOwn(scrubbed, injected), false);
}
const trustedHelp = spawnSync(process.execPath, [first.binPath, "--help"], {
  cwd: first.root,
  env: scrubbed,
  encoding: "utf8",
});
assert.equal(trustedHelp.status, 0, trustedHelp.stderr);
assert.match(trustedHelp.stdout, /Usage:/);
const result = `E3_T02_REPLAY_CLI_CONTRACT_OK version=${replayCliIdentity.version} target=${replayCliIdentity.target} closure-packages=${String(replayCliIdentity.closurePackages)} closure-files=${String(replayCliIdentity.closureFiles)} closure-edges=${String(replayCliIdentity.closureEdges)} closure-missing=${String(replayCliIdentity.closureMissing)} closure-sha256=${replayCliIdentity.closureSha256} direct-mutation=red transitive-chalk-mutation=red transitive-edge-rewire=red resolver=red helper-preflight=red hostile-path=red hostile-home=red node-injection=red trusted-help=green\n`;
process.stdout.write(result);
const evidenceDirectory = resolve(
  first.root,
  ".eforest/tasks/epic-3-the-canopy/E3-T02b-browser-evidence-hardening/evidence",
);
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(
  resolve(evidenceDirectory, "e3-t02b-replay-cli-contract.txt"),
  `${result}${first.closure.missingEntries
    .map((entry) => `missing=${entry.replaceAll("\0", "|")}\n`)
    .join("")}`,
);
