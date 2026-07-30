#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import {
  buildTrustedReplayEnvironment,
  computePackageTreeDigest,
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
assert.deepEqual(computePackageTreeDigest(first.packageRoot), {
  files: replayCliIdentity.treeFiles,
  sha256: replayCliIdentity.treeSha256,
});

const copiedPackage = join(mkdtempSync(join(tmpdir(), "e3-t02-replayio-copy-")), "replayio");
cpSync(first.packageRoot, copiedPackage, { recursive: true });
appendFileSync(resolve(copiedPackage, "bin.js"), " ");
assert.notEqual(computePackageTreeDigest(copiedPackage).sha256, replayCliIdentity.treeSha256);

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
const result = `E3_T02_REPLAY_CLI_CONTRACT_OK version=${replayCliIdentity.version} absolute-bin=1 lock-integrity=1 tree-files=${String(replayCliIdentity.treeFiles)} tree-sha256=${replayCliIdentity.treeSha256} one-byte-mutation=red hostile-path=red hostile-home=red node-injection=red trusted-help=green\n`;
process.stdout.write(result);
const evidenceDirectory = resolve(
  first.root,
  ".eforest/tasks/epic-3-the-canopy/E3-T02b-browser-evidence-hardening/evidence",
);
mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(resolve(evidenceDirectory, "e3-t02b-replay-cli-contract.txt"), result);
