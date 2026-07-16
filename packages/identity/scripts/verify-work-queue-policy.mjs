import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  buildWorkQueueSnapshot,
  canonicalTaskPath,
  parseVerificationLedger,
} from "./work-queue-snapshot-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workQueueSource = readFileSync(resolve(root, ".claude/workflows/work-queue.js"), "utf8");
const verifyTaskSource = readFileSync(resolve(root, ".claude/workflows/verify-task.js"), "utf8");
const snapshotLibSource = readFileSync(
  resolve(root, "packages/identity/scripts/work-queue-snapshot-lib.mjs"),
  "utf8",
);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const TASK_ID = "E2-T01";
const TASK_PATH = ".eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md";
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

const citedProgress = {
  assessment: "progressing",
  rationale: "Earlier findings closed through a general invariant.",
  evidence: [
    {
      kind: "report",
      ref: "work/progress/RESULTS.md:12",
      supports: "The previous counterexample is now rejected while older cases remain green.",
    },
  ],
  nextFocus: ["Exercise the next compositional boundary."],
};

function auditEntry(firstRun, lastRun, progress = citedProgress) {
  return [
    `### 2026-07-16 — progress critic — RUNS ${firstRun}-${lastRun}: progressing`,
    "",
    `- ${progress.rationale}`,
    ...progress.evidence.map((item) => `- ${item.kind}: ${item.ref} — ${item.supports}`),
    ...progress.nextFocus.map((item) => `- Next focus: ${item}`),
  ].join("\n");
}

function snapshot(count, options = {}) {
  const status = options.status ?? (count === 0 ? "pending" : "refuted");
  const progressAuditedThrough = options.progressAuditedThrough ?? 0;
  const lastVerdict = options.lastVerdict ?? (status === "verified" ? "verified" : "refuted");
  const allRuns = Array.from({ length: count }, (_, index) =>
    runRecord(index + 1, index + 1 === count ? lastVerdict : "refuted"),
  );
  const firstAuditRun = options.firstAuditRun ?? Math.max(1, progressAuditedThrough - 2);
  const latestAudit =
    progressAuditedThrough === 0
      ? null
      : {
          firstRun: firstAuditRun,
          lastRun: progressAuditedThrough,
          entry:
            options.auditEntry ??
            auditEntry(firstAuditRun, progressAuditedThrough, options.progress),
          entryDigest: digest("7"),
        };
  return {
    schemaVersion: 1,
    sourceCommit: options.commit ?? commits[0],
    projectDigest: digest("8"),
    queueDigest: digest("9"),
    taskDigest: digest("a"),
    projectStatus: Object.hasOwn(options, "projectStatus") ? options.projectStatus : "building",
    currentGateTaskId: options.currentGateTaskId ?? (status === "verified" ? "E2-T02" : TASK_ID),
    taskId: options.taskId ?? TASK_ID,
    taskPath: options.taskPath ?? TASK_PATH,
    status,
    auditStart: options.auditStart ?? 3,
    auditEnds:
      progressAuditedThrough === 0
        ? []
        : Array.from(
            {
              length: (progressAuditedThrough - (options.auditStart ?? 3)) / 3 + 1,
            },
            (_, index) => (options.auditStart ?? 3) + index * 3,
          ),
    progressAuditedThrough,
    runCount: count,
    runs: allRuns.slice(-3),
    latestAudit,
  };
}

function verdict(before, after, overrides = {}) {
  return {
    taskId: TASK_ID,
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
  const readerSnapshots = options.readerSnapshots ?? [
    defaultInitial,
    defaultImplemented,
    defaultVerified,
  ];
  const verdicts = [...(options.verdicts ?? [verdict(defaultImplemented, defaultVerified)])];
  const progressResults = [...(options.progressResults ?? [])];
  const commitResults = [...(options.commitResults ?? [])];
  const events = [];
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
      return { done: true };
    }
    throw new Error(`unexpected agent ${agentOptions.label}`);
  };

  const workflow = async (name, workflowArguments) => {
    if (name === "implement-task") {
      events.push("implement");
      implementArguments.push(workflowArguments);
      return { claimed: true, taskId: TASK_ID };
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
    () => {},
    { total: 0, remaining: () => Number.POSITIVE_INFINITY },
    options.args ?? { tasks: 1 },
  );
  return { events, implementArguments, labels, result };
}

