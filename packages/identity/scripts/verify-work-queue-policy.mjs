import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowSource = readFileSync(resolve(root, ".claude/workflows/work-queue.js"), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

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
  return {
    run,
    verdict,
    findings: [`finding-${run}`],
    promoted: [`test-${run}`],
    report: `complete-report-${run}`,
    logEntry: `official-log-entry-${run}`,
  };
}

function history(count, options = {}) {
  return {
    ok: true,
    taskId: options.taskId ?? "E9-T99",
    taskPath: options.taskPath ?? ".eforest/tasks/epic-9/E9-T99-policy",
    status: options.status ?? (count === 0 ? "pending" : "refuted"),
    progressAuditedThrough: options.progressAuditedThrough ?? 0,
    runs: Array.from({ length: count }, (_, index) => runRecord(index + 1)),
  };
}

function committedVerdict(verdict, run, overrides = {}) {
  return {
    taskId: "E9-T99",
    verdict,
    committed: true,
    findings: [{ kind: "other", citation: `citation-${run}` }],
    promoted: [`promoted-${run}`],
    report: `builder-report-${run}`,
    logEntry: `committed-verdict-${run}`,
    ...overrides,
  };
}

const citedProgress = {
  assessment: "progressing",
  rationale: "Earlier finding closed by a general invariant.",
  evidence: ["report.md:12 and digest abc123"],
  nextFocus: ["Exercise the next compositional boundary."],
};

async function execute(source, options = {}) {
  const runWorkflow = compile(source);
  const stateResult = Object.hasOwn(options, "state") ? options.state : { status: "building" };
  const historyResult = Object.hasOwn(options, "history") ? options.history : history(0);
  const verdicts = [...(options.verdicts ?? [committedVerdict("verified", 1)])];
  const progressResults = [...(options.progressResults ?? [])];
  const recordResults = [...(options.recordResults ?? [])];
  const events = [];
  const labels = [];
  const progressPrompts = [];
  const recordPrompts = [];
  const invalidPrompts = [];
  const implementArguments = [];
  let verifyCalls = 0;

  const agent = async (prompt, agentOptions) => {
    labels.push(agentOptions.label);
    if (agentOptions.label === "loop-state") return stateResult;
    if (agentOptions.label.startsWith("queue-run-history:")) return historyResult;
    if (agentOptions.label.startsWith("progress-critic:")) {
      events.push("progress");
      progressPrompts.push(prompt);
      return progressResults.shift();
    }
    if (agentOptions.label.startsWith("record-progress-audit:")) {
      events.push("record-progress");
      recordPrompts.push(prompt);
      return recordResults.length > 0 ? recordResults.shift() : { done: true, committed: true };
    }
    if (agentOptions.label === "flip-invalid-loop") {
      events.push("invalid-loop");
      invalidPrompts.push(prompt);
      return { done: true };
    }
    throw new Error(`unexpected agent label ${agentOptions.label}`);
  };

  const workflow = async (name, workflowArguments) => {
    if (name === "implement-task") {
      events.push("implement");
      implementArguments.push(workflowArguments);
      return {
        claimed: true,
        taskId: historyResult?.taskId ?? "E9-T99",
      };
    }
    if (name === "verify-task") {
      events.push("verify");
      verifyCalls += 1;
      return verdicts.shift();
    }
    throw new Error(`unexpected workflow ${name}`);
  };

  const result = await runWorkflow(
    agent,
    workflow,
    async () => [],
    () => {},
    () => {},
    { total: 0, remaining: () => Number.POSITIVE_INFINITY },
    options.args ?? { tasks: 1 },
  );
  return {
    events,
    implementArguments,
    invalidPrompts,
    labels,
    progressPrompts,
    recordPrompts,
    result,
    verifyCalls,
  };
}

