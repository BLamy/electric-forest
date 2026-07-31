#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, OFFSET_BEFORE_FIRST } from "../../packages/protocol/dist/src/index.js";
import { replayWithReducer, requireReducer } from "../../packages/reducers/dist/src/index.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const evidence = resolve(
  root,
  ".eforest/tasks/epic-3-the-canopy/E3-T05-repo-home-branches-status/evidence",
);
const eventText = await readFile(resolve(evidence, "e3-t05-events.json"), "utf8");
const digestText = await readFile(resolve(evidence, "e3-t05-digests.json"), "utf8");
const eventSets = JSON.parse(eventText);
const expected = JSON.parse(digestText);

assert.equal(eventText, `${canonicalJson(eventSets)}\n`, "event evidence is not canonical JSON");
assert.equal(digestText, `${canonicalJson(expected)}\n`, "digest evidence is not canonical JSON");

const reducers = {
  namespace: "repo-namespace",
  branches: "repo-branches",
  status: "repo-status",
};
let checks = 0;
for (const phase of ["initial", "converged"]) {
  for (const region of ["namespace", "branches", "status"]) {
    const events = eventSets[phase]?.[region];
    assert.ok(Array.isArray(events), `${phase}.${region} event dump is absent`);
    const streamId = `repo-home:maple/reading-room:${region}`;
    const replay = replayWithReducer(requireReducer(reducers[region], streamId), events);
    const checkpoint = events.at(-1)?.offset ?? OFFSET_BEFORE_FIRST;
    assert.equal(checkpoint, expected[phase][region].checkpoint, `${phase}.${region} checkpoint`);
    assert.equal(replay.digest, expected[phase][region].digest, `${phase}.${region} digest`);
    checks += 1;
  }
}

process.stdout.write(`E3_T05_INDEPENDENT_REPLAY_OK regions=${checks}\n`);