async function verifyWorkQueuePolicy(source) {
  let scenarios = 0;

  for (const invalidMaxRuns of [0, -2, 2.5, "3", Number.NaN, 11]) {
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: invalidMaxRuns },
    });
    assert.equal(run.result.refused, "invalid maxRuns");
    assert.deepEqual(run.labels, []);
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
    snapshot(4, { status: "refuted", progressAuditedThrough: 0 }),
    snapshot(5, { status: "refuted", progressAuditedThrough: 0 }),
    snapshot(7, { status: "refuted", progressAuditedThrough: 3 }),
    snapshot(8, { status: "refuted", progressAuditedThrough: 3 }),
    snapshot(10, { status: "refuted", progressAuditedThrough: 6 }),
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
  ]) {
    const run = await executeWorkQueue(source, { readerSnapshots: [malformed] });
    assert.equal(run.result.refused, "invalid committed gate snapshot");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  {
    const a = snapshot(3, { status: "refuted", progressAuditedThrough: 0, commit: commits[0] });
    const b = snapshot(3, {
      status: "in-progress",
      progressAuditedThrough: 3,
      commit: commits[1],
      progress: citedProgress,
    });
    const c = snapshot(3, {
      status: "implemented",
      progressAuditedThrough: 3,
      commit: commits[2],
      progress: citedProgress,
    });
    const d = snapshot(4, {
      status: "verified",
      lastVerdict: "verified",
      progressAuditedThrough: 3,
      commit: commits[3],
      progress: citedProgress,
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c, d],
      progressResults: [structuredClone(citedProgress)],
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
    const a = snapshot(3, { status: "refuted", progressAuditedThrough: 0 });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a],
      progressResults: [rejectedProgress],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.events.includes("record-progress"), false);
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  {
    const a = snapshot(3, { status: "refuted", progressAuditedThrough: 0, commit: commits[0] });
    const b = snapshot(3, {
      status: "in-progress",
      progressAuditedThrough: 3,
      commit: commits[0],
      progress: citedProgress,
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b],
      progressResults: [structuredClone(citedProgress)],
      commitResults: [{ baseCommit: commits[0], commitOid: commits[0] }],
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
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b],
      verdicts: [verdict(a, b, { taskId: "E2-T02" })],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  {
    const a = snapshot(0, { status: "implemented", commit: commits[0] });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, a],
      verdicts: [
        verdict(a, snapshot(1, { status: "verified", lastVerdict: "verified" }), {
          baseCommit: commits[0],
          commitOid: commits[0],
        }),
      ],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  {
    const a = snapshot(1, { status: "refuted", commit: commits[0] });
    const b = snapshot(1, { status: "implemented", commit: commits[1] });
    const c = snapshot(2, { status: "refuted", commit: commits[2] });
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: 2 },
      readerSnapshots: [a, b, c],
      verdicts: [verdict(b, c)],
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
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b],
      verdicts: [verdict(a, b)],
    });
    assert.equal(run.result.completed[0].runs, 10);
    assert.equal(
      run.result.completed[0].verdict,
      finalVerdict === "verified" ? "verified" : "invalid_loop",
    );
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

  return scenarios;
}

function fixtureQueue(
  taskId = TASK_ID,
  path = "epic-2-the-gates/E2-T01-identity-event-model/readme.md",
) {
  return `# queue\n\n## Current gate\n\n1. **${taskId}** — task\n\n## Epic 2\n\n- [?] [${taskId}](${path})\n`;
}

