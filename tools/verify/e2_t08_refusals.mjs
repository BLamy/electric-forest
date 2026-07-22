#!/usr/bin/env node
// E2-T08 refusal neutrality: the ns/* refusal pairs AND the __registry__
// client-write refusals (dispatch + raw protocol append), each with its
// refusal transcript and before/after dump digests — regenerated live and
// byte-compared against the committed evidence (auditable from the file
// alone). --update-evidence blesses a run.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stateDigest } from "../../packages/protocol/dist/src/index.js";
import { buildLifecycleTree, dispatchHttp, startPlatformFixture, SUBJECTS } from "./e2_t08_lib.mjs";

const root = resolve(import.meta.dirname, "../..");
const evidencePath = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-refusal-neutrality.txt",
);
const update = process.argv.includes("--update-evidence");

const fixture = await startPlatformFixture({});
const lines = [
  "E2-T08 refusal neutrality — every refusal leaves every byte untouched",
  "source-head/dump-digest pairs are recorded before and after each refused attempt",
];
try {
  await buildLifecycleTree(fixture);

  const snapshot = async (streamId) => {
    try {
      const records = await fixture.streams.read(streamId);
      return {
        digest: stateDigest(records),
        head: records.length === 0 ? "-1" : records.at(-1).offset,
        length: records.length,
      };
    } catch {
      return { digest: "absent", head: "-1", length: 0 };
    }
  };

  lines.push("", "== ns/* validator refusals (409 validator-rejected) ==");
  const cases = [
    [
      "ns:org:acme",
      "ns.repo.rename",
      { v: 1, name: "missing", newName: "elsewhere" },
      SUBJECTS.alice,
      "ns/repo-not-found",
    ],
    [
      "ns:org:acme",
      "ns.repo.rename",
      { v: 1, name: "grove", newName: "meadow" },
      SUBJECTS.bob,
      "ns/not-owner",
    ],
    [
      "ns:org:acme",
      "ns.repo.rename",
      { v: 1, name: "grove", newName: "secret" },
      SUBJECTS.alice,
      "ns/name-taken",
    ],
    [
      "ns:org:acme",
      "ns.repo.rename",
      { v: 1, name: "grove", newName: "main" },
      SUBJECTS.alice,
      "ns/reserved-name",
    ],
    [
      "ns:org:acme",
      "ns.repo.rename",
      { v: 1, name: "grove", newName: "Bad--Name" },
      SUBJECTS.alice,
      "ns/invalid-name",
    ],
    [
      "ns:org:acme",
      "ns.repo.set-visibility",
      { v: 1, name: "missing", visibility: "public" },
      SUBJECTS.alice,
      "ns/repo-not-found",
    ],
    [
      "ns:org:acme",
      "ns.repo.set-visibility",
      { v: 1, name: "grove", visibility: "public" },
      SUBJECTS.bob,
      "ns/not-owner",
    ],
  ];
  for (const [streamId, type, payload, sub, reason] of cases) {
    const sourceBefore = await snapshot(streamId);
    const registryBefore = await snapshot("__registry__");
    const response = await dispatchHttp(fixture, streamId, type, payload, 99, sub);
    const body = await response.text();
    assert.equal(response.status, 409, `${reason}: ${body}`);
    assert.deepEqual(JSON.parse(body), { error: { class: "validator-rejected", reason } });
    const sourceAfter = await snapshot(streamId);
    const registryAfter = await snapshot("__registry__");
    assert.deepEqual(sourceAfter, sourceBefore, `${reason} moved ${streamId}`);
    assert.deepEqual(registryAfter, registryBefore, `${reason} moved __registry__`);
    lines.push(
      `${reason} ${type} status=409 body=${body}`,
      `  ${streamId} before head=${sourceBefore.head} digest=${sourceBefore.digest}`,
      `  ${streamId} after  head=${sourceAfter.head} digest=${sourceAfter.digest} identical=true`,
      `  __registry__ before head=${registryBefore.head} digest=${registryBefore.digest}`,
      `  __registry__ after  head=${registryAfter.head} digest=${registryAfter.digest} identical=true`,
    );
  }

  lines.push("", "== __registry__ client writes (server-only clause) ==");
  {
    const before = await snapshot("__registry__");
    const response = await dispatchHttp(
      fixture,
      "__registry__",
      "registry.org-added",
      { v: 1, org: "forged", owner: "auth0|mallory", source: { stream: "x", offset: "0" } },
      1,
      SUBJECTS.alice,
    );
    const body = await response.text();
    assert.equal(response.status, 404, body);
    assert.deepEqual(JSON.parse(body).error.reason, "authz/not-found");
    const after = await snapshot("__registry__");
    assert.deepEqual(after, before, "dispatch to __registry__ moved bytes");
    lines.push(
      `dispatch-to-__registry__ status=404 body=${body}`,
      `  __registry__ before head=${before.head} digest=${before.digest}`,
      `  __registry__ after  head=${after.head} digest=${after.digest} identical=true`,
    );
  }
  {
    const before = await snapshot("__registry__");
    const response = await fetch(
      `${fixture.baseUrl}/streams/${encodeURIComponent("__registry__")}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await fixture.token(SUBJECTS.alice)}`,
        },
        body: JSON.stringify({ type: "registry.org-added", payload: { forged: true }, ts: 1 }),
      },
    );
    const body = await response.text();
    assert.equal(response.status, 404, body);
    assert.deepEqual(JSON.parse(body), { error: { code: "invalid_request", reason: "not_found" } });
    const after = await snapshot("__registry__");
    assert.deepEqual(after, before, "raw protocol append to __registry__ moved bytes");
    lines.push(
      `raw-append-to-__registry__ status=404 body=${body}`,
      `  __registry__ before head=${before.head} digest=${before.digest}`,
      `  __registry__ after  head=${after.head} digest=${after.digest} identical=true`,
      "  note: the platform door exposes no stream protocol; the official store is server-internal",
    );
  }
  lines.push("", "E2_T08_REFUSALS_OK");
} finally {
  await fixture.stop();
}

const transcript = lines.join("\n") + "\n";
if (update) {
  writeFileSync(evidencePath, transcript);
  process.stdout.write(`updated ${evidencePath}\n`);
} else {
  assert.equal(readFileSync(evidencePath, "utf8"), transcript, "refusal evidence drifted");
  process.stdout.write("e2_t08_refusals: OK\n");
}
