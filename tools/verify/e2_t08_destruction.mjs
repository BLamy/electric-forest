#!/usr/bin/env node
// E2-T08 bet-4 destruction proof, run against a live child-process server:
// build the golden tree, record the index digest, kill -9 the server, DELETE
// the materialized index entirely through the store's own surface (source
// ns:* logs untouched), corrupt a planted leftover materialization copy, and
// rebuild by replay alone — the rebuilt digest must be byte-identical and the
// corrupt leftover must be provably unread. Then the restart proof: a fresh
// process on a copy of the stream-store directory alone answers all three
// doors identically for every golden identity.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
import {
  OfficialStreamAdapter,
  registryStateDigest,
  replayRegistryStream,
} from "../../packages/platform/dist/src/index.js";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import { keyMaterial, signedToken, SUBJECTS } from "./e2_t08_lib.mjs";

const root = resolve(import.meta.dirname, "../..");
const worker = resolve(root, "tools/verify/e2_t08_server_worker.mjs");
const efBin = resolve(root, "packages/cli/dist/src/bin.js");
const evidencePath = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-destruction.txt",
);
const update = process.argv.includes("--update-evidence");

const scratch = mkdtempSync(join(tmpdir(), "e2-t08-destruction-"));
const dataDir = join(scratch, "store");
const restartDir = join(scratch, "store-copy");
const keyFile = join(scratch, "keys.json");
const lines = ["E2-T08 bet-4 destruction proof"];
let child;
let restarted;

