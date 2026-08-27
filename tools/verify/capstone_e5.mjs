#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "../..");
const task = resolve(root, ".eforest/tasks/epic-5-the-meadow/E5-T13-issue-to-merge");
const evidence = resolve(task, "evidence");
const session = resolve(evidence, "e5-t13-session");
const cli = resolve(root, "packages/cli/dist/src/bin.js");
const browserPath = resolve(evidence, "e5-t13-browser.json");
const { compositeDigest } = await import(
  pathToFileURL(resolve(root, "packages/cli/dist/src/session/replay.js")).href
);

const streams = Object.freeze({
  issue: "issue:maple/reading-room/causal-merge",
  pr: "pr:maple/reading-room/causal-merge",
  branch: "fs:maple/reading-room:feature-causal-merge:meta",
  main: "fs:maple/reading-room:main:meta",
  wiki: "fs:maple/reading-room:wiki:meta",
  evidence: "evidence:maple/reading-room/pr/causal-merge",
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function dumpPath(directory, stream) {
  return resolve(directory, `${encodeURIComponent(stream)}.events.jsonl`);
}

function readDump(directory, stream) {
  return readFileSync(dumpPath(directory, stream), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function exactlyOne(records, predicate, description) {
  const matches = records.filter(predicate);
  assert.equal(matches.length, 1, `${description}: expected one, found ${matches.length}`);
  return matches[0];
}

function payload(record) {
  assert.ok(record?.payload !== null && typeof record?.payload === "object", record?.type);
  return record.payload;
}

function parseReplay(output) {
  const streamsFromReplay = [
    ...output.matchAll(/^SESSION stream=(\S+) role=(\S+) head=(\S+) digest=([a-f0-9]{64}) OK$/gm),
  ].map((match) => ({
    stream: match[1],
    role: match[2],
    head: match[3],
    digest: match[4],
  }));
  const links = Number(/^LINKS resolved=(\d+) unresolved=0 OK$/m.exec(output)?.[1]);
  const digest = /^COMPOSITE digest=([a-f0-9]{64})$/m.exec(output)?.[1];
  assert.equal(streamsFromReplay.length, 7, output);
  assert.equal(links, 4, output);
  assert.match(digest ?? "", /^[a-f0-9]{64}$/, output);
  return { streams: streamsFromReplay, links, digest };
}

function runReplay(directory, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [cli, "replay", "--session", directory], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
  assert.equal(
    result.status,
    expectedStatus,
    `session replay status\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function verifyBrowserArtifact(browser) {
  assert.equal(browser.version, 1);
  assert.equal(browser.livenessBoundMs, 5_000, "liveness bound must be the committed constant");
  assert.equal(browser.contextsDistinct, true);
  assert.notEqual(browser.identities.actor.sub, browser.identities.witness.sub);
  assert.notEqual(browser.identities.actor.email, browser.identities.witness.email);
  assert.deepEqual(
    browser.navigation.map(({ navigations }) => navigations),
    browser.navigation.map(() => 0),
    "witness surfaces navigated",
  );
  assert.deepEqual(
    browser.navigation.map(({ documentRequests }) => documentRequests),
    browser.navigation.map(() => 0),
    "witness surfaces reloaded",
  );
  assert.deepEqual(browser.lifecycle, {
    httpFailures: [],
    consoleAndPageErrors: 0,
    requestFailures: 0,
  });
  assert.equal(browser.dispatches.witness.length, 0, "witness dispatched an action");
  assert.deepEqual(browser.branchRegistrations, {
    actor: [{ name: "feature-causal-merge" }],
    witness: [],
  });
  assert.equal(
    browser.dispatches.actor.filter(({ type }) => type === "pr.merge").length,
    1,
    "actor must issue exactly one pr.merge command",
  );
  assert.equal(
    browser.dispatches.actor.filter(
      ({ streamId, type, payload }) =>
        streamId === streams.issue && type === "issue.state-changed" && payload?.to === "done",
    ).length,
    0,
    "browser actor manually dispatched the merge-driven close",
  );
  const expectedSteps = [
    "issue-filed",
    "issue-in-progress",
    "branch-forked",
    "fix-landed",
    "pr-opened",
    "review-commented",
    "pr-approved",
    "evidence-attached",
    "pr-merged",
    "wiki-edited",
  ];
  assert.deepEqual(
    browser.timeline.map(({ name }) => name),
    expectedSteps,
  );
  for (const [index, step] of browser.timeline.entries()) {
    assert.equal(step.n, index + 1);
    assert.ok(step.actorOffsets.length >= 1, `${step.name} omitted its real dispatch receipt`);
    assert.ok(
      step.witnessedWithinMs <= browser.livenessBoundMs,
      `${step.name} exceeded the committed witness bound`,
    );
    assert.ok(step.surfaces.length >= 1, `${step.name} omitted a witness DOM capture`);
    for (const surface of step.surfaces) {
      assert.notEqual(surface.offset, "-1", `${step.name}/${surface.name} remained before-first`);
      assert.match(surface.digest, /^[a-f0-9]{64}$/);
    }
  }
}

const browserSource = readFileSync(browserPath, "utf8");
assert.equal(browserSource.includes("browser=not-rerun"), false);
const browser = JSON.parse(browserSource);
verifyBrowserArtifact(browser);

const replayRun = runReplay(session);
const replay = parseReplay(replayRun.stdout);
const manifest = readJson(resolve(session, "session.json"));
const expected = readJson(resolve(session, "expected.json"));
assert.equal(manifest.root, streams.pr);
assert.equal(manifest.streams.length, 7);
assert.equal(expected.composite, replay.digest);
assert.equal(expected.links.resolved, replay.links);

const replayByStream = new Map(
  replay.streams.map((entry) => {
    const member = manifest.streams.find(({ stream }) => stream === entry.stream);
    assert.ok(member, `replay emitted undeclared stream ${entry.stream}`);
    return [entry.stream, { ...entry, reducer: member.reducer }];
  }),
);
assert.equal(browser.streams.length, 7);
assert.equal(new Set(browser.streams.map(({ stream }) => stream)).size, 7);
for (const dom of browser.streams) {
  const independent = replayByStream.get(dom.stream);
  assert.ok(independent, `DOM names unknown session stream ${dom.stream}`);
  assert.deepEqual(
    {
      stream: dom.stream,
      role: dom.role,
      reducer: dom.reducer,
      head: dom.head,
      digest: dom.digest,
    },
    independent,
    `DOM/replay mismatch for ${dom.stream}`,
  );
}
const domComposite = compositeDigest({
  streams: browser.streams.map(({ stream, role, reducer, head, digest }) => ({
    stream,
    role,
    reducer,
    head,
    digest,
  })),
  links: { resolved: browser.links.resolved },
});
assert.equal(domComposite, replay.digest, "DOM composite must use and match E5-T12's recipe");
assert.equal(browser.replayComposite, replay.digest);

const contentStream = browser.attachment.contentStream;
assert.match(contentStream, /^evidence-content:maple\/reading-room\/[A-Za-z0-9._~-]+$/);
const requiredActorDispatches = [
  [streams.issue, "issue.opened", 1],
  [streams.issue, "issue.state-changed", 1],
  [streams.branch, "fs.branch.fork", 1],
  [streams.branch, "fs.file.create", 1],
  [streams.branch, "fs.file.patch", 1],
  [streams.main, "fs.dir.create", 1],
  [streams.pr, "pr.opened", 1],
  [streams.pr, "pr.review-comment", 1],
  [streams.pr, "pr.approved", 1],
  [streams.pr, "pr.merge", 1],
  [streams.evidence, "evidence.attached", 1],
  [streams.evidence, "evidence.linked", 1],
  [contentStream, "content.chunk", 1],
  [contentStream, "content.sealed", 1],
  [streams.wiki, "fs.branch.genesis", 1],
  [streams.wiki, "fs.file.create", 1],
  [streams.wiki, "fs.file.patch", 1],
];
for (const [stream, type, count] of requiredActorDispatches) {
  assert.equal(
    browser.dispatches.actor.filter(
      (dispatch) => dispatch.streamId === stream && dispatch.type === type,
    ).length,
    count,
    `actor request inventory ${stream} ${type}`,
  );
}
assert.equal(
  browser.dispatches.actor.filter(({ type }) => type === "pr.merged").length,
  0,
  "pr.merged must be the platform outcome, never a browser request",
);
const dumps = {
  issue: readDump(session, streams.issue),
  pr: readDump(session, streams.pr),
  branch: readDump(session, streams.branch),
  main: readDump(session, streams.main),
  wiki: readDump(session, streams.wiki),
  evidence: readDump(session, streams.evidence),
  content: readDump(session, contentStream),
};

const issueOpened = exactlyOne(dumps.issue, ({ type }) => type === "issue.opened", "filed issue");
const inProgress = exactlyOne(
  dumps.issue,
  (record) => record.type === "issue.state-changed" && payload(record).to === "in-progress",
  "in-progress issue transition",
);
const done = exactlyOne(
  dumps.issue,
  (record) => record.type === "issue.state-changed" && payload(record).to === "done",
  "merge-driven done transition",
);
assert.equal(dumps.issue.filter(({ type }) => type === "issue.closed").length, 0);
assert.ok(dumps.issue.indexOf(issueOpened) < dumps.issue.indexOf(inProgress));

const opened = exactlyOne(dumps.pr, ({ type }) => type === "pr.opened", "opened PR");
const review = exactlyOne(dumps.pr, ({ type }) => type === "pr.review-comment", "review comment");
const approved = exactlyOne(dumps.pr, ({ type }) => type === "pr.approved", "approval");
const merged = exactlyOne(dumps.pr, ({ type }) => type === "pr.merged", "merge outcome");
const linkClosed = exactlyOne(dumps.pr, ({ type }) => type === "pr.link-closed", "close backlink");
assert.equal(
  dumps.pr.filter(({ type }) => type === "pr.merge").length,
  0,
  "command leaked into PR log",
);
assert.deepEqual(payload(opened).closes, [{ entity: "issue", stream: streams.issue }]);
assert.equal(payload(opened).author, browser.identities.actor.email);
assert.equal(payload(review).author, browser.identities.actor.email);
assert.equal(payload(approved).reviewer, browser.identities.actor.email);
assert.ok(dumps.pr.indexOf(opened) < dumps.pr.indexOf(review));
assert.ok(dumps.pr.indexOf(review) < dumps.pr.indexOf(approved));
assert.ok(dumps.pr.indexOf(approved) < dumps.pr.indexOf(merged));
assert.equal(payload(done).via.prStream, streams.pr);
assert.equal(payload(done).via.prMergedOffset, merged.offset);
assert.equal(payload(linkClosed).ref.stream, streams.issue);
assert.equal(payload(linkClosed).issueOffset, done.offset);
assert.equal(browser.merge.offset, merged.offset);
assert.equal(browser.merge.requestedType, "pr.merge");
assert.equal(browser.merge.outcomeType, "pr.merged");

const fork = exactlyOne(dumps.branch, ({ type }) => type === "fs.branch.fork", "real fork");
const fixCreate = exactlyOne(
  dumps.branch,
  (record) => record.type === "fs.file.create" && payload(record).path === "capstone-fix.txt",
  "fix file create",
);
const fixPatch = exactlyOne(
  dumps.branch,
  (record) => record.type === "fs.file.patch" && payload(record).path === "capstone-fix.txt",
  "fix file patch",
);
assert.equal(payload(fork).parentStreamId, streams.main);
assert.equal(dumps.branch[0], fork, "fork directive must begin the native branch");
const forkPoint = dumps.main.findIndex(({ offset }) => offset === payload(fork).forkOffset);
assert.ok(forkPoint >= 0, "fork checkpoint must resolve in main");
assert.equal(payload(fixPatch).base, "BASE_NONE");
assert.ok(dumps.branch.indexOf(fixCreate) < dumps.branch.indexOf(fixPatch));
const targetMerge = exactlyOne(
  dumps.main,
  (record) =>
    record.type === "fs.branch.merge" && payload(record).sourceStreamId === streams.branch,
  "target branch merge",
);
const targetAdvance = exactlyOne(
  dumps.main,
  (record) => record.type === "fs.dir.create" && payload(record).path === "integration-target",
  "non-conflicting target advance",
);
assert.ok(dumps.main.indexOf(targetAdvance) < dumps.main.indexOf(targetMerge));
assert.ok(forkPoint < dumps.main.indexOf(targetAdvance));
assert.equal(payload(targetMerge).forkOffset, payload(fork).forkOffset);
assert.equal(payload(targetMerge).v, 2, "target advance must exercise the replayable merge plan");
assert.equal(payload(merged).targetMergeOffset, targetMerge.offset);
assert.equal(
  payload(merged).resultTreeDigest,
  replayByStream.get(streams.main).digest,
  "merged outcome must name the independently replayed main tree digest",
);

const chunks = dumps.content
  .filter(({ type }) => type === "content.chunk")
  .sort((left, right) => payload(left).seq - payload(right).seq);
assert.ok(chunks.length >= 1);
assert.deepEqual(
  chunks.map((record) => payload(record).seq),
  chunks.map((_, index) => index),
);
const replayedAttachment = Buffer.concat(
  chunks.map((record) => Buffer.from(payload(record).bytes, "base64")),
);
const attachmentDigest = createHash("sha256").update(replayedAttachment).digest("hex");
const sealed = exactlyOne(dumps.content, ({ type }) => type === "content.sealed", "content seal");
const attached = exactlyOne(
  dumps.evidence,
  ({ type }) => type === "evidence.attached",
  "content attachment",
);
const linkedEvidence = exactlyOne(
  dumps.evidence,
  ({ type }) => type === "evidence.linked",
  "Replay evidence reference",
);
assert.equal(payload(sealed).sha256, attachmentDigest);
assert.equal(payload(sealed).size, replayedAttachment.byteLength);
assert.equal(payload(sealed).chunks, chunks.length);
assert.equal(payload(attached).contentStream, contentStream);
assert.equal(payload(attached).sha256, attachmentDigest);
assert.equal(payload(attached).size, replayedAttachment.byteLength);
assert.equal(browser.attachment.sha256, attachmentDigest);
assert.equal(browser.attachment.bytes, replayedAttachment.byteLength);
assert.equal(payload(linkedEvidence).kind, "replay-recording");
assert.equal(payload(linkedEvidence).url, browser.attachment.replayReference);
assert.match(
  payload(linkedEvidence).url,
  /^https:\/\/app\.replay\.io\/recording\/[A-Za-z0-9._~-]+$/,
);

const wikiGenesis = exactlyOne(
  dumps.wiki,
  ({ type }) => type === "fs.branch.genesis",
  "wiki genesis",
);
const wikiCreate = exactlyOne(dumps.wiki, ({ type }) => type === "fs.file.create", "wiki create");
const wikiPatch = exactlyOne(dumps.wiki, ({ type }) => type === "fs.file.patch", "wiki patch");
assert.equal(payload(wikiGenesis).branch, "wiki");
assert.equal(payload(wikiCreate).path, "causal-capstone.md");
assert.equal(payload(wikiPatch).path, "causal-capstone.md");
assert.equal(payload(wikiPatch).base, "BASE_NONE");
assert.ok(dumps.wiki.indexOf(wikiCreate) < dumps.wiki.indexOf(wikiPatch));

const aliases = [
  [streams.issue, "e5-t13-issue-log.jsonl"],
  [streams.pr, "e5-t13-pr-log.jsonl"],
  [streams.branch, "e5-t13-branch-log.jsonl"],
  [streams.main, "e5-t13-main-log.jsonl"],
  [streams.wiki, "e5-t13-wiki-log.jsonl"],
  [streams.evidence, "e5-t13-evidence-stream.jsonl"],
  [contentStream, "e5-t13-content-stream.jsonl"],
];
for (const [stream, name] of aliases) {
  const alias = resolve(evidence, name);
  const bytes = readFileSync(alias);
  assert.deepEqual(
    bytes,
    readFileSync(dumpPath(session, stream)),
    `${name} is not the captured dump`,
  );
  const checksum = readFileSync(`${alias}.sha256`, "utf8").trim().split(/\s+/, 1)[0];
  assert.equal(checksum, createHash("sha256").update(bytes).digest("hex"));
}

const scratch = mkdtempSync(resolve(tmpdir(), "eforest-e5-t13-sensitivity-"));
const sensitivity = [];
try {
  const closeMutation = resolve(scratch, "close-offset");
  cpSync(session, closeMutation, { recursive: true });
  unlinkSync(resolve(closeMutation, "expected.json"));
  const issueMutationPath = dumpPath(closeMutation, streams.issue);
  const issueMutation = readDump(closeMutation, streams.issue);
  const mutatedDone = exactlyOne(
    issueMutation,
    (record) => record.type === "issue.state-changed" && payload(record).to === "done",
    "sensitivity done transition",
  );
  mutatedDone.payload.via.prMergedOffset = "0000000000000000_9999999999999999";
  writeFileSync(
    issueMutationPath,
    `${issueMutation.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const closeFailure = runReplay(closeMutation, 1);
  assert.match(closeFailure.stderr, /session\/unresolved-link/);
  assert.match(closeFailure.stderr, /rule=2/);
  sensitivity.push("CLOSE-OFFSET session/unresolved-link rule=2 EXPECTED-FAIL OK");

  const staleDom = structuredClone(browser);
  staleDom.streams[0].digest = "0".repeat(64);
  const staleComposite = compositeDigest({
    streams: staleDom.streams.map(({ stream, role, reducer, head, digest }) => ({
      stream,
      role,
      reducer,
      head,
      digest,
    })),
    links: { resolved: staleDom.links.resolved },
  });
  assert.notEqual(staleComposite, replay.digest);
  sensitivity.push("DOM-DIGEST composite-mismatch EXPECTED-FAIL OK");

  const reloadMutation = structuredClone(browser);
  reloadMutation.navigation[0].navigations = 1;
  assert.throws(() => verifyBrowserArtifact(reloadMutation), /witness surfaces navigated/);
  sensitivity.push("WITNESS-RELOAD zero-navigation EXPECTED-FAIL OK");

  const closeRequestMutation = structuredClone(browser);
  closeRequestMutation.dispatches.actor.push({
    streamId: streams.issue,
    type: "issue.state-changed",
    payload: { v: 2, to: "done" },
  });
  assert.throws(() => verifyBrowserArtifact(closeRequestMutation), /manually dispatched/);
  sensitivity.push("MANUAL-CLOSE request-provenance EXPECTED-FAIL OK");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const wikiDom = browser.streams.find(({ stream }) => stream === streams.wiki);
assert.ok(wikiDom);
const digestLines = [
  `composite.replay=${replay.digest}`,
  `composite.dom=${domComposite}`,
  ...browser.streams.map(({ stream, head, digest }) => `${stream} head=${head} digest=${digest}`),
  `close.issueOffset=${done.offset}`,
  `close.prMergedOffset=${merged.offset}`,
  `attachment.sha256=${attachmentDigest}`,
  `attachment.contentStream=${contentStream}`,
  `wiki.offset=${wikiPatch.offset}`,
];
writeFileSync(resolve(evidence, "e5-t13-digests.txt"), `${digestLines.join("\n")}\n`);
writeFileSync(
  resolve(evidence, "e5-t13-sensitivity.md"),
  `# E5-T13 causal sensitivity\n\n${sensitivity.map((line) => `- ${line}`).join("\n")}\n`,
);

for (const step of browser.timeline) {
  process.stdout.write(
    `STEP n=${String(step.n)} name=${step.name} offset=${step.actorOffsets.at(-1)} witnessed=${String(step.witnessedWithinMs)}ms bound=${String(browser.livenessBoundMs)}ms OK\n`,
  );
}
process.stdout.write(`COMPOSITE digest=${replay.digest} dom=${domComposite} OK\n`);
process.stdout.write(
  `CLOSE offset=${done.offset} via=${payload(done).via.prMergedOffset} count=1 OK\n`,
);
process.stdout.write(
  `ATTACH sha256=${attachmentDigest} dom=${browser.attachment.sha256} bytes=${String(replayedAttachment.byteLength)} OK\n`,
);
process.stdout.write(`WIKI offset=${wikiPatch.offset} digest=${wikiDom.digest} witnessed OK\n`);
process.stdout.write(
  `FORK parent=${payload(fork).parentStreamId} offset=${payload(fork).forkOffset} main=resolved OK\n`,
);
process.stdout.write(
  `MERGE command=pr.merge outcome=pr.merged target=${targetMerge.offset} digest=${payload(merged).resultTreeDigest} OK\n`,
);
for (const line of sensitivity) process.stdout.write(`${line}\n`);
process.stdout.write(
  "CAUSAL-SENSITIVITY close-offset=red dom-digest=red navigation=red manual-close=red OK\n",
);
process.stdout.write("E5_T13_CAUSAL_CAPSTONE_OK browser=rerun streams=7\n");
