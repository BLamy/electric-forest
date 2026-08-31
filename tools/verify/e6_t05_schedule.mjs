#!/usr/bin/env node
// E6-T05 mixed local/remote schedule against real servers: two sync clients (one branch
// each), a shared task stream, and a deterministic edit script covering creation,
// remote revision, evidence add/remove, lifecycle log entries, a forged verdict, an
// illegal status edit, a workshop change, a two-client conflict from one base, the
// critic verdict, delete-and-restore, and a measured idle window. Prints a frozen
// summary (offsets, digests, event sequences, journal audits) to stdout and writes both
// provenance journals to --out. Flags:
//   --out <dir>            write journal-a.jsonl / journal-b.jsonl there
//   --origin-filter off    sabotage: run both engines with provenance suppression off
//   --mutate-evidence      sensitivity: flip one byte of the staged evidence bytes
//   --idle-ms <n>          idle window length (default 12000)
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { createDurableStreamTestServer } = await import(
  join(root, "packages/server/dist/src/index.js")
);
const { createDurableJsonStream, readDurableJson } = await import(
  join(root, "packages/client/dist/src/index.js")
);
const { StreamFsRepo } = await import(join(root, "packages/streamfs/dist/src/index.js"));
const { canonicalJson, sha256Hex, stateDigest } = await import(
  join(root, "packages/protocol/dist/src/index.js")
);
const { offsetForOrdinal } = await import(
  join(root, "packages/protocol/dist/src/offset-allocation.js")
);
const {
  FixedWindowRateLimiter,
  OfficialStreamAdapter,
  PlatformGateway,
  createPlatformServer,
  listenPlatformServer,
} = await import(join(root, "packages/platform/dist/src/index.js"));
const {
  auditTaskSyncJournal,
  projectQueue,
  projectTaskFolder,
  queueDigest,
  replayTaskLog,
  serializeTaskSyncJournal,
} = await import(join(root, "packages/tasks/dist/src/index.js"));
const { TaskSyncClient } = await import(join(root, "packages/tasks/dist/io/sync-node.js"));
const { attachmentInitialStateForStream, attachmentReducer, contentBytes, reduceContentEvents } =
  await import(join(root, "packages/evidence/dist/src/index.js"));

const args = process.argv.slice(2);
let outDir;
let originFilter = true;
let mutate = false;
let idleMs = 12_000;
while (args.length > 0) {
  const flag = args.shift();
  if (flag === "--out") outDir = args.shift();
  else if (flag === "--origin-filter") originFilter = args.shift() !== "off";
  else if (flag === "--mutate-evidence") mutate = true;
  else if (flag === "--idle-ms") idleMs = Number(args.shift());
  else {
    console.error(`unknown argument ${flag}`);
    process.exit(2);
  }
}

const ORG = "maple";
const REPO = "loop";
const TASK = "E9-T01";
const FOLDER = "epic-9/E9-T01-folder-sync";
const ROOT_DIR = ".eforest/tasks";
const README_PATH = `${ROOT_DIR}/${FOLDER}/readme.md`;
const TASK_STREAM = `issue:${ORG}/${REPO}/${TASK}`;
const EVIDENCE_STREAM = `evidence:${ORG}/${REPO}/issue/${TASK}`;
const BUILDER = "agent-ash";
const CRITIC = "agent-fern";
const summary = [];
const say = (line) => summary.push(line);

const official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
const officialUrl = await official.start();
const gateway = new PlatformGateway({
  verifier: {
    verifyAuthorization: async (header) => {
      const sub = header?.startsWith("Bearer ") ? header.slice(7) : "";
      if (sub === "") throw new TypeError("missing bearer identity");
      return { sub };
    },
  },
  streams: new OfficialStreamAdapter({ baseUrl: officialUrl }),
  decideAuthorization: (input) => ({
    allowed: true,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: "grant:write",
    streamId: "streamId" in input.target ? input.target.streamId : "",
  }),
  namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
  rateLimiter: new FixedWindowRateLimiter({ max: 1_000_000, windowMs: 3_600_000 }),
});
const server = createPlatformServer((request) => gateway.handle(request));
const gatewayUrl = await listenPlatformServer(server);
await createDurableJsonStream({
  url: `${officialUrl}/streams/${encodeURIComponent(`fs:${ORG}/${REPO}:main:meta`)}`,
});
const main = new StreamFsRepo(officialUrl, fetch, `${ORG}/${REPO}`);
await main.createFile("README.md", new TextEncoder().encode("seed\n"));
await main.createBranch("client-a");
await main.createBranch("client-b");
const repoA = new StreamFsRepo(officialUrl, fetch, `${ORG}/${REPO}`, "client-a");
const repoB = new StreamFsRepo(officialUrl, fetch, `${ORG}/${REPO}`, "client-b");

