import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  CONTROL_PATHS,
  addressableLineCount,
  buildWorkQueueSnapshot,
  canonicalTaskPath,
  isSafeRepoPath,
  parseVerificationLedger,
  sha256,
} from "./work-queue-snapshot-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workQueueSource = readFileSync(resolve(root, ".claude/workflows/work-queue.js"), "utf8");
const verifyTaskSource = readFileSync(resolve(root, ".claude/workflows/verify-task.js"), "utf8");
const snapshotLibSource = readFileSync(
  resolve(root, "packages/identity/scripts/work-queue-snapshot-lib.mjs"),
  "utf8",
);
const snapshotCliSource = readFileSync(
  resolve(root, "packages/identity/scripts/work-queue-snapshot.mjs"),
  "utf8",
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const TASK_ID = "E2-T01";
const TASK_PATH = ".eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md";
const ORDINARY_TASK_ID = "E2-T02";
const ORDINARY_TASK_PATH = ".eforest/tasks/epic-2-the-gates/E2-T02-oidc-emulator/readme.md";
const commits = "abcdefghij".split("").map((letter) => letter.repeat(40));
const digest = (letter) => letter.repeat(64);

function compile(source) {
  return new AsyncFunction(
    "agent",
    "workflow",
    "parallel",
    "phase",
    "log",
    "budget",
    "args",
    source.replace("export const meta", "const meta"),
  );
}

function runRecord(run, verdict = "refuted") {
  const heading = `### 2026-07-16 — judge${run === 1 ? "" : ` round ${run}`} — VERDICT: ${verdict}`;
  const entry = `${heading}\n\n- **Finding ${run}.** Prediction and observation with report/path-${run}.md:${run}. Demand: fix.`;
  return {
    run,
    verdict,
    findings: [`**Finding ${run}.** Prediction and observation.`],
    promoted: [`test-${run}`],
    report: entry,
    logEntry: entry,
    entryDigest: digest(String((run % 6) + 1)),
  };
}

function progressFor(taskPath, run) {
  return {
    assessment: "progressing",
    rationale: "Earlier findings closed through a general invariant.",
    evidence: [
      {
        kind: "report",
        ref: `${taskPath}#judge-run-${run}`,
        supports: "The previous counterexample is now rejected while older cases remain green.",
      },
    ],
    nextFocus: ["Exercise the next compositional boundary."],
  };
}

const citedProgress = progressFor(TASK_PATH, 6);

function auditEntry(firstRun, lastRun, progress = citedProgress) {
  return [
    `### 2026-07-16 — progress critic — RUNS ${firstRun}-${lastRun}: progressing`,
    "",
    `- Rationale: ${progress.rationale}`,
    ...progress.evidence.map((item) => `- Evidence (${item.kind}): ${item.ref} — ${item.supports}`),
    ...progress.nextFocus.map((item) => `- Next focus: ${item}`),
    "- Assessment: progressing",
  ].join("\n");
}

function snapshot(count, options = {}) {
  const taskId = options.taskId ?? TASK_ID;
  const taskPath = options.taskPath ?? (taskId === TASK_ID ? TASK_PATH : ORDINARY_TASK_PATH);
  const status = options.status ?? (count === 0 ? "pending" : "refuted");
  const progressAuditedThrough = options.progressAuditedThrough ?? 0;
  const auditStart = options.auditStart ?? (taskId === TASK_ID ? 6 : 3);
  const lastVerdict = options.lastVerdict ?? (status === "verified" ? "verified" : "refuted");
  const allRuns = Array.from({ length: count }, (_, index) =>
    runRecord(index + 1, index + 1 === count ? lastVerdict : "refuted"),
  );
  const firstAuditRun = options.firstAuditRun ?? Math.max(1, progressAuditedThrough - 2);
  const auditEnds =
    progressAuditedThrough === 0
      ? []
      : Array.from(
          { length: (progressAuditedThrough - auditStart) / 3 + 1 },
          (_, index) => auditStart + index * 3,
        );
  const auditEntryDigests =
    options.auditEntryDigests ?? auditEnds.map((value) => digest(String(value)));
  const latestAudit = Object.hasOwn(options, "latestAudit")
    ? options.latestAudit
    : progressAuditedThrough === 0
      ? null
      : {
          firstRun: firstAuditRun,
          lastRun: progressAuditedThrough,
          assessment: "progressing",
          rationale: (options.progress ?? citedProgress).rationale,
          evidence: structuredClone((options.progress ?? citedProgress).evidence),
          nextFocus: structuredClone((options.progress ?? citedProgress).nextFocus),
          entry:
            options.auditEntry ??
            auditEntry(firstAuditRun, progressAuditedThrough, options.progress),
          entryDigest: auditEntryDigests.at(-1),
        };
  const runEntryDigests = options.runEntryDigests ?? allRuns.map((run) => run.entryDigest);
  const ledgerDigest =
    options.ledgerDigest ??
    sha256(
      JSON.stringify({
        runs: allRuns.map((run, index) => [run.run, run.verdict, runEntryDigests[index]]),
        audits: auditEnds.map((lastRun, index) => [lastRun - 2, lastRun, auditEntryDigests[index]]),
      }),
    );
  const evidenceCatalog =
    options.evidenceCatalog ??
    allRuns.slice(-3).flatMap((run) => [
      {
        kind: "report",
        ref: `${taskPath}#judge-run-${run.run}`,
        verifier: "ledger-entry",
        target: run.entryDigest,
      },
      {
        kind: "digest",
        ref: run.entryDigest,
        verifier: "ledger-entry-digest",
        target: `${taskPath}#judge-run-${run.run}`,
      },
    ]);
  return {
    schemaVersion: 2,
    sourceCommit: options.commit ?? commits[0],
    attesterSourceCommit: options.attesterSourceCommit ?? options.commit ?? commits[0],
    attesterDigest: options.attesterDigest ?? digest("b"),
    controlDigest: options.controlDigest ?? digest("c"),
    transitionBaseCommit: options.transitionBaseCommit ?? null,
    changedPaths: options.changedPaths ?? [],
    projectDigest: digest("8"),
    queueDigest: digest("9"),
    taskDigest: digest("a"),
    projectStatus: Object.hasOwn(options, "projectStatus") ? options.projectStatus : "building",
    currentGateTaskId:
      options.currentGateTaskId ??
      (status === "verified" ? (options.nextTaskId ?? "E2-T03") : taskId),
    taskId,
    taskPath,
    status,
    runCeiling: options.runCeiling ?? 10,
    auditStart,
    auditEnds,
    auditEntryDigests,
    progressAuditedThrough,
    runCount: count,
    runEntryDigests,
    ledgerDigest,
    runs: allRuns.slice(-3),
    latestAudit,
    evidenceCatalog,
  };
}

function rewriteRunEntry(value, run, replacementDigest) {
  const rewritten = structuredClone(value);
  rewritten.runEntryDigests[run - 1] = replacementDigest;
  const visible = rewritten.runs.find((entry) => entry.run === run);
  if (visible) {
    visible.entryDigest = replacementDigest;
    visible.findings = [`Rewritten finding ${run}`];
    visible.report = visible.report.replace(`Finding ${run}`, `Rewritten ${run}`);
    visible.logEntry = visible.report;
  }
  rewritten.ledgerDigest = digest("e");
  return rewritten;
}

function verdict(before, after, overrides = {}) {
  return {
    taskId: before.taskId,
    verdict: after.runs.at(-1).verdict,
    baseCommit: before.sourceCommit,
    commitOid: after.sourceCommit,
    findings: [{ kind: "other", citation: "report/path.md:1" }],
    promoted: [],
    report: after.runs.at(-1).report,
    logEntry: after.runs.at(-1).logEntry,
    ...overrides,
  };
}

const serialized = (value) => `${JSON.stringify(value)}\n`;

async function executeWorkQueue(source, options = {}) {
  const runWorkflow = compile(source);
  const defaultInitial = snapshot(0, { status: "pending", commit: commits[0] });
  const defaultImplemented = snapshot(0, { status: "implemented", commit: commits[1] });
  const defaultVerified = snapshot(1, {
    status: "verified",
    lastVerdict: "verified",
    commit: commits[2],
  });
  const suppliedSnapshots = options.readerSnapshots ?? [
    defaultInitial,
    defaultImplemented,
    defaultVerified,
  ];
  let previousSourceCommit = null;
  const readerSnapshots = suppliedSnapshots.map((supplied, index) => {
    const link = (value) => {
      if (!value || options.rawReaderSnapshots) return value;
      if (index === 0) {
        return {
          ...value,
          attesterSourceCommit: value.sourceCommit,
          transitionBaseCommit: null,
          changedPaths: [],
        };
      }
      return {
        ...value,
        attesterSourceCommit: previousSourceCommit,
        transitionBaseCommit: previousSourceCommit,
        changedPaths:
          value.changedPaths.length > 0
            ? value.changedPaths
            : [value.taskPath, ".eforest/tasks/QUEUE.md"].sort(),
      };
    };
    const linked =
      supplied && Object.hasOwn(supplied, "a")
        ? { a: link(supplied.a), b: link(supplied.b) }
        : link(supplied);
    previousSourceCommit = (linked?.a ?? linked)?.sourceCommit ?? previousSourceCommit;
    return linked;
  });
  const verdicts = [...(options.verdicts ?? [verdict(defaultImplemented, defaultVerified)])];
  const progressResults = [...(options.progressResults ?? [])];
  const commitResults = [...(options.commitResults ?? [])];
  const invalidResults = [...(options.invalidResults ?? [])];
  const events = [];
  const logs = [];
  const labels = [];
  const implementArguments = [];
  let readerCalls = 0;

  const agent = async (_prompt, agentOptions) => {
    labels.push(agentOptions.label);
    if (agentOptions.label.startsWith("queue-snapshot:")) {
      const logicalRead = Math.floor(readerCalls / 2);
      const reader = agentOptions.label.endsWith(":a") ? "a" : "b";
      readerCalls += 1;
      const supplied = readerSnapshots[logicalRead];
      if (supplied === undefined) return undefined;
      if (supplied && Object.hasOwn(supplied, "a") && Object.hasOwn(supplied, "b")) {
        return { snapshot: serialized(supplied[reader]) };
      }
      return { snapshot: serialized(supplied) };
    }
    if (agentOptions.label.startsWith("progress-critic:")) {
      events.push("progress");
      return progressResults.shift();
    }
    if (agentOptions.label.startsWith("record-progress-audit:")) {
      events.push("record-progress");
      return commitResults.shift();
    }
    if (agentOptions.label === "flip-invalid-loop") {
      events.push("invalid-loop");
      return invalidResults.shift() ?? { baseCommit: "", commitOid: "" };
    }
    throw new Error(`unexpected agent ${agentOptions.label}`);
  };

  const workflow = async (name, workflowArguments) => {
    if (name === "implement-task") {
      events.push("implement");
      implementArguments.push(workflowArguments);
      return { claimed: true, taskId: workflowArguments.task };
    }
    if (name === "verify-task") {
      events.push("verify");
      return verdicts.shift();
    }
    throw new Error(`unexpected workflow ${name}`);
  };

  const result = await runWorkflow(
    agent,
    workflow,
    async (tasks) => Promise.all(tasks.map((task) => task())),
    () => {},
    (message) => logs.push(message),
    { total: 0, remaining: () => Number.POSITIVE_INFINITY },
    options.args ?? { tasks: 1 },
  );
  return { events, implementArguments, labels, logs, result };
}

async function verifyWorkQueuePolicy(source) {
  let scenarios = 0;

  assert.match(
    source,
    /git show \$\{attesterCommit\}:\$\{SNAPSHOT_SCRIPT\} \| node --input-type=module - --attester/,
  );
  scenarios += 1;

  for (const invalidMaxRuns of [0, -2, 2.5, "3", Number.NaN, 101]) {
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: invalidMaxRuns },
    });
    assert.equal(run.result.refused, "invalid maxRuns");
    assert.deepEqual(run.labels, []);
    scenarios += 1;
  }
  {
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: 11 },
      readerSnapshots: [snapshot(10, { status: "refuted", progressAuditedThrough: 9 })],
    });
    assert.equal(run.result.refused, "maxRuns exceeds committed ceiling");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }
  {
    const run = await executeWorkQueue(source, { args: { tasks: 1, maxRetries: 2 } });
    assert.equal(run.result.refused, "unsupported maxRetries");
    assert.deepEqual(run.labels, []);
    scenarios += 1;
  }

  {
    const a = snapshot(7, {
      status: "in-progress",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: null,
      changedPaths: [],
    });
    const b = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[1],
    });
    const c = snapshot(8, {
      status: "verified",
      lastVerdict: "verified",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[2],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      verdicts: [verdict(b, c)],
    });
    assert.equal(run.result.completed[0].runs, 8);
    assert.equal(run.result.completed[0].verdict, "verified");
    assert.equal(run.implementArguments[0].rework, true);
    assert.match(run.implementArguments[0].report, /Finding 7/);
    scenarios += 1;
  }

  {
    const base = snapshot(0, { status: "pending", commit: commits[0] });
    const other = { ...base, queueDigest: digest("b") };
    const run = await executeWorkQueue(source, { readerSnapshots: [{ a: base, b: other }] });
    assert.equal(run.result.refused, "invalid committed gate snapshot");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  for (const stale of [
    snapshot(4, { taskId: ORDINARY_TASK_ID, status: "refuted", progressAuditedThrough: 0 }),
    snapshot(5, { taskId: ORDINARY_TASK_ID, status: "refuted", progressAuditedThrough: 0 }),
    snapshot(7, { taskId: ORDINARY_TASK_ID, status: "refuted", progressAuditedThrough: 3 }),
    snapshot(8, { taskId: ORDINARY_TASK_ID, status: "refuted", progressAuditedThrough: 3 }),
    snapshot(10, { taskId: ORDINARY_TASK_ID, status: "refuted", progressAuditedThrough: 6 }),
  ]) {
    const run = await executeWorkQueue(source, { readerSnapshots: [stale] });
    assert.equal(run.result.refused, "invalid committed gate snapshot");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  for (const malformed of [
    snapshot(6, { status: "pending", progressAuditedThrough: 6 }),
    snapshot(0, { status: "pending", taskPath: ".eforest/tasks/epic-9/E2-T01-wrong/readme.md" }),
    snapshot(0, { status: "pending", projectStatus: undefined }),
    snapshot(0, {
      status: "pending",
      evidenceCatalog: [
        { kind: "fixture", ref: "AGENTS.md:1", verifier: "git-path", target: "other.md:1" },
      ],
    }),
    snapshot(6, {
      status: "refuted",
      progressAuditedThrough: 6,
      latestAudit: {
        ...snapshot(6, { progressAuditedThrough: 6 }).latestAudit,
        assessment: "death-spiral",
      },
    }),
    snapshot(11, {
      status: "refuted",
      runCeiling: 10,
      progressAuditedThrough: 9,
      firstAuditRun: 7,
    }),
  ]) {
    const run = await executeWorkQueue(source, { readerSnapshots: [malformed] });
    assert.equal(run.result.refused, "invalid committed gate snapshot");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  {
    const ordinaryProgress = progressFor(ORDINARY_TASK_PATH, 3);
    const a = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      commit: commits[0],
    });
    const b = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "in-progress",
      progressAuditedThrough: 3,
      commit: commits[1],
      progress: ordinaryProgress,
    });
    const c = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "implemented",
      progressAuditedThrough: 3,
      commit: commits[2],
      progress: ordinaryProgress,
    });
    const d = snapshot(4, {
      taskId: ORDINARY_TASK_ID,
      status: "verified",
      lastVerdict: "verified",
      progressAuditedThrough: 3,
      commit: commits[3],
      progress: ordinaryProgress,
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c, d],
      progressResults: [structuredClone(ordinaryProgress)],
      commitResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
      verdicts: [verdict(c, d)],
    });
    assert.deepEqual(run.events, ["progress", "record-progress", "implement", "verify"]);
    assert.equal(run.result.completed[0].runs, 4);
    scenarios += 1;
  }

  for (const rejectedProgress of [
    undefined,
    { ...citedProgress, rationale: "" },
    { ...citedProgress, evidence: [] },
    {
      ...citedProgress,
      evidence: [{ kind: "report", ref: "not-a-citation", supports: "Nothing resolvable." }],
    },
    { ...citedProgress, nextFocus: [] },
  ]) {
    const a = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      commit: commits[0],
    });
    const b = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      projectStatus: "invalid_loop",
      commit: commits[1],
      changedPaths: [".eforest/project.json", ".eforest/tasks/QUEUE.md"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b],
      progressResults: [rejectedProgress],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.events.includes("record-progress"), false);
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  {
    const ordinaryProgress = progressFor(ORDINARY_TASK_PATH, 3);
    const a = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      commit: commits[0],
    });
    const b = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "in-progress",
      progressAuditedThrough: 3,
      commit: commits[0],
      progress: ordinaryProgress,
    });
    const c = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      projectStatus: "invalid_loop",
      commit: commits[1],
      changedPaths: [".eforest/project.json", ".eforest/tasks/QUEUE.md"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      progressResults: [structuredClone(ordinaryProgress)],
      commitResults: [{ baseCommit: commits[0], commitOid: commits[0] }],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.deepEqual(run.events, ["progress", "record-progress", "invalid-loop"]);
    scenarios += 1;
  }

  {
    const a = snapshot(0, { status: "implemented", commit: commits[0] });
    const b = snapshot(1, {
      status: "verified",
      lastVerdict: "verified",
      commit: commits[1],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [TASK_PATH, ".eforest/tasks/QUEUE.md"].sort(),
    });
    const c = snapshot(0, {
      status: "implemented",
      projectStatus: "invalid_loop",
      commit: commits[2],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [".eforest/project.json", ".eforest/tasks/QUEUE.md"],
    });
    const run = await executeWorkQueue(source, {
      rawReaderSnapshots: true,
      readerSnapshots: [a, b, c],
      verdicts: [verdict(a, b, { taskId: "E2-T02" })],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[2] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  {
    const a = snapshot(0, { status: "implemented", commit: commits[0] });
    const b = snapshot(0, {
      status: "implemented",
      projectStatus: "invalid_loop",
      commit: commits[1],
      changedPaths: [".eforest/project.json", ".eforest/tasks/QUEUE.md"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, a, b],
      verdicts: [
        verdict(a, snapshot(1, { status: "verified", lastVerdict: "verified" }), {
          baseCommit: commits[0],
          commitOid: commits[0],
        }),
      ],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  {
    const a = snapshot(1, { status: "refuted", commit: commits[0] });
    const b = snapshot(1, { status: "implemented", commit: commits[1] });
    const c = snapshot(2, { status: "refuted", commit: commits[2] });
    const d = snapshot(2, {
      status: "refuted",
      projectStatus: "invalid_loop",
      commit: commits[3],
      changedPaths: [".eforest/project.json", ".eforest/tasks/QUEUE.md"],
    });
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: 2 },
      readerSnapshots: [a, b, c, d],
      verdicts: [verdict(b, c)],
      invalidResults: [{ baseCommit: commits[2], commitOid: commits[3] }],
    });
    assert.equal(run.result.completed[0].runs, 2);
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  for (const finalVerdict of ["refuted", "verified"]) {
    const a = snapshot(9, {
      status: "implemented",
      progressAuditedThrough: 9,
      commit: commits[0],
    });
    const b = snapshot(10, {
      status: finalVerdict === "verified" ? "verified" : "refuted",
      lastVerdict: finalVerdict,
      progressAuditedThrough: 9,
      commit: commits[1],
    });
    const c = snapshot(10, {
      status: "refuted",
      progressAuditedThrough: 9,
      projectStatus: "invalid_loop",
      commit: commits[2],
      changedPaths: [".eforest/project.json", ".eforest/tasks/QUEUE.md"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: finalVerdict === "verified" ? [a, b] : [a, b, c],
      verdicts: [verdict(a, b)],
      ...(finalVerdict === "verified"
        ? {}
        : { invalidResults: [{ baseCommit: commits[1], commitOid: commits[2] }] }),
    });
    assert.equal(run.result.completed[0].runs, 10);
    assert.equal(
      run.result.completed[0].verdict,
      finalVerdict === "verified" ? "verified" : "invalid_loop",
    );
    scenarios += 1;
  }

  {
    const a = snapshot(10, {
      status: "in-progress",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[0],
    });
    const b = snapshot(10, {
      status: "implemented",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[1],
    });
    const c = snapshot(11, {
      status: "verified",
      lastVerdict: "verified",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[2],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      verdicts: [verdict(b, c)],
    });
    assert.deepEqual(run.events, ["implement", "verify"]);
    assert.equal(run.result.completed[0].runs, 11);
    assert.equal(run.result.completed[0].verdict, "verified");
    scenarios += 1;
  }

  {
    const a = snapshot(10, {
      status: "in-progress",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[0],
    });
    const b = snapshot(10, {
      status: "implemented",
      runCeiling: 16,
      progressAuditedThrough: 9,
      commit: commits[1],
    });
    const run = await executeWorkQueue(source, { readerSnapshots: [a, b] });
    assert.deepEqual(run.events, ["implement"]);
    assert.equal(run.result.completed.length, 0);
    scenarios += 1;
  }

  {
    const a = snapshot(11, {
      status: "implemented",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[0],
    });
    const b = snapshot(12, {
      status: "refuted",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[1],
    });
    const c = snapshot(12, {
      status: "refuted",
      runCeiling: 13,
      progressAuditedThrough: 9,
      projectStatus: "invalid_loop",
      commit: commits[2],
      changedPaths: [".eforest/project.json", ".eforest/tasks/QUEUE.md"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      verdicts: [verdict(a, b)],
      progressResults: [undefined],
      invalidResults: [{ baseCommit: commits[1], commitOid: commits[2] }],
    });
    assert.deepEqual(run.events, ["verify", "progress", "invalid-loop"]);
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  {
    const a = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = snapshot(8, {
      status: "refuted",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[1],
    });
    const c = snapshot(8, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[2],
    });
    const d = snapshot(9, {
      status: "verified",
      lastVerdict: "verified",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[3],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c, d],
      verdicts: [verdict(a, b), verdict(c, d)],
    });
    assert.deepEqual(run.events, ["verify", "implement", "verify"]);
    assert.equal(run.result.completed[0].runs, 9);
    assert.equal(run.result.completed[0].verdict, "verified");
    scenarios += 1;
  }

  {
    const deferred = snapshot(7, {
      status: "refuted",
      auditStart: 9,
      progressAuditedThrough: 0,
    });
    const run = await executeWorkQueue(source, { readerSnapshots: [deferred] });
    assert.equal(run.result.refused, "invalid committed gate snapshot");
    assert.equal(run.events.includes("verify"), false);
    scenarios += 1;
  }

  {
    const ordinaryProgress = progressFor(ORDINARY_TASK_PATH, 3);
    const missingProgress = {
      ...ordinaryProgress,
      evidence: [
        {
          kind: "report",
          ref: "definitely/missing/RESULTS.md:999",
          supports: "This path is intentionally absent.",
        },
      ],
    };
    const a = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      commit: commits[0],
    });
    const b = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      projectStatus: "invalid_loop",
      commit: commits[1],
      changedPaths: [".eforest/project.json", ".eforest/tasks/QUEUE.md"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b],
      progressResults: [missingProgress],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.events.includes("record-progress"), false);
    scenarios += 1;
  }

  {
    const a = snapshot(7, {
      status: "in-progress",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = rewriteRunEntry(
      snapshot(7, {
        status: "implemented",
        progressAuditedThrough: 6,
        firstAuditRun: 4,
        commit: commits[0],
      }),
      7,
      digest("f"),
    );
    const run = await executeWorkQueue(source, { readerSnapshots: [a, b] });
    assert.deepEqual(run.events, ["implement"]);
    assert.equal(run.result.completed.length, 0);
    scenarios += 1;
  }

  {
    const a = snapshot(7, {
      status: "in-progress",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[1],
      controlDigest: digest("d"),
    });
    const run = await executeWorkQueue(source, { readerSnapshots: [a, b] });
    assert.deepEqual(run.events, ["implement"]);
    assert.equal(run.result.completed.length, 0);
    scenarios += 1;
  }

  {
    const a = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = rewriteRunEntry(
      snapshot(8, {
        status: "verified",
        lastVerdict: "verified",
        progressAuditedThrough: 6,
        firstAuditRun: 4,
        commit: commits[1],
        attesterSourceCommit: commits[0],
        transitionBaseCommit: commits[0],
        changedPaths: [TASK_PATH, ".eforest/tasks/QUEUE.md"].sort(),
      }),
      7,
      digest("f"),
    );
    const c = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      projectStatus: "invalid_loop",
      commit: commits[2],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [".eforest/project.json", ".eforest/tasks/QUEUE.md"],
    });
    const run = await executeWorkQueue(source, {
      rawReaderSnapshots: true,
      readerSnapshots: [a, b, c],
      verdicts: [verdict(a, b)],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[2] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  for (const corruptAudit of [
    (value) => ({ ...value, controlDigest: digest("d") }),
    (value) => ({ ...value, attesterDigest: digest("d") }),
    (value) => rewriteRunEntry(value, 3, digest("f")),
    (value) => ({
      ...value,
      changedPaths: [value.taskPath, ".eforest/tasks/QUEUE.md", "AGENTS.md"].sort(),
    }),
    (value) => ({
      ...value,
      latestAudit: { ...value.latestAudit, rationale: "A different persisted rationale." },
    }),
    (value) => ({
      ...value,
      latestAudit: {
        ...value.latestAudit,
        evidence: [
          {
            ...value.latestAudit.evidence[0],
            supports: "A different persisted evidence claim.",
          },
        ],
      },
    }),
    (value) => ({
      ...value,
      latestAudit: {
        ...value.latestAudit,
        nextFocus: ["A different persisted next focus."],
      },
    }),
  ]) {
    const progress = progressFor(ORDINARY_TASK_PATH, 3);
    const a = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      commit: commits[0],
    });
    const b = corruptAudit(
      snapshot(3, {
        taskId: ORDINARY_TASK_ID,
        status: "in-progress",
        progressAuditedThrough: 3,
        commit: commits[1],
        progress,
      }),
    );
    const c = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "implemented",
      progressAuditedThrough: 3,
      commit: commits[2],
      progress,
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      progressResults: [structuredClone(progress)],
      commitResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  {
    const progress = progressFor(TASK_PATH, 9);
    const a = snapshot(9, {
      status: "refuted",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = snapshot(9, {
      status: "in-progress",
      progressAuditedThrough: 9,
      firstAuditRun: 7,
      commit: commits[1],
      progress,
      auditEntryDigests: [digest("f"), digest("9")],
      latestAudit: {
        firstRun: 7,
        lastRun: 9,
        assessment: "progressing",
        rationale: progress.rationale,
        evidence: structuredClone(progress.evidence),
        nextFocus: structuredClone(progress.nextFocus),
        entry: auditEntry(7, 9, progress),
        entryDigest: digest("9"),
      },
    });
    const c = snapshot(9, {
      status: "implemented",
      progressAuditedThrough: 9,
      firstAuditRun: 7,
      commit: commits[2],
      progress,
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      progressResults: [structuredClone(progress)],
      commitResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  for (const corruptVerdict of [
    (value) => ({ ...value, controlDigest: digest("d") }),
    (value) => ({ ...value, attesterDigest: digest("d") }),
    (value) => ({
      ...value,
      changedPaths: [value.taskPath, ".eforest/tasks/QUEUE.md", "AGENTS.md"].sort(),
    }),
    (value) => ({
      ...value,
      auditEntryDigests: [digest("f")],
      latestAudit: { ...value.latestAudit, entryDigest: digest("f") },
      ledgerDigest: digest("e"),
    }),
  ]) {
    const a = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = corruptVerdict(
      snapshot(8, {
        status: "verified",
        lastVerdict: "verified",
        progressAuditedThrough: 6,
        firstAuditRun: 4,
        commit: commits[1],
        attesterSourceCommit: commits[0],
        transitionBaseCommit: commits[0],
        changedPaths: [TASK_PATH, ".eforest/tasks/QUEUE.md"].sort(),
      }),
    );
    const c = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      projectStatus: "invalid_loop",
      commit: commits[2],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [".eforest/project.json", ".eforest/tasks/QUEUE.md"],
    });
    const run = await executeWorkQueue(source, {
      rawReaderSnapshots: true,
      readerSnapshots: [a, b, c],
      verdicts: [verdict(a, b)],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[2] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  for (const mismatch of ["log-entry", "verdict-value", "status"]) {
    const a = snapshot(1, { status: "implemented", commit: commits[0] });
    const b = snapshot(2, {
      status: mismatch === "status" ? "in-progress" : "refuted",
      commit: commits[1],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [TASK_PATH, ".eforest/tasks/QUEUE.md"].sort(),
    });
    const claim = verdict(a, b, {
      ...(mismatch === "log-entry" ? { logEntry: "different persisted report" } : {}),
      ...(mismatch === "verdict-value" ? { verdict: "needs-evidence" } : {}),
    });
    const c = snapshot(1, {
      status: "implemented",
      projectStatus: "invalid_loop",
      commit: commits[2],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [".eforest/project.json", ".eforest/tasks/QUEUE.md"],
    });
    const run = await executeWorkQueue(source, {
      rawReaderSnapshots: true,
      readerSnapshots: [a, b, c],
      verdicts: [claim],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[2] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  for (const changedPaths of [
    [".eforest/tasks/QUEUE.md"],
    [".eforest/project.json", ".eforest/tasks/QUEUE.md", TASK_PATH].sort(),
  ]) {
    const a = snapshot(7, {
      status: "in-progress",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[1],
      changedPaths,
    });
    const c = snapshot(8, {
      status: "verified",
      lastVerdict: "verified",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[2],
    });
    const run = await executeWorkQueue(source, { readerSnapshots: [a, b, c] });
    assert.equal(run.events.includes("verify"), false);
    scenarios += 1;
  }

  for (const invalidCase of ["valid", "extra-path", "control", "ledger", "observed-commit"]) {
    const a = snapshot(1, { status: "implemented", commit: commits[0] });
    const b = snapshot(2, { status: "refuted", commit: commits[1] });
    const invalidPaths = [".eforest/project.json", ".eforest/tasks/QUEUE.md"];
    if (invalidCase === "extra-path") invalidPaths.push("AGENTS.md");
    let c = snapshot(2, {
      status: "refuted",
      projectStatus: "invalid_loop",
      commit: commits[2],
      changedPaths: invalidPaths.sort(),
      ...(invalidCase === "control" ? { controlDigest: digest("d") } : {}),
    });
    if (invalidCase === "ledger") c = rewriteRunEntry(c, 1, digest("f"));
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: 2 },
      readerSnapshots: [a, b, c],
      verdicts: [verdict(a, b)],
      invalidResults: [
        {
          baseCommit: invalidCase === "observed-commit" ? commits[0] : commits[1],
          commitOid: commits[2],
        },
      ],
    });
    if (invalidCase === "valid") {
      assert.equal(run.result.completed[0].verdict, "invalid_loop");
      assert.equal(run.result.refused, undefined);
    } else {
      assert.equal(run.result.completed.length, 0);
      assert.equal(run.result.refused, "invalid_loop persistence unconfirmed");
      assert.equal(
        run.logs.some((message) =>
          message.includes("persistence could not be independently attested"),
        ),
        true,
      );
    }
    scenarios += 1;
  }

  return scenarios;
}

function fixtureQueue(
  taskId = TASK_ID,
  path = "epic-2-the-gates/E2-T01-identity-event-model/readme.md",
) {
  return `# queue\n\n## Current gate\n\n1. **${taskId}** — task\n\n## Epic 2\n\n- [?] [${taskId}](${path})\n`;
}

function fixtureReadme(count, { id = TASK_ID, status = "refuted", audit, runCeiling } = {}) {
  const verdicts = Array.from({ length: count }, (_, index) => index + 1)
    .reverse()
    .map((run) => runRecord(run).logEntry)
    .join("\n\n");
  const auditText = audit ? `${auditEntry(audit - 2, audit)}\n\n` : "";
  const migration = id === TASK_ID ? "progress_audit_start: 6\n" : "";
  const ceiling = runCeiling === undefined ? "" : `verification_run_ceiling: ${runCeiling}\n`;
  return `---\nid: ${id}\nstatus: ${status}\n${migration}${ceiling}---\n\n## Verification log\n\n${auditText}${verdicts}\n`;
}

async function verifyParserPolicy(module) {
  let scenarios = 0;
  assert.equal(module.addressableLineCount(""), 0);
  assert.equal(module.addressableLineCount("one"), 1);
  assert.equal(module.addressableLineCount("one\n"), 1);
  assert.equal(module.addressableLineCount("one\n\n"), 2);
  scenarios += 1;

  assert.equal(module.isSafeRepoPath("AGENTS.md"), true);
  assert.equal(module.isSafeRepoPath("evidence/foo..bar.md"), true);
  assert.equal(module.isSafeRepoPath("../AGENTS.md"), false);
  assert.equal(module.isSafeRepoPath("evidence/../AGENTS.md"), false);
  assert.equal(module.isSafeRepoPath("/AGENTS.md"), false);
  assert.equal(module.isSafeRepoPath("evidence//file.md"), false);
  scenarios += 1;
  assert.deepEqual(
    [
      "AGENTS.md",
      ".eforest/loop.md",
      ".claude/workflows/implement-task.js",
      ".claude/workflows/work-queue.js",
      ".claude/workflows/verify-task.js",
      "tools/build_queue.py",
    ].every((path) => module.CONTROL_PATHS.includes(path)),
    true,
  );
  scenarios += 1;
  const projectText = '{"status":"building"}\n';
  const queueText = fixtureQueue();
  const readmeText = fixtureReadme(3, { status: "refuted" });
  const parsed = module.buildWorkQueueSnapshot({
    projectText,
    queueText,
    readmeText,
    sourceCommit: commits[0],
    attesterSourceCommit: commits[0],
    attesterDigest: digest("b"),
    controlDigest: digest("c"),
    resolvePath: () => true,
    commitExists: () => true,
  });
  assert.equal(parsed.taskId, TASK_ID);
  assert.equal(parsed.taskPath, TASK_PATH);
  assert.equal(parsed.runCount, 3);
  assert.equal(parsed.runCeiling, 10);
  assert.equal(parsed.progressAuditedThrough, 0);
  scenarios += 1;

  const resumed = module.buildWorkQueueSnapshot({
    projectText,
    queueText,
    readmeText: fixtureReadme(3, { status: "in-progress", runCeiling: 13 }),
    sourceCommit: commits[0],
    attesterSourceCommit: commits[0],
    attesterDigest: digest("b"),
    controlDigest: digest("c"),
    resolvePath: () => true,
    commitExists: () => true,
  });
  assert.equal(resumed.runCeiling, 13);
  assert.equal(resumed.runCount, 3);
  for (const invalidCeiling of [9, 11, 14, 101, "three"]) {
    assert.throws(() =>
      module.buildWorkQueueSnapshot({
        projectText,
        queueText,
        readmeText: fixtureReadme(3, { runCeiling: invalidCeiling }),
        sourceCommit: commits[0],
        attesterSourceCommit: commits[0],
        attesterDigest: digest("b"),
        controlDigest: digest("c"),
      }),
    );
  }
  assert.throws(() =>
    module.buildWorkQueueSnapshot({
      projectText,
      queueText,
      readmeText: fixtureReadme(11),
      sourceCommit: commits[0],
      attesterSourceCommit: commits[0],
      attesterDigest: digest("b"),
      controlDigest: digest("c"),
    }),
  );
  scenarios += 1;

  assert.throws(() =>
    module.buildWorkQueueSnapshot({
      projectText,
      queueText,
      readmeText: fixtureReadme(3, { id: "E2-T02" }).replace(
        "status: refuted\n",
        "status: refuted\nprogress_audit_start: 6\n",
      ),
      sourceCommit: commits[0],
      attesterSourceCommit: commits[0],
      attesterDigest: digest("b"),
      controlDigest: digest("c"),
    }),
  );
  scenarios += 1;

  const skipped = fixtureReadme(3).replace(runRecord(2).logEntry, "");
  assert.throws(() => module.parseVerificationLedger(skipped, { taskId: TASK_ID, auditStart: 6 }));
  scenarios += 1;

  assert.throws(() =>
    module.canonicalTaskPath(fixtureQueue(TASK_ID, "epic-9/E2-T01-wrong/readme.md"), TASK_ID),
  );
  scenarios += 1;

  const badAudit = `${fixtureReadme(3)}\n${auditEntry(1, 3, progressFor(TASK_PATH, 3))}\n`;
  assert.throws(() => module.parseVerificationLedger(badAudit, { taskId: TASK_ID, auditStart: 6 }));
  scenarios += 1;

  const missingEarlierAudit = `${fixtureReadme(9)}\n${auditEntry(7, 9)}\n`;
  assert.throws(() =>
    module.parseVerificationLedger(missingEarlierAudit, { taskId: TASK_ID, auditStart: 6 }),
  );
  scenarios += 1;

  const fenced = fixtureReadme(0).replace(
    "## Verification log",
    `## Context\n\n\`\`\`md\n${runRecord(1).logEntry}\n\`\`\`\n\n## Verification log`,
  );
  assert.equal(
    module.parseVerificationLedger(fenced, { taskId: TASK_ID, auditStart: 6 }).runCount,
    0,
  );
  scenarios += 1;

  const outside = fixtureReadme(0).replace(
    "## Verification log",
    `## Context\n\n${runRecord(1).logEntry}\n\n## Verification log`,
  );
  assert.equal(
    module.parseVerificationLedger(outside, { taskId: TASK_ID, auditStart: 6 }).runCount,
    0,
  );
  scenarios += 1;

  const plainBullet = fixtureReadme(1).replace("- **Finding 1.**", "- Evidence for run 1.");
  assert.equal(
    module.parseVerificationLedger(plainBullet, { taskId: TASK_ID, auditStart: 6 }).runCount,
    1,
  );
  scenarios += 1;

  const visibleFinding =
    "- **Finding 1.** Prediction and observation with report/path-1.md:1. Demand: fix.";
  for (const hiddenBody of [
    "```md\n- Hidden evidence only.\n```",
    "<!--\n- Hidden evidence only.\n-->",
  ]) {
    const hiddenVerdict = fixtureReadme(1).replace(visibleFinding, hiddenBody);
    assert.throws(() =>
      module.parseVerificationLedger(hiddenVerdict, { taskId: TASK_ID, auditStart: 6 }),
    );
    scenarios += 1;
  }

  const completeAudit = auditEntry(4, 6);
  const auditHeading = "### 2026-07-16 — progress critic — RUNS 4-6: progressing";
  for (const hiddenBody of [
    `${auditHeading}\n\n\`\`\`md\n- Rationale: hidden\n- Evidence (report): fabricated — hidden\n- Next focus: hidden\n- Assessment: progressing\n\`\`\``,
    `${auditHeading}\n\n<!--\n- Rationale: hidden\n- Evidence (report): fabricated — hidden\n- Next focus: hidden\n- Assessment: progressing\n-->`,
  ]) {
    const hiddenAudit = fixtureReadme(6, { audit: 6 }).replace(completeAudit, hiddenBody);
    assert.throws(() =>
      module.parseVerificationLedger(hiddenAudit, { taskId: TASK_ID, auditStart: 6 }),
    );
    scenarios += 1;
  }

  for (const missing of [
    `- Rationale: ${citedProgress.rationale}\n`,
    `- Evidence (${citedProgress.evidence[0].kind}): ${citedProgress.evidence[0].ref} — ${citedProgress.evidence[0].supports}\n`,
    `- Next focus: ${citedProgress.nextFocus[0]}\n`,
    "- Assessment: progressing",
  ]) {
    const incomplete = fixtureReadme(6, { audit: 6 }).replace(missing, "");
    assert.throws(() =>
      module.parseVerificationLedger(incomplete, { taskId: TASK_ID, auditStart: 6 }),
    );
    scenarios += 1;
  }

  const headingOnlyAudit = fixtureReadme(6, { audit: 6 }).replace(
    /### 2026-07-16 — progress critic — RUNS 4-6: progressing[\s\S]*?(?=\n\n### 2026-07-16 — judge)/,
    "### 2026-07-16 — progress critic — RUNS 4-6: progressing",
  );
  assert.throws(() =>
    module.parseVerificationLedger(headingOnlyAudit, { taskId: TASK_ID, auditStart: 6 }),
  );
  scenarios += 1;

  const noEvidenceAudit = fixtureReadme(6, { audit: 6 }).replace(/- Evidence \([^\n]+\n/, "");
  assert.throws(() =>
    module.parseVerificationLedger(noEvidenceAudit, { taskId: TASK_ID, auditStart: 6 }),
  );
  scenarios += 1;

  const arbitraryDigest = "f".repeat(64);
  const missingCommit = "0".repeat(40);
  const catalogReadme = fixtureReadme(3).replace(
    visibleFinding.replaceAll("1", "3"),
    `${visibleFinding.replaceAll("1", "3")} Visible refs: \`AGENTS.md:1\`, \`AGENTS.md:999999\`, \`node missing-script.mjs\`, \`${commits[0]}..${missingCommit}\`, and ${arbitraryDigest}. <!-- \`hidden.md:1\` hidden commit ${commits[0]} -->`,
  );
  const catalogSnapshot = module.buildWorkQueueSnapshot({
    projectText,
    queueText,
    readmeText: catalogReadme,
    sourceCommit: commits[0],
    attesterSourceCommit: commits[0],
    attesterDigest: digest("b"),
    controlDigest: digest("c"),
    resolvePath: (ref) => ref === "AGENTS.md:1" || ref === "hidden.md:1",
    commitExists: (oid) => oid === commits[0],
  });
  assert.equal(
    catalogSnapshot.evidenceCatalog.some(
      (item) => item.kind === "fixture" && item.ref === "AGENTS.md:1",
    ),
    true,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some((item) => item.ref === "AGENTS.md:999999"),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some((item) => item.kind === "command"),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some((item) => item.ref === arbitraryDigest),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some((item) => item.ref.includes(missingCommit)),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some(
      (item) => item.kind === "commit" && item.ref === commits[0],
    ),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some((item) => item.ref === "hidden.md:1"),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.every(
      (item) => typeof item.verifier === "string" && typeof item.target === "string",
    ),
    true,
  );
  scenarios += 1;

  const deferred = fixtureReadme(7).replace("progress_audit_start: 6", "progress_audit_start: 9");
  assert.throws(() =>
    module.buildWorkQueueSnapshot({
      projectText,
      queueText,
      readmeText: deferred,
      sourceCommit: commits[0],
      attesterSourceCommit: commits[0],
      attesterDigest: digest("b"),
      controlDigest: digest("c"),
    }),
  );
  scenarios += 1;
  return scenarios;
}

async function importSnapshotModule(source, label) {
  const url = `data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=${label}`).toString("base64")}`;
  return import(url);
}

async function verifyVerifyTaskBoundary(source) {
  const runWorkflow = compile(source);
  const verdictEntry = runRecord(8).logEntry;
  const agent = async (_prompt, options) => {
    if (options.label === "orient") {
      return {
        ok: true,
        taskId: TASK_ID,
        taskPath: TASK_PATH.replace(/\/readme\.md$/, ""),
        diffCmd: "git diff",
        claims: ["claim"],
        criteria: ["criterion"],
        attackAngles: [],
        evidencePaths: [],
        replayRecordings: [],
        changedHunks: [],
        capstone: false,
      };
    }
    if (options.label === "verdict") {
      return {
        verdict: "refuted",
        logEntry: verdictEntry,
        baseCommit: commits[0],
        commitOid: commits[1],
        promoted: [],
        report: verdictEntry,
      };
    }
    if (options.label.startsWith("xcheck:")) return { stands: true, reason: "confirmed" };
    return { findings: [], notes: "survived" };
  };
  const result = await runWorkflow(
    agent,
    async () => {},
    async (tasks) => Promise.all(tasks.map((task) => task())),
    () => {},
    () => {},
    { total: 0, remaining: () => Infinity },
    { task: TASK_ID },
  );
  assert.equal(result.taskId, TASK_ID);
  assert.equal(result.baseCommit, commits[0]);
  assert.equal(result.commitOid, commits[1]);
  assert.equal(result.logEntry, verdictEntry);
  return 1;
}

let scenarios = await verifyWorkQueuePolicy(workQueueSource);
scenarios += await verifyParserPolicy({
  CONTROL_PATHS,
  addressableLineCount,
  buildWorkQueueSnapshot,
  canonicalTaskPath,
  isSafeRepoPath,
  parseVerificationLedger,
});
scenarios += await verifyVerifyTaskBoundary(verifyTaskSource);

function committedSnapshot(
  cwd,
  taskId = TASK_ID,
  { attester = "HEAD", source = "HEAD", base } = {},
) {
  const cli = execFileSync(
    "git",
    ["show", `${attester}:packages/identity/scripts/work-queue-snapshot.mjs`],
    {
      cwd,
    },
  );
  const args = [
    "--input-type=module",
    "-",
    "--attester",
    attester,
    "--source",
    source,
    "--task",
    taskId,
  ];
  if (base !== undefined) args.push("--base", base);
  return JSON.parse(execFileSync(process.execPath, args, { cwd, input: cli, encoding: "utf8" }));
}

function verifyCharterControlRoot() {
  const temporary = mkdtempSync(resolve(tmpdir(), "eforest-charter-root-"));
  const clone = resolve(temporary, "repo");
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", root, clone]);
    execFileSync("git", ["config", "user.name", "E2 Policy Sensor"], { cwd: clone });
    execFileSync("git", ["config", "user.email", "policy@example.invalid"], { cwd: clone });
    writeFileSync(
      resolve(clone, "packages/identity/scripts/work-queue-snapshot-lib.mjs"),
      snapshotLibSource,
    );
    writeFileSync(
      resolve(clone, "packages/identity/scripts/work-queue-snapshot.mjs"),
      snapshotCliSource,
    );
    execFileSync(
      "git",
      [
        "add",
        "packages/identity/scripts/work-queue-snapshot-lib.mjs",
        "packages/identity/scripts/work-queue-snapshot.mjs",
      ],
      { cwd: clone },
    );
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: clone });
    } catch {
      execFileSync("git", ["commit", "--quiet", "-m", "install control-root sensor"], {
        cwd: clone,
      });
    }
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const before = committedSnapshot(clone);
    const agentsPath = resolve(clone, "AGENTS.md");
    writeFileSync(agentsPath, `${readFileSync(agentsPath, "utf8")}\n<!-- control-root-probe -->\n`);
    execFileSync("git", ["add", "AGENTS.md"], { cwd: clone });
    execFileSync("git", ["commit", "--quiet", "-m", "mutate governing charter"], { cwd: clone });
    const after = committedSnapshot(clone, TASK_ID, { attester: base, source: "HEAD", base });
    assert.notEqual(after.controlDigest, before.controlDigest);
    assert.deepEqual(after.changedPaths, ["AGENTS.md"]);
    assert.equal(after.attesterDigest, before.attesterDigest);
    return 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyCommittedCliResolvers(cliSource, label) {
  const temporary = mkdtempSync(resolve(tmpdir(), `eforest-resolvers-${label}-`));
  const clone = resolve(temporary, "repo");
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", root, clone]);
    execFileSync("git", ["config", "user.name", "E2 Policy Sensor"], { cwd: clone });
    execFileSync("git", ["config", "user.email", "policy@example.invalid"], { cwd: clone });
    const sourceBase = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const sourceParent = execFileSync("git", ["rev-parse", "HEAD^"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const sourceTree = execFileSync("git", ["rev-parse", `${sourceBase}^{tree}`], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const orphanCommit = execFileSync(
      "git",
      ["commit-tree", sourceTree, "-m", "unreachable resolver probe"],
      { cwd: clone, encoding: "utf8" },
    ).trim();
    const missingCommit = "0".repeat(40);
    const agentsLineCount = addressableLineCount(readFileSync(resolve(clone, "AGENTS.md"), "utf8"));
    const readmePath = resolve(clone, TASK_PATH);
    const readme = readFileSync(readmePath, "utf8");
    const heading = "### 2026-07-16 — judge round 9 — VERDICT: refuted";
    const probe =
      `${heading}\n\n- Resolver probe: \`AGENTS.md:1\`, \`AGENTS.md:${agentsLineCount}\`, ` +
      `\`AGENTS.md:${agentsLineCount + 1}\`, \`resolver-empty.txt:1\`, ` +
      `\`../AGENTS.md:1\`, \`AGENTS.md:999999\`, \`${sourceParent}..${sourceBase}\`, ` +
      `\`${orphanCommit}..${sourceBase}\`, and \`${missingCommit}..${sourceBase}\`.`;
    const probedReadme = readme.replace(`${heading}\n`, `${probe}\n`);
    assert.notEqual(probedReadme, readme, "resolver fixture heading was not found");
    writeFileSync(readmePath, probedReadme);
    writeFileSync(resolve(clone, "resolver-empty.txt"), "");
    writeFileSync(
      resolve(clone, "packages/identity/scripts/work-queue-snapshot-lib.mjs"),
      snapshotLibSource,
    );
    writeFileSync(resolve(clone, "packages/identity/scripts/work-queue-snapshot.mjs"), cliSource);
    execFileSync(
      "git",
      [
        "add",
        TASK_PATH,
        "resolver-empty.txt",
        "packages/identity/scripts/work-queue-snapshot-lib.mjs",
        "packages/identity/scripts/work-queue-snapshot.mjs",
      ],
      { cwd: clone },
    );
    execFileSync("git", ["commit", "--quiet", "-m", `resolver policy ${label}`], { cwd: clone });
    const value = committedSnapshot(clone);
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === "AGENTS.md:1"),
      true,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === `AGENTS.md:${agentsLineCount}`),
      true,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === `AGENTS.md:${agentsLineCount + 1}`),
      false,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === "resolver-empty.txt:1"),
      false,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === "../AGENTS.md:1"),
      false,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === "AGENTS.md:999999"),
      false,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === `${sourceParent}..${sourceBase}`),
      true,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === `${missingCommit}..${sourceBase}`),
      false,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === `${orphanCommit}..${sourceBase}`),
      false,
    );
    return 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const cliSnapshot = committedSnapshot(root);