async function verifyPolicy(source) {
  let scenarios = 0;

  for (const invalidMaxRuns of [0, -2, 2.5, "3", Number.NaN, 11]) {
    const run = await execute(source, { args: { tasks: 1, maxRuns: invalidMaxRuns } });
    assert.equal(run.result.refused, "invalid maxRuns");
    assert.deepEqual(run.labels, []);
    assert.deepEqual(run.events, []);
    scenarios += 1;
  }
  {
    const run = await execute(source, { args: { tasks: 1, maxRetries: 2 } });
    assert.equal(run.result.refused, "unsupported maxRetries");
    assert.deepEqual(run.labels, []);
    assert.deepEqual(run.events, []);
    scenarios += 1;
  }

  for (const missingState of [undefined, {}]) {
    const run = await execute(source, { state: missingState, history: history(0) });
    assert.equal(run.result.refused, "unavailable");
    assert.deepEqual(run.labels, ["loop-state"]);
    assert.deepEqual(run.events, []);
    scenarios += 1;
  }

  for (const malformedHistory of [
    undefined,
    { ...history(2), runs: [runRecord(1), { ...runRecord(2), run: 3 }] },
    { ...history(2), runs: [runRecord(1), { ...runRecord(2), logEntry: "" }] },
    { ...history(3), progressAuditedThrough: 2 },
  ]) {
    const run = await execute(source, { history: malformedHistory });
    assert.equal(run.result.refused, "durable run history unavailable");
    assert.deepEqual(run.events, []);
    scenarios += 1;
  }

  {
    const run = await execute(source, {
      history: history(6, {
        taskId: "E2-T01",
        taskPath: ".eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model",
        status: "in-progress",
        progressAuditedThrough: 6,
      }),
      verdicts: [committedVerdict("verified", 7, { taskId: "E2-T01" })],
    });
    assert.equal(run.result.completed[0].runs, 7);
    assert.equal(run.result.completed[0].verdict, "verified");
    assert.equal(run.progressPrompts.length, 0);
    assert.equal(run.implementArguments[0].rework, true);
    assert.match(run.implementArguments[0].report, /complete-report-6/);
    scenarios += 1;
  }

  for (const checkpoint of [3, 6, 9]) {
    const run = await execute(source, {
      history: history(checkpoint, {
        status: "refuted",
        progressAuditedThrough: checkpoint - 3,
      }),
      progressResults: [structuredClone(citedProgress)],
      verdicts: [committedVerdict("verified", checkpoint + 1)],
    });
    assert.equal(run.result.completed[0].runs, checkpoint + 1);
    assert.deepEqual(run.events.slice(0, 4), [
      "progress",
      "record-progress",
      "implement",
      "verify",
    ]);
    assert.match(run.progressPrompts[0], new RegExp(`runs ${checkpoint - 2}-${checkpoint}`));
    for (let expected = checkpoint - 2; expected <= checkpoint; expected += 1) {
      assert.match(run.progressPrompts[0], new RegExp(`official-log-entry-${expected}`));
      assert.match(run.progressPrompts[0], new RegExp(`complete-report-${expected}`));
      assert.match(run.progressPrompts[0], new RegExp(`finding-${expected}`));
      assert.match(run.progressPrompts[0], new RegExp(`test-${expected}`));
    }
    if (checkpoint > 3) {
      assert.doesNotMatch(run.progressPrompts[0], /official-log-entry-1\b/);
    }
    assert.match(run.recordPrompts[0], new RegExp(`RUNS ${checkpoint - 2}-${checkpoint}`));
    scenarios += 1;
  }

  for (const rejectedProgress of [
    undefined,
    { ...citedProgress, rationale: "" },
    { ...citedProgress, evidence: [] },
    { ...citedProgress, nextFocus: [] },
    {
      assessment: "insufficient-evidence",
      rationale: "Window is incomplete.",
      evidence: ["missing report 2"],
      nextFocus: [],
    },
  ]) {
    const run = await execute(source, {
      history: history(3, { status: "refuted", progressAuditedThrough: 0 }),
      progressResults: [rejectedProgress],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.events.includes("implement"), false);
    assert.equal(run.events.includes("invalid-loop"), true);
    scenarios += 1;
  }

  {
    const run = await execute(source, {
      history: history(3, { status: "refuted", progressAuditedThrough: 0 }),
      progressResults: [structuredClone(citedProgress)],
      recordResults: [undefined],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.deepEqual(run.events, ["progress", "record-progress", "invalid-loop"]);
    scenarios += 1;
  }

  {
    const run = await execute(source, {
      history: history(9, { status: "refuted", progressAuditedThrough: 9 }),
      verdicts: [committedVerdict("refuted", 10)],
    });
    assert.equal(run.verifyCalls, 1);
    assert.equal(run.result.completed[0].runs, 10);
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.invalidPrompts.length, 1);
    scenarios += 1;
  }

  {
    const run = await execute(source, {
      history: history(9, { status: "refuted", progressAuditedThrough: 9 }),
      verdicts: [committedVerdict("verified", 10)],
    });
    assert.equal(run.verifyCalls, 1);
    assert.equal(run.result.completed[0].runs, 10);
    assert.equal(run.result.completed[0].verdict, "verified");
    assert.equal(run.invalidPrompts.length, 0);
    scenarios += 1;
  }

  {
    const run = await execute(source, {
      args: { tasks: 1, maxRuns: 2 },
      history: history(1, { status: "refuted" }),
      verdicts: [committedVerdict("refuted", 2)],
    });
    assert.equal(run.verifyCalls, 1);
    assert.equal(run.result.completed[0].runs, 2);
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  {
    const run = await execute(source, {
      args: { tasks: 1, maxRuns: 3 },
      history: history(3, { status: "refuted", progressAuditedThrough: 0 }),
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.events.includes("progress"), false);
    assert.equal(run.events.includes("record-progress"), false);
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  {
    const run = await execute(source, {
      history: history(6, { status: "implemented", progressAuditedThrough: 6 }),
      verdicts: [committedVerdict("verified", 7)],
    });
    assert.equal(run.events.includes("implement"), false);
    assert.equal(run.verifyCalls, 1);
    assert.equal(run.result.completed[0].runs, 7);
    scenarios += 1;
  }

  {
    const run = await execute(source, {
      verdicts: [committedVerdict("verified", 1, { committed: false })],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.result.completed[0].runs, 0);
    scenarios += 1;
  }

  {
    const run = await execute(source, {
      verdicts: [committedVerdict("verified", 1, { taskId: "E9-T98" })],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.result.completed[0].runs, 0);
    scenarios += 1;
  }

  {
    const run = await execute(source, {
      history: history(6, { status: "in-progress", progressAuditedThrough: 6 }),
      verdicts: [committedVerdict("verified", 7)],
    });
    assert.equal(
      run.labels.some((label) => label.startsWith("progress-critic:")),
      false,
    );
    assert.equal(run.result.completed[0].runs, 7);
    scenarios += 1;
  }

  return scenarios;
}

const scenarios = await verifyPolicy(workflowSource);
const mutations = [
  {
    name: "state-fail-open",
    from: "if (state?.status !== 'building') {",
    to: "if (state?.status && state.status !== 'building') {",
  },
  {
    name: "run-limit-fallback",
    from: "if (!Number.isInteger(configuredMaxRuns) || configuredMaxRuns < 1 || configuredMaxRuns > 10) {",
    to: "if (false) {",
  },
  {
    name: "history-reset",
    from: "const runs = [...gate.runs]",
    to: "const runs = []",
  },
  {
    name: "uncited-progress",
    from: "if (!validProgressAssessment(progress)) {",
    to: "if (progress?.assessment !== 'progressing') {",
  },
  {
    name: "uncommitted-progress",
    from: "if (recorded?.done !== true || recorded.committed !== true) {",
    to: "if (false) {",
  },
  {
    name: "uncommitted-verdict",
    from: "verdict?.committed === true &&",
    to: "true &&",
  },
  {
    name: "wrong-task-verdict",
    from: "verdict?.taskId === taskId &&",
    to: "true &&",
  },
];

for (const mutation of mutations) {
  const mutated = workflowSource.replace(mutation.from, mutation.to);
  assert.notEqual(mutated, workflowSource, `${mutation.name} mutation did not apply`);
  await assert.rejects(
    () => verifyPolicy(mutated),
    undefined,
    `${mutation.name} mutation unexpectedly survived the policy harness`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    mutations: mutations.map(({ name }) => name),
    scenarios,
    status: "WORK_QUEUE_POLICY_OK",
  })}\n`,
);