async function dispatchAs(sub, streamId, event, contentEvent) {
  const response = await fetch(`${gatewayUrl}/api/dispatch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sub}`,
      "content-type": "application/json",
      "x-eforest-dispatch-receipt": "offset",
    },
    body: JSON.stringify({ streamId, event, ...(contentEvent ? { contentEvent } : {}) }),
  });
  const text = await response.text();
  if (response.status !== 202) throw new Error(`${event.type} -> ${response.status} ${text}`);
  return JSON.parse(text);
}

const userFileSeq = { "client-a": 0, "client-b": 0 };
async function userWrite(branch, path, content) {
  const sub = branch === "client-a" ? BUILDER : CRITIC;
  const repo = branch === "client-a" ? repoA : repoB;
  const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  const tree = await repo.tree();
  const meta = repo.metadataStreamId;
  const dirs = new Set(Object.keys(tree.dirs));
  const segments = path.split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const dir = segments.slice(0, depth).join("/");
    if (dirs.has(dir)) continue;
    await dispatchAs(sub, meta, {
      type: "fs.dir.create",
      payload: { v: 2, path: dir },
      ts: Date.now(),
    });
    dirs.add(dir);
  }
  const existing = tree.files[path];
  let contentStreamId;
  let base;
  if (existing === undefined || existing.lastContentOffset === "BASE_NONE") {
    userFileSeq[branch] += 1;
    contentStreamId = `fs:${ORG}/${REPO}:${branch}:file:user-${userFileSeq[branch]}`;
    if (existing === undefined) {
      await dispatchAs(sub, meta, {
        type: "fs.file.create",
        payload: { v: 2, path, contentStreamId },
        ts: Date.now(),
      });
    }
    base = "BASE_NONE";
  } else {
    contentStreamId = existing.contentStreamId;
    base = existing.lastContentOffset;
  }
  await dispatchAs(
    sub,
    meta,
    {
      type: "fs.file.write",
      payload: { v: 2, path, base, contentSha256: sha256Hex(bytes), size: bytes.length },
      ts: Date.now(),
    },
    {
      type: "fs.file.content",
      payload: { v: 2, contentStreamId, contentBase64: bytes.toString("base64") },
      ts: Date.now(),
    },
  );
}
async function userDelete(branch, path) {
  const sub = branch === "client-a" ? BUILDER : CRITIC;
  const repo = branch === "client-a" ? repoA : repoB;
  await dispatchAs(sub, repo.metadataStreamId, {
    type: "fs.file.delete",
    payload: { v: 2, path },
    ts: Date.now(),
  });
}

const warnings = [];
function client(branch, actor) {
  return new TaskSyncClient({
    org: ORG,
    repo: REPO,
    branch,
    actor,
    token: actor,
    gatewayUrl,
    streamServerUrl: officialUrl,
    pollMs: 100,
    originFilter,
    onWarning: (message) => warnings.push(`${branch}: ${message}`),
  });
}
const clientA = client("client-a", BUILDER);
const clientB = client("client-b", CRITIC);
await clientA.start();
await clientB.start();