function fixtureReadme(count, { id = TASK_ID, status = "refuted", audit } = {}) {
  const verdicts = Array.from({ length: count }, (_, index) => index + 1)
    .reverse()
    .map((run) => runRecord(run).logEntry)
    .join("\n\n");
  const auditText = audit ? `${auditEntry(audit - 2, audit)}\n\n` : "";
  return `---\nid: ${id}\nstatus: ${status}\n---\n\n## Verification log\n\n${auditText}${verdicts}\n`;
}

async function verifyParserPolicy(module) {
  let scenarios = 0;
  const projectText = '{"status":"building"}\n';
  const queueText = fixtureQueue();
  const readmeText = fixtureReadme(3, { status: "refuted" });
  const parsed = module.buildWorkQueueSnapshot({
    projectText,
    queueText,
    readmeText,
    sourceCommit: commits[0],
  });
  assert.equal(parsed.taskId, TASK_ID);
  assert.equal(parsed.taskPath, TASK_PATH);
  assert.equal(parsed.runCount, 3);
  assert.equal(parsed.progressAuditedThrough, 0);
  scenarios += 1;

  assert.throws(() =>
    module.buildWorkQueueSnapshot({
      projectText,
      queueText,
      readmeText: fixtureReadme(3, { id: "E2-T02" }),
      sourceCommit: commits[0],
    }),
  );
  scenarios += 1;

  const skipped = fixtureReadme(3).replace(runRecord(2).logEntry, "");
  assert.throws(() => module.parseVerificationLedger(skipped));
  scenarios += 1;

  assert.throws(() =>
    module.canonicalTaskPath(fixtureQueue(TASK_ID, "epic-9/E2-T01-wrong/readme.md"), TASK_ID),
  );
  scenarios += 1;

  const badAudit = `${fixtureReadme(3)}\n### 2026-07-16 — progress critic — RUNS 1-4: progressing\n\n- invalid\n`;
  assert.throws(() => module.parseVerificationLedger(badAudit));
  scenarios += 1;

  assert.throws(() => module.parseVerificationLedger(fixtureReadme(6, { audit: 6 })));
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
  buildWorkQueueSnapshot,
  canonicalTaskPath,
  parseVerificationLedger,
});
scenarios += await verifyVerifyTaskBoundary(verifyTaskSource);

const cliSnapshot = JSON.parse(
  execFileSync(
    process.execPath,
    ["packages/identity/scripts/work-queue-snapshot.mjs", "--task", TASK_ID],
    {
      cwd: root,
      encoding: "utf8",
    },
  ),
);
assert.equal(cliSnapshot.taskId, TASK_ID);
assert.equal(
  cliSnapshot.sourceCommit,
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
);
scenarios += 1;

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
    from: "if (['report', 'test', 'fixture'].includes(item.kind)) return item.ref.includes('/') && !item.ref.includes('..')",
    to: "if (['report', 'test', 'fixture'].includes(item.kind)) return true",
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
    from: "if (lastRun - firstRun !== 2 || lastRun % 3 !== 0 || lastRun > runs.length) {",
    to: "if (false) {",
  },
  {
    name: "parser-audit-sequence",
    from: "if (!audits.some((entry) => entry.lastRun === expected)) {",
    to: "if (false) {",
  },
];

for (const mutation of parserMutations) {
  const mutated = snapshotLibSource.replace(mutation.from, mutation.to);
  assert.notEqual(mutated, snapshotLibSource, `${mutation.name} did not apply`);
  const module = await importSnapshotModule(mutated, mutation.name);
  await assert.rejects(() => verifyParserPolicy(module), undefined, `${mutation.name} survived`);
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
  verifyTaskMutation.name,
];
process.stdout.write(
  `${JSON.stringify({ mutations, scenarios, status: "WORK_QUEUE_POLICY_OK" })}\n`,
);