assert.equal(cliSnapshot.taskId, TASK_ID);
assert.equal(
  cliSnapshot.sourceCommit,
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
);
scenarios += 1;
scenarios += verifyCommittedCliResolvers(snapshotCliSource, "baseline");
scenarios += verifyCharterControlRoot();

const dirtyRoot = mkdtempSync(resolve(tmpdir(), "eforest-attester-"));
const dirtyRepo = resolve(dirtyRoot, "repo");
try {
  execFileSync("git", ["clone", "--quiet", "--shared", root, dirtyRepo]);
  writeFileSync(
    resolve(dirtyRepo, "packages/identity/scripts/work-queue-snapshot.mjs"),
    'process.stdout.write("{\\"schemaVersion\\":2,\\"status\\":\\"verified\\"}\\n");\n',
  );
  const honest = committedSnapshot(dirtyRepo);
  assert.equal(honest.status, cliSnapshot.status);
  assert.equal(honest.sourceCommit, cliSnapshot.sourceCommit);
  assert.notEqual(honest.status, "verified");
  scenarios += 1;
} finally {
  rmSync(dirtyRoot, { recursive: true, force: true });
}

const workQueueMutations = [
  {
    name: "reader-consensus",
    from: "if (!readers[0]?.snapshot || readers[0].snapshot !== readers[1]?.snapshot) return null",
    to: "if (!readers[0]?.snapshot || false) return null",
  },
  {
    name: "checkpoint-closure",
    from: "if (snapshot.progressAuditedThrough < requiredPriorCheckpoint || snapshot.progressAuditedThrough > latestPossibleCheckpoint) return false",
    to: "if (snapshot.progressAuditedThrough > latestPossibleCheckpoint) return false",
  },
  {
    name: "canonical-task-path",
    from: "if (!validTaskPath(taskId, snapshot.taskPath)) return false",
    to: "if (false) return false",
  },
  {
    name: "structured-citation",
    from: "candidate.kind === item.kind && candidate.ref === item.ref",
    to: "true",
  },
  {
    name: "catalog-verifier-binding",
    from: "snapshot.evidenceCatalog.some((item) => !validCatalogItem(item))",
    to: "false",
  },
  {
    name: "committed-attester-command",
    from: "git show ${attesterCommit}:${SNAPSHOT_SCRIPT} | node",
    to: "node packages/identity/scripts/work-queue-snapshot.mjs && node",
  },
  {
    name: "immutable-ledger-history",
    from: "before.ledgerDigest === after.ledgerDigest &&\n  JSON.stringify(before.runEntryDigests) === JSON.stringify(after.runEntryDigests)",
    to: "true &&\n  true",
  },
  {
    name: "run-ceiling-ledger-history",
    from: "before.runCeiling === after.runCeiling &&",
    to: "true &&",
  },
  {
    name: "requested-run-ceiling",
    from: "if (configuredMaxRuns > snapshot.runCeiling) {",
    to: "if (false) {",
  },
  {
    name: "snapshot-run-ceiling",
    from: "snapshot.runCount > snapshot.runCeiling",
    to: "false",
  },
  {
    name: "control-source-digest",
    from: "before.controlDigest === after.controlDigest &&",
    to: "true &&",
  },
  {
    name: "audit-control-source-digest",
    from: "after.controlDigest === snapshot.controlDigest &&",
    to: "true &&",
  },
  {
    name: "verdict-control-source-digest",
    from: "      after.controlDigest === before.controlDigest &&",
    to: "      true &&",
  },
  {
    name: "audit-run-history-prefix",
    from: "JSON.stringify(after.runEntryDigests) === JSON.stringify(snapshot.runEntryDigests) &&",
    to: "true &&",
  },
  {
    name: "audit-entry-history-prefix",
    from: "samePrefix(snapshot, after, 'auditEntryDigests', 1) &&",
    to: "true &&",
  },
  {
    name: "verdict-audit-history",
    from: "JSON.stringify(after.auditEntryDigests) === JSON.stringify(before.auditEntryDigests) &&",
    to: "true &&",
  },
  {
    name: "audit-transition-path-set",
    from: "exactChanged(after, [snapshot.taskPath, QUEUE_PATH]) &&",
    to: "true &&",
  },
  {
    name: "audit-structured-readback",
    from: "canonicalText(after.latestAudit.rationale) === canonicalText(progress.rationale) &&",
    to: "true &&",
  },
  {
    name: "latest-audit-assessment",
    from: "snapshot.latestAudit.assessment !== 'progressing' ||",
    to: "false ||",
  },
  {
    name: "audit-attester-digest",
    from: "after.attesterDigest === snapshot.attesterDigest &&",
    to: "true &&",
  },
  {
    name: "audit-evidence-readback",
    from: "after.latestAudit.evidence.map((item) => ({",
    to: "progress.evidence.map((item) => ({",
  },
  {
    name: "audit-next-focus-readback",
    from: "JSON.stringify(after.latestAudit.nextFocus.map(canonicalText)) ===",
    to: "JSON.stringify(progress.nextFocus.map(canonicalText)) ===",
  },
  {
    name: "implementation-transition-path-set",
    from: "!implementationChanged(after, before.taskPath) ||",
    to: "false ||",
  },
  {
    name: "verdict-transition-path-set",
    from: "verdictChanged(after, before.taskPath) &&",
    to: "true &&",
  },
  {
    name: "invalid-loop-transition-path-set",
    from: "exactChanged(after, [PROJECT_PATH, QUEUE_PATH])",
    to: "true",
  },
  {
    name: "task-bound-audit-start",
    from: "if (snapshot.auditStart !== (taskId === 'E2-T01' ? 6 : 3)) return false",
    to: "if (!Number.isInteger(snapshot.auditStart)) return false",
  },
  {
    name: "verdict-history-prefix",
    from: "samePrefix(before, after, 'runEntryDigests', 1) &&",
    to: "true &&",
  },
  {
    name: "observed-commit-movement",
    from: "after.sourceCommit !== before.sourceCommit",
    to: "true",
  },
  {
    name: "verdict-task-identity",
    from: "verdict?.taskId === taskId &&",
    to: "true &&",
  },
  {
    name: "verdict-attester-digest",
    from: "      after.attesterDigest === before.attesterDigest &&",
    to: "      true &&",
  },
  {
    name: "verdict-log-entry-readback",
    from: "last?.logEntry === verdict?.logEntry?.trim() &&",
    to: "true &&",
  },
  {
    name: "verdict-value-readback",
    from: "last?.verdict === verdict.verdict &&",
    to: "true &&",
  },
  {
    name: "verdict-status-readback",
    from: "after.status === expectedStatus",
    to: "true",
  },
  {
    name: "invalid-loop-ledger-readback",
    from: "    sameLedger(before, after) &&",
    to: "    true &&",
  },
  {
    name: "invalid-loop-observed-commit",
    from: "    observedCommit(committed, before, after) &&",
    to: "    true &&",
  },
  {
    name: "invalid-loop-result-propagation",
    from: "if (!(await flipInvalid(reason, before))) return unpersistedStop(reason)",
    to: "await flipInvalid(reason, before)",
  },
  {
    name: "initial-audit-stop-propagation",
    from: "if (initialAuditStop) return initialAuditStop",
    to: "if (false) return initialAuditStop",
  },
  {
    name: "loop-audit-stop-propagation",
    from: "if (auditStop) return auditStop",
    to: "if (false) return auditStop",
  },
];