async function readText(repo, path) {
  try {
    return new TextDecoder().decode(await repo.readFile(path));
  } catch {
    return undefined;
  }
}
async function records(streamId) {
  let raw;
  try {
    raw = await readDurableJson({ url: `${officialUrl}/streams/${encodeURIComponent(streamId)}` });
  } catch {
    return [];
  }
  return raw.map((value, index) => ({
    type: value.type,
    payload: Object.fromEntries(
      Object.entries(value.payload).filter(([key]) => key !== "actor" && key !== "writer"),
    ),
    ts: value.ts,
    offset: offsetForOrdinal(index),
  }));
}
/**
 * Quiescence barrier: both engines settled, every branch record under the root
 * accounted in its journal with a terminal disposition, and two consecutive
 * observations identical (no in-flight projection or artifact write).
 */
async function quiesce(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stable = 0;
  for (;;) {
    await clientA.settle();
    await clientB.settle();
    let accounted = true;
    for (const [syncClient, repo] of [
      [clientA, repoA],
      [clientB, repoB],
    ]) {
      const dump = await repo.rawDump();
      for (const record of dump) {
        const path = record.payload?.path;
        if (typeof path !== "string" || !path.startsWith(ROOT_DIR)) continue;
        const terminal =
          syncClient.journal.has(syncClient.branchStream, record.offset, "ingested") ||
          syncClient.journal.has(syncClient.branchStream, record.offset, "suppressed");
        if (!terminal) accounted = false;
      }
    }
    const observation = canonicalJson({
      a: clientA.journal.state.length,
      b: clientB.journal.state.length,
      headA: (await repoA.rawDump()).at(-1)?.offset ?? "-1",
      headB: (await repoB.rawDump()).at(-1)?.offset ?? "-1",
    });
    if (accounted && observation === previous) {
      stable += 1;
      if (stable >= 2) return;
    } else {
      stable = 0;
    }
    previous = observation;
    if (Date.now() >= deadline) throw new Error("quiesce barrier timed out");
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
}

async function waitFor(predicate, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      console.error(`TIMEOUT ${what}`);
      console.error("warnings:", JSON.stringify(warnings));
      console.error("readmeA:", JSON.stringify(await readText(repoA, README_PATH))?.slice(0, 300));
      console.error("readmeB:", JSON.stringify(await readText(repoB, README_PATH))?.slice(0, 300));
      for (const [name, syncClient] of [
        ["a", clientA],
        ["b", clientB],
      ]) {
        for (const record of syncClient.journal.state.slice(-10)) {
          console.error(
            `J${name}`,
            JSON.stringify({
              d: record.disposition,
              s: record.subject,
              o: record.offset,
              k: record.kinds,
              r: record.reason,
            }),
          );
        }
      }
      throw new Error(`schedule timed out waiting for ${what}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}
async function eventTypes() {
  return (await records(TASK_STREAM)).map((record) => record.type).join(",");
}

const README = (status, context, log) =>
  [
    "---",
    `id: ${TASK}`,
    "epic: 9",
    "title: Folder sync schedule task",
    "priority: 901",
    `status: ${status}`,
    "depends_on: []",
    "estimate: S",
    "capstone: false",
    "---",
    "",
    "## Goal",
    "The folder is the stream.",
    "",
    "## Context",
    context,
    "",
    "## Deliverables",
    "- Bidirectional projection without echo.",
    "",
    "## Acceptance criteria",
    "- [ ] Byte parity across branches and replay.",
    "",
    "## Adversarial verification",
    "1. Race the watchers.",
    "",
    "## Verification log",
    log,
  ].join("\n");

// ---- 1. creation on A (non-canonical frontmatter order) --------------------------
const canonical = README("pending", "Created by A.", "") + "\n";
const nonCanonical = canonical.replace(`id: ${TASK}\nepic: 9`, `epic: 9\nid: ${TASK}`);
await userWrite("client-a", README_PATH, nonCanonical);
await waitFor(async () => (await readText(repoB, README_PATH)) === canonical, "step1 convergence");
await quiesce();
say(`step1-create events=${await eventTypes()}`);
say(`step1-readme-sha256=${sha256Hex(new TextEncoder().encode(canonical))}`);

// ---- 2. remote revision from B ---------------------------------------------------
const revised = canonical.replace("Created by A.", "Created by A; revised by B.");
await userWrite("client-b", README_PATH, revised);
await waitFor(async () => (await readText(repoA, README_PATH)) === revised, "step2 convergence");
await quiesce();
say(`step2-revise events=${await eventTypes()}`);

// ---- 3. binary evidence on A -----------------------------------------------------
const bin = Buffer.from(Array.from({ length: 300 }, (_, index) => (index * 7) % 256));
if (mutate) bin[0] = (bin[0] + 1) % 256;
await userWrite("client-a", `${ROOT_DIR}/${FOLDER}/evidence/run.bin`, bin);
await waitFor(async () => {
  try {
    return (
      sha256Hex(await repoB.readFile(`${ROOT_DIR}/${FOLDER}/evidence/run.bin`)) === sha256Hex(bin)
    );
  } catch {
    return false;
  }
}, "step3 evidence convergence");
await quiesce();
const contentStream = `evidence-content:${ORG}/${REPO}/${sha256Hex(bin)}`;
const contentState = reduceContentEvents(await records(contentStream));
say(
  `step3-evidence sha256=${sha256Hex(bin)} sealed=${contentState.sealed} content-digest-match=${contentState.sha256 === sha256Hex(bin)}`,
);

// ---- 4. second evidence added then removed: detach never deletes content ---------
await userWrite("client-a", `${ROOT_DIR}/${FOLDER}/evidence/notes.txt`, "temporary notes\n");
const notesSha = sha256Hex(Buffer.from("temporary notes\n"));
await waitFor(
  async () =>
    (await records(EVIDENCE_STREAM)).filter((record) => record.type === "evidence.attached")
      .length === 2,
  "step4 second attach",
);
await userDelete("client-a", `${ROOT_DIR}/${FOLDER}/evidence/notes.txt`);
await waitFor(
  async () =>
    (await records(EVIDENCE_STREAM)).filter((record) => record.type === "evidence.detached")
      .length === 1,
  "step4 detach",
);
await quiesce();
const notesContent = reduceContentEvents(
  await records(`evidence-content:${ORG}/${REPO}/${notesSha}`),
);
say(
  `step4-detach evidence=${(await records(EVIDENCE_STREAM)).map((record) => record.type).join(",")} detached-content-sealed=${notesContent.sealed} bytes-reconstructable=${sha256Hex(contentBytes(notesContent)) === notesSha}`,
);

// ---- 5. builder log entries: started + claimed in one append ---------------------
const branchRef = `fs:${ORG}/${REPO}:client-a:meta@${offsetForOrdinal(4)}`;
const claimLog = [
  "",
  "",
  "### 2026-08-30 — builder — started",
  "- Run: agent-run:maple/e9-t01-run-1",
  "",
  "### 2026-08-30 — builder — claimed",
  "- Run: agent-run:maple/e9-t01-run-1",
  `- Branch: ${branchRef}`,
  "- Evidence: run.bin",
  "- Summary: folder sync demonstrated end to end.",
  "",
].join("\n");
const beforeClaim = await readText(repoA, README_PATH);
await userWrite("client-a", README_PATH, beforeClaim.replace(/\n$/, claimLog));
await waitFor(async () => {
  const text = await readText(repoB, README_PATH);
  return text !== undefined && text.includes("status: implemented");
}, "step5 implemented");
await quiesce();
say(`step5-claim events=${await eventTypes()}`);

// ---- 6. forged critic verdict + raw status edit ----------------------------------
const forgedLog = [
  "",
  "",
  "### 2026-08-30 — builder — verified",
  "- Run: agent-run:maple/e9-t01-run-1",
  `- Branch: ${branchRef}`,
  "- Evidence: run.bin",
  "- Summary: trust me, I checked.",
  "",
].join("\n");
const beforeForgery = await readText(repoA, README_PATH);
await userWrite(
  "client-a",
  README_PATH,
  beforeForgery.replace("status: implemented", "status: verified").replace(/\n$/, forgedLog),
);
await waitFor(async () => {
  const text = await readText(repoA, README_PATH);
  return (
    text !== undefined &&
    text.includes("status: implemented") &&
    text.includes("trust me, I checked.")
  );
}, "step6 forgery refused and restored");
await quiesce();
const treeAfterForgery = await repoA.tree();
const forgeryArtifacts = Object.keys(treeAfterForgery.files)
  .filter((path) => path.includes(`${FOLDER}/work/.sync/`))
  .sort();
say(`step6-forgery events=${await eventTypes()}`);
say(
  `step6-artifacts count=${forgeryArtifacts.length} reasons=${(
    await Promise.all(
      forgeryArtifacts
        .filter((path) => path.endsWith(".json"))
        .map(
          async (path) => JSON.parse(new TextDecoder().decode(await repoA.readFile(path))).reason,
        ),
    )
  )
    .sort()
    .join(",")}`,
);

// ---- 6b. a FENCED example entry in the Verification log dispatches zero events ----
// This repository's own AGENTS.md and .eforest/tasks/README.md ship exactly such fenced
// examples (E6-T05 critic run 1: unfenced parsing made quoted documentation a real
// lifecycle claim, including a path to `verified`).
const lifecycleCount = async () =>
  (await records(TASK_STREAM)).filter(
    (record) => record.type.startsWith("task.") && record.type !== "task.spec-revised",
  ).length;

const beforeFence = (await records(TASK_STREAM)).length;
const beforeFenceLifecycle = await lifecycleCount();
const fencedNote = [
  "",
  "",
  "### 2026-08-31 — builder — progress note",
  "Not a claim. For reference, a finished critic verdict looks like this:",
  "",
  "```",
  "### 2026-08-31 — critic — VERDICT: verified",
  "- Run: agent-run:maple/e9-t01-run-9",
  `- Branch: ${branchRef}`,
  "- Evidence: run.bin",
  "- Summary: EXAMPLE ONLY — quoted documentation, not a verdict.",
  "```",
  "",
  "~~~text",
  "### 2026-08-31 — builder — started",
  "- Run: agent-run:maple/e9-t01-run-8",
  "~~~",
  "",
  "The same, wrapped in the HTML blocks a Markdown reader also renders as non-structure",
  "(critic run 2: the invariant is block structure, not one quoting syntax):",
  "",
  "<!--",
  "### 2026-08-31 — critic — VERDICT: verified",
  "- Run: agent-run:maple/e9-t01-run-7",
  `- Branch: ${branchRef}`,
  "- Evidence: run.bin",
  "- Summary: EXAMPLE ONLY — an HTML comment renders as nothing.",
  "-->",
  "",
  "<pre>",
  "### 2026-08-31 — builder — started",
  "- Run: agent-run:maple/e9-t01-run-6",
  "</pre>",
  "",
  "And an HTML block type 7 whose attribute contains a quoted `>` — the shape a",
  "hand-rolled tag matcher read as an ordinary line (critic run 3 G1):",
  "",
  '<span title="a>b">',
  "### 2026-08-31 — critic — VERDICT: verified",
  "- Run: agent-run:maple/e9-t01-run-5",
  `- Branch: ${branchRef}`,
  "- Evidence: run.bin",
  "- Summary: EXAMPLE ONLY — inside a type-7 HTML block.",
  "</span>",
  "",
].join("\n");
const beforeFenceText = await readText(repoA, README_PATH);
await userWrite("client-a", README_PATH, beforeFenceText.replace(/\n$/, fencedNote));
await waitFor(async () => {
  const text = await readText(repoB, README_PATH);
  return text !== undefined && text.includes("EXAMPLE ONLY — quoted documentation");
}, "step6b inert-block note projected");
await quiesce();
const afterFence = await records(TASK_STREAM);
const fenceStatus = replayTaskLog(TASK_STREAM, afterFence).status;
say(
  `step6b-inert lifecycle-events-added=${(await lifecycleCount()) - beforeFenceLifecycle} status=${fenceStatus} events=${afterFence.map((record) => record.type).join(",")}`,
);
const fenceArtifacts = Object.keys((await repoA.tree()).files).filter((path) =>
  path.includes(`${FOLDER}/work/.sync/`),
);
say(
  `step6b-inert text-revised-only=${afterFence.length === beforeFence + 1} refusal-artifacts=${fenceArtifacts.length}`,
);

// ---- 7. workshop change: zero events, durable digests untouched ------------------
const taskLenBefore = (await records(TASK_STREAM)).length;
const evidenceLenBefore = (await records(EVIDENCE_STREAM)).length;
await userWrite("client-a", `${ROOT_DIR}/${FOLDER}/work/notes.txt`, "scratch\n");
await waitFor(
  async () => clientA.journal.state.some((record) => record.kinds.includes("workshop")),
  "step7 workshop accounted",
);
await quiesce();
say(
  `step7-workshop task-events-unchanged=${(await records(TASK_STREAM)).length === taskLenBefore} evidence-events-unchanged=${(await records(EVIDENCE_STREAM)).length === evidenceLenBefore}`,
);

// ---- 8. two clients revising from one base ---------------------------------------
const baseTextA = await readText(repoA, README_PATH);
const baseTextB = await readText(repoB, README_PATH);
if (baseTextA !== baseTextB) throw new Error("branches diverged before the conflict step");
clientB.engine.pause();
await userWrite(
  "client-a",
  README_PATH,
  baseTextA.replace("The folder is the stream.", "The folder is the stream (A wins)."),
);
// A's revision must actually hold the fence (be on the task stream) before B's stale
// edit is staged, so the winner of this race is fixed by the schedule, not by timing.
await waitFor(async () => {
  const last = (await records(TASK_STREAM)).at(-1);
  return last?.type === "task.spec-revised" && String(last.payload.readme).includes("(A wins)");
}, "step8 A accepted on the task stream");
await userWrite(
  "client-b",
  README_PATH,
  baseTextB.replace("The folder is the stream.", "The folder is the stream (B tries)."),
);
clientB.engine.resume();
await waitFor(async () => {
  const text = await readText(repoB, README_PATH);
  return text !== undefined && text.includes("(A wins)");
}, "step8 B converges on the winner");
await quiesce();
const treeB = await repoB.tree();
const conflictFiles = Object.keys(treeB.files)
  .filter((path) => path.includes(`${FOLDER}/work/.sync/conflicts/`))
  .sort();
const retained = conflictFiles.find((path) => path.endsWith(".retained"));
say(`step8-conflict events=${await eventTypes()}`);
say(
  `step8-loser conflict-artifacts=${conflictFiles.length} retained-has-loser-bytes=${retained !== undefined && new TextDecoder().decode(await repoB.readFile(retained)).includes("(B tries)")}`,
);

// ---- 9. the critic verdict from B ------------------------------------------------
const verdictLog = [
  "",
  "",
  "### 2026-08-30 — critic — VERDICT: verified",
  "- Run: agent-run:maple/e9-t01-run-2",
  `- Branch: ${branchRef}`,
  "- Evidence: run.bin",
  "- Summary: interrogated the run; no refutation held.",
  "",
].join("\n");
const beforeVerdict = await readText(repoB, README_PATH);
await userWrite("client-b", README_PATH, beforeVerdict.replace(/\n$/, verdictLog));
await waitFor(async () => {
  const text = await readText(repoA, README_PATH);
  return text !== undefined && text.includes("status: verified");
}, "step9 verified everywhere");
await quiesce();
say(`step9-verified events=${await eventTypes()}`);

// ---- 10. delete the derived folder on B; projection recreates exact bytes --------
const restoreReadme = await readText(repoB, README_PATH);
// Batched folder deletion (readme first) while B's engine is paused: processed as one
// unit, the parse refusal restores everything and no reference is detached.
clientB.engine.pause();
await userDelete("client-b", README_PATH);
await userDelete("client-b", `${ROOT_DIR}/${FOLDER}/evidence/run.bin`);
clientB.engine.resume();
await waitFor(async () => {
  const text = await readText(repoB, README_PATH);
  if (text !== restoreReadme) return false;
  try {
    return (
      sha256Hex(await repoB.readFile(`${ROOT_DIR}/${FOLDER}/evidence/run.bin`)) === sha256Hex(bin)
    );
  } catch {
    return false;
  }
}, "step10 restore");
await quiesce();
say(
  `step10-restore readme-byte-equal=true evidence-byte-equal=true detach-events=${(await records(EVIDENCE_STREAM)).filter((record) => record.type === "evidence.detached").length}`,
);

// ---- 11. measured idle window ----------------------------------------------------
async function heads() {
  // Branch heads vary with poll interleaving (how many intermediate projections B saw);
  // the frozen summary uses their equality across the window, never their raw values.
  const dumpOf = async (repo) => (await repo.rawDump()).at(-1)?.offset ?? "-1";
  return canonicalJson({
    branchA: await dumpOf(repoA),
    branchB: await dumpOf(repoB),
    task: (await records(TASK_STREAM)).at(-1)?.offset ?? "-1",
    evidence: (await records(EVIDENCE_STREAM)).at(-1)?.offset ?? "-1",
  });
}
const journalWriteLines = () =>
  clientA.journal.state.filter(
    (record) => record.disposition === "projected" || record.disposition === "dispatched",
  ).length +
  clientB.journal.state.filter(
    (record) => record.disposition === "projected" || record.disposition === "dispatched",
  ).length;
const headsBefore = await heads();
const writesBefore = journalWriteLines();
const idleStart = Date.now();
await new Promise((resolveWait) => setTimeout(resolveWait, idleMs));
const measuredIdle = Date.now() - idleStart;
const headsAfter = await heads();
const writesAfter = journalWriteLines();
say(`step11-idle window-at-least-ms=${idleMs} measured-ok=${measuredIdle >= idleMs}`);
say(
  `step11-idle heads-frozen=${headsBefore === headsAfter} write-lines-frozen=${writesBefore === writesAfter}`,
);
say(
  `step11-heads task=${(await records(TASK_STREAM)).at(-1)?.offset ?? "-1"} evidence=${(await records(EVIDENCE_STREAM)).at(-1)?.offset ?? "-1"}`,
);

// ---- 12. digests: replay parity, projection parity, queue parity -----------------
const finalRecords = await records(TASK_STREAM);
const state = replayTaskLog(TASK_STREAM, finalRecords);
say(`final-events ${finalRecords.map((record) => record.type).join(",")}`);
say(`final-status ${state.status}`);
say(`task-state-digest ${stateDigest(state)}`);
say(
  `replay-deterministic ${stateDigest(replayTaskLog(TASK_STREAM, finalRecords)) === stateDigest(state)}`,
);
const attachments = (await records(EVIDENCE_STREAM)).reduce(
  attachmentReducer,
  attachmentInitialStateForStream(EVIDENCE_STREAM),
);
const live = attachments.attachments.filter(
  (attachment) => attachment.type === "content" && attachment.detachedAtOffset === undefined,
);
const evidenceSources = [];
for (const attachment of live) {
  evidenceSources.push({
    attachmentId: attachment.attachmentId,
    name: attachment.name,
    sha256: attachment.sha256,
    bytes: contentBytes(reduceContentEvents(await records(attachment.contentStream))),
  });
}
const projection = projectTaskFolder({ state, evidence: evidenceSources });
let projectionParity = true;
for (const file of projection.files) {
  const full = `${ROOT_DIR}/${FOLDER}/${file.path}`;
  const shaA = sha256Hex(await repoA.readFile(full));
  const shaB = sha256Hex(await repoB.readFile(full));
  if (shaA !== sha256Hex(file.bytes) || shaB !== sha256Hex(file.bytes)) projectionParity = false;
}
say(
  `projection-parity files=${projection.files.length} byte-equal-on-both-branches=${projectionParity}`,
);
say(
  `evidence-manifest ${canonicalJson(live.map((attachment) => ({ name: attachment.name, sha256: attachment.sha256 })))}`,
);
const catalogRecords = await records(`repo-issues:${ORG}/${REPO}`);
const sources = {
  catalog: { stream: `repo-issues:${ORG}/${REPO}`, records: catalogRecords },
  tasks: [{ stream: TASK_STREAM, records: finalRecords }],
};
const queueA = projectQueue(sources);
const sourcesReversed = {
  catalog: sources.catalog,
  tasks: [{ stream: TASK_STREAM, records: (await records(TASK_STREAM)).slice() }],
};
say(`queue-digest ${queueDigest(queueA)}`);
say(`queue-decision ${canonicalJson(queueA.decision)}`);
say(
  `queue-independent-replay-equal ${queueDigest(projectQueue(sourcesReversed)) === queueDigest(queueA)}`,
);

// ---- 13. journal audits ----------------------------------------------------------
for (const [name, syncClient, repo] of [
  ["a", clientA, repoA],
  ["b", clientB, repoB],
]) {
  const dump = await repo.rawDump();
  const offsets = dump
    .filter((record) => {
      const path = record.payload?.path;
      return typeof path === "string" && path.startsWith(ROOT_DIR);
    })
    .map((record) => record.offset);
  const audit = auditTaskSyncJournal(syncClient.journal.state, {
    branch: { stream: syncClient.branchStream, offsets },
    streams: [
      { stream: TASK_STREAM, offsets: finalRecords.map((record) => record.offset) },
      {
        stream: EVIDENCE_STREAM,
        offsets: (await records(EVIDENCE_STREAM)).map((record) => record.offset),
      },
    ],
  });
  // own/foreign counts vary with poll interleaving; the frozen fact is the audit result.
  say(`journal-${name} ok=${audit.ok} violations=${audit.violations.length}`);
  console.error(
    `journal-${name} detail own=${audit.own} foreign=${audit.foreign} applied=${audit.applied} dispatched=${audit.dispatched}${audit.violations.length > 0 ? ` violations=${JSON.stringify(audit.violations)}` : ""}`,
  );
}
// Transient long-poll hiccups under host contention are retried on the next tick and
// cannot hide misbehavior (a missed projection reddens the parity/digest/audit lines),
// so they stay out of the frozen summary and go to stderr instead.
const transient = warnings.filter((message) => message.includes("poll error"));
if (transient.length > 0) console.error(`transient poll errors: ${JSON.stringify(transient)}`);
const durable = warnings.filter((message) => !message.includes("poll error"));
const expectedWarnings = durable.filter(
  (message) =>
    message.includes("status/illegal-edit") ||
    message.includes("log/role-kind-mismatch") ||
    message.includes("folder/readme-missing") ||
    message.includes("task/stale-spec"),
);
const unexpectedWarnings = durable.filter((message) => !expectedWarnings.includes(message));
if (unexpectedWarnings.length > 0) {
  console.error(`unexpected warnings: ${JSON.stringify(unexpectedWarnings)}`);
}
say(`warnings expected=${expectedWarnings.length} unexpected=${unexpectedWarnings.length}`);

if (outDir !== undefined) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "journal-a.jsonl"), serializeTaskSyncJournal(clientA.journal.state));
  writeFileSync(join(outDir, "journal-b.jsonl"), serializeTaskSyncJournal(clientB.journal.state));
  // The audit universe, so the verifier can re-audit both journals independently
  // instead of trusting the summary's own audit lines (critic run 1, note c).
  const auditInput = {};
  for (const [name, syncClient, repo] of [
    ["a", clientA, repoA],
    ["b", clientB, repoB],
  ]) {
    const dump = await repo.rawDump();
    auditInput[name] = {
      branch: {
        stream: syncClient.branchStream,
        offsets: dump
          .filter((record) => {
            const path = record.payload?.path;
            return typeof path === "string" && path.startsWith(ROOT_DIR);
          })
          .map((record) => record.offset),
      },
      streams: [
        { stream: TASK_STREAM, offsets: finalRecords.map((record) => record.offset) },
        {
          stream: EVIDENCE_STREAM,
          offsets: (await records(EVIDENCE_STREAM)).map((record) => record.offset),
        },
      ],
    };
  }
  writeFileSync(join(outDir, "audit-input.json"), `${canonicalJson(auditInput)}\n`);
}

await clientA.stop();
await clientB.stop();
await new Promise((resolveClose) => server.close(() => resolveClose()));
await official.stop();
gateway.terminate();
console.log(summary.join("\n"));
