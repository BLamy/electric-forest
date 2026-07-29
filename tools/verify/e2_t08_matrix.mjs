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
  // The frozen suppression window: an unauthorized tail must stay connected
  // until AT LEAST 2000ms past dispatch-accept (the live budget) and its
  // frame log is re-asserted empty at that instant — a hidden frame delivered
  // late-but-within-budget must land inside the assertion window, not slip
  // past a check pinned to the authorized frame's much earlier arrival.
  const LIVE_BUDGET_MS = 2000;
  const holdWindow = async (acceptedAtMs) => {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, acceptedAtMs + LIVE_BUDGET_MS + 50 - Date.now())),
    );
    const heldMs = Date.now() - acceptedAtMs;
    assert.ok(heldMs >= LIVE_BUDGET_MS, `window held only ${heldMs}ms`);
    return heldMs;
  };
  // A private repo creation: the authorized tail receives its frame; the
  // anonymous and non-member tails — connected the whole time, and still
  // connected AFTER the authorized frame arrived AND until the full frozen
  // budget has elapsed — receive exactly zero frames.
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
  const creationAcceptedAt = Date.now();
  await authorized.waitForFrame(1, 2000);
  assert.equal(authorized.frames[0].id, offsetForOrdinal(11));
  assert.deepEqual(anonymous.frames, [], "anonymous tail saw a private creation frame");
  assert.deepEqual(nonMember.frames, [], "non-member tail saw a private creation frame");
  await holdWindow(creationAcceptedAt);
  // Liveness sensed AT the hold instant (run-3 verdict: a dead tail must not
  // satisfy the suppression clause): the stream is still open and a server
  // heartbeat arrived after dispatch-accept, on every unauthorized tail.
  anonymous.assertAliveSince(creationAcceptedAt, "anonymous tail");
  nonMember.assertAliveSince(creationAcceptedAt, "non-member tail");
  assert.deepEqual(anonymous.frames, [], "anonymous tail leaked within the held 2000ms window");
  assert.deepEqual(nonMember.frames, [], "non-member tail leaked within the held 2000ms window");
  lines.push(
    `private-creation authorized-frames=1 frame-offset=${authorized.frames[0].id}`,
    "private-creation anonymous-frames=0 non-member-frames=0 window-held-past-dispatch-accept-ms>=2000 tails-alive-at-held-instant=heartbeat-sensed",
  );
  // Positive-frame sensor on the SAME held tails (run-3 verdict): a public
  // creation must now deliver a visible frame to the connected anonymous AND
  // non-member SSE tails — a tail a sabotage closed early cannot receive it.
  const publicCreation = await dispatchHttp(
    fixture,
    "ns:org:acme",
    "ns.repo.create",
    { v: 1, name: "commons", project: "web", visibility: "public" },
    13,
    SUBJECTS.alice,
  );
  assert.equal(publicCreation.status, 202);
  await anonymous.waitForFrame(1, 2000);
  await nonMember.waitForFrame(1, 2000);
  await authorized.waitForFrame(2, 2000);
  for (const [label, tail] of [
    ["anonymous", anonymous],
    ["non-member", nonMember],
  ]) {
    assert.equal(tail.frames.length, 1, `${label} tail received exactly the public frame`);
    assert.equal(tail.frames[0].id, offsetForOrdinal(12), `${label} public frame offset`);
    const framePayload = JSON.parse(tail.frames[0].data);
    assert.equal(framePayload.type, "registry.repo-added");
    assert.equal(framePayload.payload.repo, "commons");
  }
  lines.push(
    `public-creation-to-held-tails anonymous-frame-offset=${anonymous.frames[0].id} non-member-frame-offset=${nonMember.frames[0].id} type=registry.repo-added repo=commons`,
  );
  authorized.close();
  anonymous.close();
  nonMember.close();

  // Long-poll CATCH-UP over pre-existing hidden events: with the private
  // creation already ON __registry__, an anonymous and a non-member tail
  // resuming from the beginning (early after, waitMs=0 — only the catch-up
  // call site runs, never the follow loop) must receive exactly the frames
  // whose post-event state is visible to them: repo-added forest (then
  // public), its rename to grove (still public at that point), and the
  // public commons creation above. Every private frame — repo-added secret,
  // repo-added vault, the grove public→private flip — is suppressed; the raw
  // cursor still advances over all of them (frozen: offset metadata is not a
  // leak).
  for (const [label, sub] of [
    ["anonymous", null],
    ["non-member", SUBJECTS.dave],
  ]) {
    const response = await fetch(
      `${fixture.baseUrl}/registry/org/acme?live=long-poll&after=-1&waitMs=0`,
      {
        headers: sub === null ? {} : { authorization: `Bearer ${await fixture.token(sub)}` },
      },
    );
    assert.equal(response.status, 200, `${label} long-poll catch-up`);
    const body = await response.json();
    assert.deepEqual(
      body.frames.map((frame) => [frame.offset, frame.type]),
      [
        [offsetForOrdinal(2), "registry.repo-added"],
        [offsetForOrdinal(8), "registry.repo-renamed"],
        [offsetForOrdinal(12), "registry.repo-added"],
      ],
      `${label} long-poll catch-up leaked hidden frames`,
    );
    const serialized = JSON.stringify(body.frames);
    assert.ok(
      !serialized.includes("secret") && !serialized.includes("vault"),
      `${label} long-poll catch-up leaked hidden frames`,
    );
    assert.equal(body.after, offsetForOrdinal(12), `${label} catch-up cursor`);
    lines.push(
      `${label} long-poll catch-up after=-1 visible-frames=${JSON.stringify(
        body.frames.map((frame) => [frame.offset, frame.type]),
      )} hidden-frames-suppressed=true cursor=${body.after}`,
    );
  }

  // Public→private flip suppression: zero frames to a held-open anonymous
  // tail; the flip frame still reaches the owner.
  const flipHead = offsetForOrdinal(12);
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
    14,
    SUBJECTS.bob,
  );
  assert.equal(flip.status, 202);
  const flipAcceptedAt = Date.now();
  await ownerTail.waitForFrame(1, 2000);
  assert.equal(ownerTail.frames[0].id, offsetForOrdinal(13));
  assert.deepEqual(
    anonymousFlip.frames,
    [],
    "anonymous tail received a frame for a public->private flip",
  );
  await holdWindow(flipAcceptedAt);
  // Liveness sensed at the hold instant, exactly as in the creation half.
  anonymousFlip.assertAliveSince(flipAcceptedAt, "anonymous flip tail");
  assert.deepEqual(anonymousFlip.frames, [], "anonymous tail leaked within the held 2000ms window");
  lines.push(
    `flip-public-to-private owner-frames=1 frame-offset=${ownerTail.frames[0].id}`,
    "flip-public-to-private anonymous-frames=0 window-held-past-dispatch-accept-ms>=2000 tail-alive-at-held-instant=heartbeat-sensed",
  );
  ownerTail.close();
  anonymousFlip.close();

  // Fresh anonymous snapshots: after private→public (step 10) edge IS
  // visible and the live-half public creation lists; after this
  // public→private flip open is NOT.
  const publicNow = await doorBody("/registry/public", null);
  assert.deepEqual(
    publicNow.entries.map((entry) => `${entry.org}/${entry.repo}`),
    ["acme/commons", "beta/edge"],
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