for (const mutation of workQueueMutations) {
  const mutated = workQueueSource.replace(mutation.from, mutation.to);
  assert.notEqual(mutated, workQueueSource, `${mutation.name} did not apply`);
  await assert.rejects(
    () => verifyWorkQueuePolicy(mutated),
    undefined,
    `${mutation.name} survived`,
  );
}

const parserMutations = [
  {
    name: "parser-authorized-run-ceiling",
    from: "ceiling < 10 || ceiling > 100 || (ceiling - 10) % 3 !== 0",
    to: "ceiling < 10 || ceiling > 100 || false",
  },
  {
    name: "parser-history-run-ceiling",
    from: "if (ledger.runCount > runCeiling) {",
    to: "if (false) {",
  },
  {
    name: "parser-frontmatter-id",
    from: "if (fields.id !== taskId)",
    to: "if (false)",
  },
  {
    name: "parser-run-sequence",
    from: "if (run.run !== index + 1) throw new Error(`official verdict history skips run ${index + 1}`);",
    to: "if (false) throw new Error('disabled');",
  },
  {
    name: "parser-canonical-path",
    from: "!new RegExp(`^\\\\.eforest/tasks/epic-${epic}[^/]*/${escaped}(?:-[^/]+)?/readme\\\\.md$`).test(path)",
    to: "false",
  },
  {
    name: "parser-audit-window",
    from: "lastRun < auditStart ||",
    to: "false ||",
  },
  {
    name: "parser-audit-sequence",
    from: "if (!audits.some((entry) => entry.lastRun === expected)) {",
    to: "if (false) {",
  },
  {
    name: "parser-verification-log-scope",
    from: "const start = logStarts[0] + 1;",
    to: "const start = 0;",
  },
  {
    name: "parser-visible-verdict-body",
    from: "const findings = topLevelBullets(section.visibleEntry);",
    to: "const findings = topLevelBullets(section.entry);",
  },
  {
    name: "parser-visible-audit-body",
    from: "const bullets = topLevelBullets(section.visibleEntry);",
    to: "const bullets = topLevelBullets(section.entry);",
  },
  {
    name: "parser-audit-fields",
    from: "if (!parsed.complete && !pinnedLegacyAudit) {",
    to: "if (false && !pinnedLegacyAudit) {",
  },
  {
    name: "parser-task-bound-migration",
    from: 'if (fields.progress_audit_start !== "6") {',
    to: "if (false) {",
  },
  {
    name: "parser-plain-evidence-bullet",
    from: "const bullet = /^- (\\S.*)$/.exec(line);",
    to: "const bullet = /^- \\*\\*(\\S.*)$/.exec(line);",
  },
  {
    name: "parser-control-agents",
    from: '  "AGENTS.md",\n',
    to: "",
  },
  {
    name: "parser-control-loop",
    from: '  ".eforest/loop.md",\n',
    to: "",
  },
  {
    name: "parser-visible-evidence-catalog",
    from: "for (const match of run.visibleReport.matchAll",
    to: "for (const match of run.report.matchAll",
  },
  {
    name: "parser-visible-commit-catalog",
    from: "for (const value of run.visibleReport.match(/\\b[0-9a-f]{40}",
    to: "for (const value of run.report.match(/\\b[0-9a-f]{40}",
  },
  {
    name: "parser-addressable-line-count",
    from: 'return text.split("\\n").length - (text.endsWith("\\n") ? 1 : 0);',
    to: 'return text.split("\\n").length;',
  },
  {
    name: "parser-path-traversal",
    from: 'path.split("/").every((segment) => segment.length > 0 && segment !== "..")',
    to: "true",
  },
  {
    name: "parser-command-syntax-is-not-evidence",
    from: "      const ref = match[1];",
    to: '      const ref = match[1];\n      if (/^node /.test(ref)) add("command", ref, "git-path", ref);',
  },
  {
    name: "parser-unbound-digest-is-not-evidence",
    from: '    add("report", reportRef, "ledger-entry", run.entryDigest);',
    to: '    add("report", reportRef, "ledger-entry", run.entryDigest);\n    for (const value of run.visibleReport.match(/\\b[0-9a-f]{64}\\b/g) ?? []) add("digest", value, "ledger-entry-digest", reportRef);',
  },
];