async function startWorker(dir, seed) {
  const flags = seed ? ["--seed"] : [];
  const proc = spawn(process.execPath, [worker, dir, keyFile, ...flags], {
    cwd: root,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const readline = createInterface({ input: proc.stdout });
  const ready = await new Promise((accept, reject) => {
    proc.once("exit", (code) => reject(new Error(`worker exited early: ${code}`)));
    readline.on("line", (line) => {
      if (line.startsWith("E2_T08_READY ")) accept(JSON.parse(line.slice("E2_T08_READY ".length)));
    });
  });
  readline.close();
  return { proc, ...ready };
}

async function doorAnswers(baseUrl) {
  const material = keyMaterial(keyFile);
  const answers = [];
  const identities = [
    ["anonymous", null],
    ["alice", SUBJECTS.alice],
    ["bob", SUBJECTS.bob],
    ["carol", SUBJECTS.carol],
    ["dave", SUBJECTS.dave],
  ];
  for (const [label, sub] of identities) {
    const headers = sub === null ? {} : { authorization: `Bearer ${signedToken(material, sub)}` };
    const doors = ["/registry/public", "/registry/org/acme", "/registry/org/beta"];
    if (sub !== null) doors.push("/registry/me");
    for (const door of doors) {
      const response = await fetch(`${baseUrl}${door}`, { headers });
      answers.push(`${label} ${door} ${response.status} ${await response.text()}`);
    }
  }
  return answers;
}

try {
  child = await startWorker(dataDir, true);
  const streams = new OfficialStreamAdapter({ baseUrl: child.officialUrl });
  const before = await streams.read("__registry__");
  assert.equal(before.length, 11, "seeded tree must materialize 11 derived events");
  const digestBefore = registryStateDigest(replayRegistryStream(before));
  const headBefore = before.at(-1).offset;
  const sourceHeads = {};
  for (const id of ["ns:root", "ns:org:acme", "ns:org:beta"]) {
    const records = await streams.read(id);
    sourceHeads[id] = records.at(-1).offset;
  }
  const answersBefore = await doorAnswers(child.url);
  // Run 2: every golden identity must answer 200 — the seed pass enrolls
  // grants for carol and dave too. Carol (the seeded acme member) is the only
  // identity whose private-repo visibility exercises the E2-T01 membership
  // view, so her filtered listings being among the compared answers is what
  // makes a memory-only membership view detectable across the restart.
  for (const [label, mustContain] of [
    ["carol /registry/org/acme", ['"grove"', '"secret"']],
    ["carol /registry/me", ['"grove"', '"secret"']],
    ["dave /registry/org/acme", ['"entries":[]']],
    ["dave /registry/me", ['"entries":[]']],
  ]) {
    const answer = answersBefore.find((line) => line.startsWith(`${label} `));
    assert.ok(answer !== undefined, `${label} missing from door answers`);
    assert.ok(answer.startsWith(`${label} 200 `), `${label} not 200: ${answer}`);
    for (const needle of mustContain) {
      assert.ok(answer.includes(needle), `${label} answer missing ${needle}: ${answer}`);
    }
  }
  lines.push(
    `pre-deletion state-digest=${digestBefore}`,
    `pre-deletion head-offset=${headBefore}`,
    ...Object.entries(sourceHeads).map(([id, head]) => `source ${id} head=${head}`),
  );

  // Plant a leftover materialization copy that a cache-consulting rebuild
  // could be tempted to read.
  const leftover = join(dataDir, "__registry__.cache.jsonl");
  writeFileSync(leftover, before.map((record) => canonicalJson(record)).join("\n") + "\n");

  // kill -9 the server.
  child.proc.kill("SIGKILL");
  await once(child.proc, "exit");
  lines.push("server killed with SIGKILL");

  // Restart-proof copy is taken BEFORE the index is destroyed: the copy is
  // the stream-store directory alone, nothing else from the old process.
  cpSync(dataDir, restartDir, { recursive: true });

  // Delete the materialized index entirely through the store's own surface.
  const deletionServer = createDurableStreamTestServer({ host: "127.0.0.1", port: 0, dataDir });
  const deletionUrl = await deletionServer.start();
  const deletionStreams = new OfficialStreamAdapter({ baseUrl: deletionUrl });
  assert.equal(await deletionStreams.delete("__registry__"), true, "DELETE __registry__ failed");
  await assert.rejects(deletionStreams.read("__registry__"), "index survived its deletion");
  await deletionServer.stop();
  lines.push("deleted __registry__ via DELETE /streams/__registry__ (read now 404s)");

  // Corrupt one byte of the leftover copy.
  const bytes = readFileSync(leftover);
  const at = Math.floor(bytes.length / 2);
  bytes[at] = bytes[at] ^ 0xff;
  writeFileSync(leftover, bytes);
  lines.push(`corrupted leftover materialization copy at byte ${at}`);

  // Rebuild by replay from the source logs alone, in a separate process.
  const rebuild = spawn(process.execPath, [efBin, "registry", "rebuild", "--data-dir", dataDir], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let rebuildOut = "";
  let rebuildErr = "";
  rebuild.stdout.on("data", (chunk) => (rebuildOut += chunk));
  rebuild.stderr.on("data", (chunk) => (rebuildErr += chunk));
  const [rebuildCode] = await once(rebuild, "exit");
  assert.equal(rebuildCode, 0, `rebuild failed: ${rebuildErr}`);
  const digestAfter = rebuildOut.trim();
  process.stdout.write(`rebuild process: ${rebuildErr}`);
  assert.equal(digestAfter, digestBefore, "rebuilt digest differs from pre-deletion digest");
  const verifyServer = createDurableStreamTestServer({ host: "127.0.0.1", port: 0, dataDir });
  const verifyUrl = await verifyServer.start();
  const rebuilt = await new OfficialStreamAdapter({ baseUrl: verifyUrl }).read("__registry__");
  await verifyServer.stop();
  assert.equal(rebuilt.length, 11);
  assert.equal(rebuilt.at(-1).offset, headBefore, "rebuilt head offset drifted");
  assert.equal(registryStateDigest(replayRegistryStream(rebuilt)), digestBefore);
  lines.push(
    `rebuilt state-digest=${digestAfter} byte-identical=true`,
    `rebuilt head-offset=${rebuilt.at(-1).offset} byte-identical=true`,
    "corrupt-leftover probe: rebuild output unaffected (the leftover was never read)",
  );

  // Restart proof: a fresh process over the stream-store copy alone answers
  // all three doors identically for every golden identity.
  restarted = await startWorker(restartDir, false);
  const answersAfter = await doorAnswers(restarted.url);
  assert.deepEqual(answersAfter, answersBefore, "restarted doors answered differently");
  restarted.proc.kill("SIGKILL");
  await once(restarted.proc, "exit");
  restarted = undefined;
  lines.push(
    `restart-on-stream-store-copy doors-identical=true answers=${answersBefore.length}`,
    ...answersBefore.map((answer) => `  ${answer}`),
  );
  lines.push("E2_T08_DESTRUCTION_OK");
} finally {
  if (child?.proc && child.proc.exitCode === null && child.proc.signalCode === null) {
    child.proc.kill("SIGKILL");
  }
  if (restarted?.proc && restarted.proc.exitCode === null && restarted.proc.signalCode === null) {
    restarted.proc.kill("SIGKILL");
  }
  rmSync(scratch, { recursive: true, force: true });
}

const transcript = lines.join("\n") + "\n";
if (update) {
  writeFileSync(evidencePath, transcript);
  process.stdout.write(`updated ${evidencePath}\n`);
} else {
  assert.equal(readFileSync(evidencePath, "utf8"), transcript, "destruction evidence drifted");
  process.stdout.write("e2_t08_destruction: OK\n");
}
