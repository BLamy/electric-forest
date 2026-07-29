#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
assert.ok(modulePath, "usage: e2_t09_probe.mjs <platform-index.js>");
const platform = await import(`${pathToFileURL(modulePath).href}?probe=${Date.now()}`);
const base = (value) => ({ type: "repo.write", payload: { value }, ts: value });

let lanes;
try {
  lanes = platform.reduceWriterLanes([
    { ...base(1), payload: { actor: "alice", writer: { v: 1, sub: "alice", seq: 1 } } },
    { ...base(2), payload: { actor: "alice", writer: { v: 1, sub: "alice", seq: 2 } } },
  ]);
} catch (error) {
  console.error("case=lane-replay");
  throw error;
}
assert.deepEqual(lanes, { alice: 2 }, "case=lane-replay");
assert.throws(
  () =>
    platform.reduceWriterLanes([
      { ...base(1), payload: { actor: "mallory", writer: { v: 1, sub: "alice", seq: 1 } } },
    ]),
  platform.WriterLaneCorruptionError,
  "case=actor-writer-parity",
);
assert.equal(
  platform.stampWriterEvent({ ...base(1), payload: { value: 1, actor: "mallory" } }, "alice", 1)
    .payload.actor,
  "alice",
  "case=server-stamp",
);

const records = [];
const dispatcher = new platform.WriterLaneDispatcher({
  async create() {},
  async append(_streamId, event) {
    records.push(event);
  },
  async read() {
    return [...records];
  },
  async *follow() {},
});
await assert.rejects(
  dispatcher.dispatch("s", base(1), "alice", {
    requestedSequence: 1,
    validate: () => {
      throw new Error("application-precondition-stale");
    },
  }),
  /application-precondition-stale/,
  "case=precondition-recheck",
);
assert.equal(records.length, 0, "case=precondition-recheck");

records.push({
  ...base(99),
  payload: {
    value: 99,
    actor: "alice",
    writer: { v: 1, sub: "alice", seq: 1, op: "collision" },
  },
});
await assert.rejects(
  dispatcher.recover("collision", "s", {
    ...base(2),
    payload: { value: 2, actor: "alice" },
  }),
  platform.WriterLaneCorruptionError,
  "case=operation-event-binding",
);
assert.equal(records.length, 1, "case=operation-event-binding");

const corruptRecoveryRecords = [
  {
    ...base(7),
    payload: {
      value: 7,
      actor: "alice",
      writer: { v: 1, sub: "alice", seq: 2, op: "gap-recovery" },
    },
  },
];
const corruptRecoveryDispatcher = new platform.WriterLaneDispatcher({
  async create() {},
  async append(_streamId, event) {
    corruptRecoveryRecords.push(event);
  },
  async read() {
    return [...corruptRecoveryRecords];
  },
  async *follow() {},
});
await assert.rejects(
  corruptRecoveryDispatcher.recover("gap-recovery", "s", {
    ...base(7),
    payload: { value: 7, actor: "alice" },
  }),
  platform.WriterLaneCorruptionError,
  "case=operation-replay-order",
);
assert.equal(corruptRecoveryRecords.length, 1, "case=operation-replay-order");

console.log("E2_T09_PROBE_OK");
