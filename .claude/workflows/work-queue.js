export const meta = {
  name: 'work-queue',
  description: 'The full gauntlet, looped: implement the next task, adversarially verify it, audit progress every three failed runs, rework refutations, and advance the queue — honoring the .eforest project states',
  whenToUse: 'Run to burn down .eforest/tasks/QUEUE.md unattended. args {tasks: 3} selects a fixed task count (default 1); {maxRuns: 10} sets a lower verification-run ceiling, but never above 10. With a token budget set (+500k), loops until the budget runs low instead.',
  phases: [{ title: 'Gauntlet', detail: 'implement → verify → rework loop per task' }]
}

// This workflow IS .eforest/loop.md running. It must honor the project states: refuse to
// run unless status is "building", and flip to "invalid_loop" (loudly, committed) rather
// than push a task through dishonestly.

const STATE_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string' }, reason: { type: 'string' } }
}

const PROGRESS_SCHEMA = {
  type: 'object',
  required: ['assessment', 'rationale', 'evidence', 'nextFocus'],
  properties: {
    assessment: {
      type: 'string',
      enum: ['progressing', 'death-spiral', 'insufficient-evidence']
    },
    rationale: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    nextFocus: { type: 'array', items: { type: 'string' } }
  }
}

phase('Gauntlet')

const state = await agent('Read .eforest/project.json in this repo and report its "status" field verbatim (and "statusReason" as reason). Do not edit anything.', { label: 'loop-state', phase: 'Gauntlet', schema: STATE_SCHEMA, effort: 'low' })
if (state?.status && state.status !== 'building') {
  log(`loop refused: project status is "${state.status}" (${state.reason ?? 'no reason recorded'}) — only a human flips it back to building`)
  return { completed: [], refused: state.status }
}

const maxTasks = args?.tasks ?? (budget.total ? 1000 : 1)
const configuredMaxRuns = args?.maxRuns ?? (args?.maxRetries == null ? 10 : Number(args.maxRetries) + 1)
const maxRuns = Number.isInteger(configuredMaxRuns) && configuredMaxRuns > 0 ? Math.min(10, configuredMaxRuns) : 10
const completed = []

const roundRecord = (run, verdict) => ({
  run,
  verdict: verdict?.verdict ?? 'none',
  findings: verdict?.findings ?? [],
  promoted: verdict?.promoted ?? [],
  report: verdict?.report ?? '',
  logEntry: verdict?.logEntry ?? ''
})

const flipInvalid = async (reason) => {
  log(`INVALID_LOOP: ${reason}`)
  await agent(`Per .eforest/loop.md, the build loop can no longer make progress honestly. Edit .eforest/project.json: set status to "invalid_loop", statusReason to ${JSON.stringify(reason)}, and updatedAt to today's date. Run python3 tools/build_queue.py. Commit with message "loop: invalid_loop — ${reason}". This is a loud stop for a human; do not attempt any workaround.`, {
    label: 'flip-invalid-loop',
    phase: 'Gauntlet',
    schema: { type: 'object', required: ['done'], properties: { done: { type: 'boolean' } } },
    effort: 'low'
  })
}

for (let i = 0; i < maxTasks; i++) {
  if (budget.total && budget.remaining() < 150_000) {
    log(`stopping: ~${Math.round(budget.remaining() / 1000)}k tokens left is not enough for a full gauntlet pass`)
    break
  }

  const impl = await workflow('implement-task', {})
  if (!impl?.claimed) {
    log(`queue halted: ${impl?.reason ?? 'implement-task returned nothing'}`)
    if (impl?.reason === 'gate audits failed') {
      await flipInvalid(`${impl.taskId}: gates cannot be made green honestly after 3 fixer rounds`)
    }
    break
  }

  let verdict = await workflow('verify-task', { task: impl.taskId })
  const runs = [roundRecord(1, verdict)]
  const progressAudits = []
  while (verdict?.verdict !== 'verified') {
    const run = runs.length

    if (run % 3 === 0) {
      const window = runs.slice(-3)
      const firstRun = window[0].run
      const progress = await agent(
        `You are the independent PROGRESS CRITIC defined by AGENTS.md and .eforest/loop.md. You are a fresh read-only session: do not edit files, fix code, or re-judge any single acceptance criterion in isolation.

Task: ${impl.taskId}. Audit complete verification runs ${firstRun}-${run} below against the task readme and the commits/evidence those reports cite:
${JSON.stringify(window, null, 2)}

Decide whether these three runs demonstrate genuine convergence or a death spiral. Genuine progress requires concrete evidence that earlier findings were closed or meaningfully narrowed by a general invariant, permanent tests/evidence compounded, new failures moved to deeper or more compositional cases, and previously surviving behavior did not regress. A renamed finding, a sequence of one-off path/type exceptions, a repeated counterexample, weakened gates/evidence, or regression is a death spiral. Cite the report, diff, test, fixture, digest, or command behind every evidence item. If the three reports do not contain enough comparable evidence, choose insufficient-evidence; uncertainty never earns another run. Return nextFocus only when progressing.`,
        {
          label: `progress-critic:${impl.taskId}:runs-${firstRun}-${run}`,
          phase: 'Gauntlet',
          schema: PROGRESS_SCHEMA,
          effort: 'xhigh'
        }
      )
      progressAudits.push({ runs: `${firstRun}-${run}`, ...progress })
      if (progress?.assessment !== 'progressing') {
        const assessment = progress?.assessment ?? 'no-result'
        await flipInvalid(`${impl.taskId}: progress audit for runs ${firstRun}-${run} returned ${assessment}: ${progress?.rationale ?? 'no rationale'}`)
        completed.push({
          taskId: impl.taskId,
          verdict: 'invalid_loop',
          runs: run,
          reworks: run - 1,
          progressAudits
        })
        return { completed }
      }
      log(`${impl.taskId} progress audit ${firstRun}-${run}: progressing — next window earned`)
    }

    if (run >= maxRuns) {
      await flipInvalid(`${impl.taskId}: not verified after ${run} verification run(s); hard ceiling is ${maxRuns}`)
      completed.push({
        taskId: impl.taskId,
        verdict: 'invalid_loop',
        runs: run,
        reworks: run - 1,
        progressAudits
      })
      return { completed }
    }

    const nextRun = run + 1
    log(`${impl.taskId} ${verdict?.verdict}; preparing verification run ${nextRun}/${maxRuns}`)
    const rework = await workflow('implement-task', {
      task: impl.taskId,
      rework: true,
      report: verdict?.report ?? ''
    })
    if (!rework?.claimed) {
      await flipInvalid(`${impl.taskId}: rework failed to produce a claim for verification run ${nextRun}`)
      completed.push({
        taskId: impl.taskId,
        verdict: 'invalid_loop',
        runs: run,
        reworks: run - 1,
        progressAudits
      })
      return { completed }
    }
    verdict = await workflow('verify-task', { task: impl.taskId })
    runs.push(roundRecord(nextRun, verdict))
  }

  completed.push({
    taskId: impl.taskId,
    verdict: verdict.verdict,
    runs: runs.length,
    reworks: runs.length - 1,
    progressAudits
  })
  log(`${impl.taskId} VERIFIED (${runs.length} verification run(s), ${runs.length - 1} rework(s)); queue advances`)
}

return { completed }
