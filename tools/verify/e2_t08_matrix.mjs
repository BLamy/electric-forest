#!/usr/bin/env node
// E2-T08 visibility matrix: every golden identity × every registry door, over
// real HTTP, snapshot AND live — regenerated on every run and byte-compared
// against the committed evidence transcript (use --update-evidence to bless).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  registryStateDigest,
  replayRegistryStream,
} from "../../packages/platform/dist/src/index.js";
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
  ".eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-visibility-matrix.txt",
);
const expectedPath = resolve(
  root,
  "packages/platform/fixtures/registry/two-orgs-lifecycle/expected.json",
);
const update = process.argv.includes("--update-evidence");

const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
const fixture = await startPlatformFixture({});
const lines = ["E2-T08 visibility matrix — golden (a) two-orgs-lifecycle over real HTTP"];
/** Every opened tail, closed in finally — a failed assertion must never leave
 * an SSE connection holding the platform server open. */
const tails = [];
const openTail = async (url, headers) => {
  const tail = await openSseTail(url, headers);
  tails.push(tail);
  return tail;
};
try {
  await buildLifecycleTree(fixture);
  const records = await fixture.streams.read("__registry__");
  const digest = registryStateDigest(replayRegistryStream(records));
  assert.equal(digest, expected.registry.digest, "live tree digest != committed golden digest");
  lines.push(`registry-state-digest=${digest}`, `asOf=${offsetForOrdinal(10)}`);

  const doorBody = async (path, sub) => {
    const response = await fetch(`${fixture.baseUrl}${path}`, {
      headers: sub === null ? {} : { authorization: `Bearer ${await fixture.token(sub)}` },
    });
    assert.equal(response.status, 200, `${path} for ${sub ?? "anonymous"}`);
    return response.json();
  };
  const identities = [
    ["alice", SUBJECTS.alice],
    ["bob", SUBJECTS.bob],
    ["carol", SUBJECTS.carol],
    ["dave", SUBJECTS.dave],
    ["anonymous", null],
  ];
  lines.push("", "== snapshot matrix (literal entry sets) ==");
  for (const [label, sub] of identities) {
    const expectedDoors = expected.listings[label];
    const publicBody = await doorBody("/registry/public", sub);
    assert.deepEqual(publicBody.entries, expectedDoors.public, `${label} /registry/public`);
    lines.push(`${label} /registry/public ${JSON.stringify(publicBody.entries)}`);
    for (const org of ["acme", "beta"]) {
      const body = await doorBody(`/registry/org/${org}`, sub);
      assert.deepEqual(body.entries, expectedDoors.orgs[org], `${label} /registry/org/${org}`);
      lines.push(`${label} /registry/org/${org} ${JSON.stringify(body.entries)}`);
    }
    if (sub !== null) {
      const body = await doorBody("/registry/me", sub);
      assert.deepEqual(body.entries, expectedDoors.me, `${label} /registry/me`);
      lines.push(`${label} /registry/me ${JSON.stringify(body.entries)}`);
    }
  }

  lines.push("", "== live matrix ==");
  // A private repo creation: the authorized tail receives its frame; the
  // anonymous and non-member tails — connected the whole time, and still
  // connected AFTER the authorized frame arrived (the frozen live-budget
  // window) — receive exactly zero frames.
  const head = offsetForOrdinal(10);
  const authorized = await openTail(`${fixture.baseUrl}/registry/org/acme?live=sse&after=${head}`, {
    authorization: `Bearer ${await fixture.token(SUBJECTS.alice)}`,
  });
  const anonymous = await openTail(
    `${fixture.baseUrl}/registry/org/acme?live=sse&after=${head}`,
    {},
  );
  const nonMember = await openTail(`${fixture.baseUrl}/registry/org/acme?live=sse&after=${head}`, {
    authorization: `Bearer ${await fixture.token(SUBJECTS.dave)}`,
  });
  const creation = await dispatchHttp(
    fixture,
    "ns:org:acme",
    "ns.repo.create",
    { v: 1, name: "vault", project: "web", visibility: "private" },
    12,
    SUBJECTS.alice,
  );
  assert.equal(creation.status, 202);
  await authorized.waitForFrame(1, 2000);
  assert.equal(authorized.frames[0].id, offsetForOrdinal(11));
  assert.deepEqual(anonymous.frames, [], "anonymous tail saw a private creation frame");
  assert.deepEqual(nonMember.frames, [], "non-member tail saw a private creation frame");
  lines.push(
    `private-creation authorized-frames=1 frame-offset=${authorized.frames[0].id}`,
    "private-creation anonymous-frames=0 non-member-frames=0 window=held-until-after-authorized-frame",
  );
  authorized.close();
  anonymous.close();
  nonMember.close();

  // Public→private flip suppression: zero frames to a held-open anonymous
  // tail; the flip frame still reaches the owner.
  const flipHead = offsetForOrdinal(11);
  const ownerTail = await openTail(
    `${fixture.baseUrl}/registry/org/beta?live=sse&after=${flipHead}`,
    { authorization: `Bearer ${await fixture.token(SUBJECTS.bob)}` },
  );
  const anonymousFlip = await openTail(
    `${fixture.baseUrl}/registry/org/beta?live=sse&after=${flipHead}`,
    {},
  );
  const flip = await dispatchHttp(
    fixture,
    "ns:org:beta",
    "ns.repo.set-visibility",
    { v: 1, name: "open", visibility: "private" },
    13,
    SUBJECTS.bob,
  );
  assert.equal(flip.status, 202);
  await ownerTail.waitForFrame(1, 2000);
  assert.equal(ownerTail.frames[0].id, offsetForOrdinal(12));
  assert.deepEqual(
    anonymousFlip.frames,
    [],
    "anonymous tail received a frame for a public->private flip",
  );
  lines.push(
    `flip-public-to-private owner-frames=1 frame-offset=${ownerTail.frames[0].id}`,
    "flip-public-to-private anonymous-frames=0 window=held-until-after-owner-frame",
  );
  ownerTail.close();
  anonymousFlip.close();

  // Fresh anonymous snapshots: after private→public (step 10) edge IS
  // visible; after this public→private flip open is NOT.
  const publicNow = await doorBody("/registry/public", null);
  assert.deepEqual(
    publicNow.entries.map((entry) => `${entry.org}/${entry.repo}`),
    ["beta/edge"],
    "fresh anonymous snapshot after flips",
  );
  lines.push(`post-flip anonymous public=${JSON.stringify(publicNow.entries)}`);
  lines.push("", "E2_T08_MATRIX_OK");
} finally {
  for (const tail of tails) tail.close();
  await fixture.stop();
}

const transcript = lines.join("\n") + "\n";
if (update) {
  writeFileSync(evidencePath, transcript);
  process.stdout.write(`updated ${evidencePath}\n`);
} else {
  assert.equal(
    readFileSync(evidencePath, "utf8"),
    transcript,
    "visibility matrix evidence drifted",
  );
  process.stdout.write("e2_t08_matrix: OK\n");
}
