#!/usr/bin/env node
// E2-T08 live proof: a dispatched ns.repo.create becomes a derived frame on a
// connected authorized tail within the frozen 2000ms budget, in SSE and
// long-poll modes, cited by __registry__ offset. The measured run must pass on
// every invocation; the committed transcript records one blessed run's
// timestamps and is structurally validated (offsets + budget) when not
// updating.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { offsetForOrdinal } from "../../packages/protocol/dist/src/offset-allocation.js";
import {
  buildLifecycleTree,
  dispatchHttp,
  openSseTail,
  startPlatformFixture,
  SUBJECTS,
} from "./e2_t08_lib.mjs";

const root = resolve(import.meta.dirname, "../..");
const evidencePath = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-live-tail.txt",
);
const update = process.argv.includes("--update-evidence");
const BUDGET_MS = 2000;

const fixture = await startPlatformFixture({});
const lines = ["E2-T08 live tail proof", `budget-ms=${BUDGET_MS}`];
try {
  await buildLifecycleTree(fixture);
  const head = offsetForOrdinal(10);

  // SSE.
  const sseTail = await openSseTail(`${fixture.baseUrl}/registry/org/acme?live=sse&after=${head}`, {
    authorization: `Bearer ${await fixture.token(SUBJECTS.alice)}`,
  });
  const sseDispatchedAt = Date.now();
  const sseAccept = await dispatchHttp(
    fixture,
    "ns:org:acme",
    "ns.repo.create",
    { v: 1, name: "vault", project: "web", visibility: "private" },
    12,
    SUBJECTS.alice,
  );
  assert.equal(sseAccept.status, 202);
  const sseAcceptedAt = Date.now();
  await sseTail.waitForFrame(1, BUDGET_MS);
  const sseFrame = sseTail.frames[0];
  // The frame can land while the accept response is still in flight;
  // measure from dispatch initiation, which strictly precedes accept.
  const sseDelta = sseFrame.atMs - sseDispatchedAt;
  assert.ok(sseDelta < BUDGET_MS, `SSE frame took ${sseDelta}ms`);
  const dump = await fixture.streams.read("__registry__");
  const added = dump.find(
    (record) => record.type === "registry.repo-added" && record.payload.repo === "vault",
  );
  assert.ok(added, "registry.repo-added for vault missing from dump");
  assert.equal(sseFrame.id, added.offset, "SSE frame offset != dump head offset for the event");
  assert.equal(JSON.parse(sseFrame.data).offset, added.offset);
  sseTail.close();
  lines.push(
    `sse dispatch-accept-ms=${sseDispatchedAt} accepted-ms=${sseAcceptedAt} frame-received-ms=${sseFrame.atMs} delta-ms=${sseDelta} frame-offset=${sseFrame.id} dump-offset=${added.offset} offsets-equal=true`,
  );

  // Long-poll.
  const lpHead = offsetForOrdinal(11);
  const aliceToken = await fixture.token(SUBJECTS.alice);
  const waiting = fetch(
    `${fixture.baseUrl}/registry/org/acme?live=long-poll&after=${lpHead}&waitMs=5000`,
    { headers: { authorization: `Bearer ${aliceToken}` } },
  );
  const lpDispatchedAt = Date.now();
  const lpAccept = await dispatchHttp(
    fixture,
    "ns:org:acme",
    "ns.repo.create",
    { v: 1, name: "cellar", project: "web", visibility: "private" },
    13,
    SUBJECTS.alice,
  );
  assert.equal(lpAccept.status, 202);
  const lpAcceptedAt = Date.now();
  const body = await (await waiting).json();
  const lpReceivedAt = Date.now();
  const lpDelta = lpReceivedAt - lpDispatchedAt;
  assert.ok(lpDelta < BUDGET_MS, `long-poll frame took ${lpDelta}ms`);
  assert.equal(body.frames.length, 1);
  assert.equal(body.frames[0].type, "registry.repo-added");
  assert.equal(body.frames[0].offset, offsetForOrdinal(12));
  assert.equal(body.after, offsetForOrdinal(12));
  lines.push(
    `long-poll dispatch-accept-ms=${lpDispatchedAt} accepted-ms=${lpAcceptedAt} frame-received-ms=${lpReceivedAt} delta-ms=${lpDelta} frame-offset=${body.frames[0].offset} cursor=${body.after} offsets-equal=true`,
  );
  lines.push("E2_T08_LIVE_OK");
} finally {
  await fixture.stop();
}

const transcript = lines.join("\n") + "\n";
if (update) {
  writeFileSync(evidencePath, transcript);
  process.stdout.write(`updated ${evidencePath}\n`);
} else {
  // The live run above already re-earned the budget. The committed transcript
  // must exist, cite the same frozen offsets, and record in-budget deltas.
  const committed = readFileSync(evidencePath, "utf8").trim().split("\n");
  assert.equal(committed[0], "E2-T08 live tail proof");
  assert.equal(committed[1], `budget-ms=${BUDGET_MS}`);
  assert.equal(committed.at(-1), "E2_T08_LIVE_OK");
  const sseLine = committed.find((line) => line.startsWith("sse "));
  const lpLine = committed.find((line) => line.startsWith("long-poll "));
  for (const [line, expectedOffset] of [
    [sseLine, offsetForOrdinal(11)],
    [lpLine, offsetForOrdinal(12)],
  ]) {
    assert.ok(line, "committed live transcript is missing a mode line");
    const delta = Number(/delta-ms=(\d+)/.exec(line)?.[1]);
    assert.ok(
      Number.isSafeInteger(delta) && delta < BUDGET_MS,
      `committed delta out of budget: ${line}`,
    );
    assert.match(
      line,
      new RegExp(`frame-offset=${expectedOffset}\\b`),
      `committed offset drifted: ${line}`,
    );
    assert.match(line, / offsets-equal=true$| offsets-equal=true /, line);
  }
  process.stdout.write("e2_t08_live: OK\n");
}