for (const mutation of parserMutations) {
  const mutated = snapshotLibSource.replace(mutation.from, mutation.to);
  assert.notEqual(mutated, snapshotLibSource, `${mutation.name} did not apply`);
  const module = await importSnapshotModule(mutated, mutation.name);
  await assert.rejects(() => verifyParserPolicy(module), undefined, `${mutation.name} survived`);
}

const snapshotCliMutations = [
  {
    name: "path-line-resolver",
    from: "return start >= 1 && end >= start && end <= lineCount;",
    to: "return true;",
  },
  {
    name: "commit-resolver",
    from: 'git("cat-file", "-e", `${oid}^{commit}`);',
    to: "return true;",
  },
  {
    name: "commit-reachability",
    from: 'git("merge-base", "--is-ancestor", oid, sourceCommit);',
    to: "void sourceCommit;",
  },
];

for (const mutation of snapshotCliMutations) {
  const mutated = snapshotCliSource.replace(mutation.from, mutation.to);
  assert.notEqual(mutated, snapshotCliSource, `${mutation.name} did not apply`);
  assert.throws(
    () => verifyCommittedCliResolvers(mutated, mutation.name),
    undefined,
    `${mutation.name} survived`,
  );
}

const verifyTaskMutation = {
  name: "verify-task-commit-oid-propagation",
  from: "commitOid: verdict?.commitOid ?? '',",
  to: "commitOid: '',",
};
const mutatedVerifyTask = verifyTaskSource.replace(verifyTaskMutation.from, verifyTaskMutation.to);
assert.notEqual(mutatedVerifyTask, verifyTaskSource, `${verifyTaskMutation.name} did not apply`);
await assert.rejects(
  () => verifyVerifyTaskBoundary(mutatedVerifyTask),
  undefined,
  `${verifyTaskMutation.name} survived`,
);

const mutations = [
  ...workQueueMutations.map(({ name }) => name),
  ...parserMutations.map(({ name }) => name),
  ...snapshotCliMutations.map(({ name }) => name),
  verifyTaskMutation.name,
];
process.stdout.write(
  `${JSON.stringify({ mutations, scenarios, status: "WORK_QUEUE_POLICY_OK" })}\n`,
);
