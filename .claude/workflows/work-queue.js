export const meta = {
  name: 'work-queue',
  description: 'The full gauntlet, looped: reconstruct durable task history, implement the next task, adversarially verify it, audit progress every three failed runs, rework refutations, and advance the queue — honoring the .eforest project states',
  whenToUse: 'Run to burn down .eforest/tasks/QUEUE.md unattended. args {tasks: 3} selects a fixed task count (default 1); {maxRuns: 10} sets an integer verification-run ceiling from 1 through 10. Invalid limits are refused before work starts. With a token budget set (+500k), loops until the budget runs low instead.',
  phases: [{ title: 'Gauntlet', detail: 'durable history → implement → verify → progress audit → rework' }]
}

// This workflow IS .eforest/loop.md running. It must fail closed unless project state,
// task-global committed run history, run limits, critic verdicts, and progress evidence
// are complete. A process restart must never reset checkpoint windows or the hard ceiling.

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

const GATE_HISTORY_SCHEMA = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    reason: { type: 'string' },
    taskId: { type: 'string' },
    taskPath: { type: 'string' },
    status: { type: 'string' },
    progressAuditedThrough: { type: 'integer' },
    runs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['run', 'verdict', 'findings', 'promoted', 'report', 'logEntry'],
        properties: {
          run: { type: 'integer' },
          verdict: { type: 'string', enum: ['verified', 'refuted', 'needs-evidence'] },
          findings: { type: 'array', items: { type: 'string' } },
          promoted: { type: 'array', items: { type: 'string' } },
          report: { type: 'string' },
          logEntry: { type: 'string' }
        }
      }
    }
  }
}

const PROGRESS_RECORD_SCHEMA = {
  type: 'object',
  required: ['done', 'committed'],
  properties: {
    done: { type: 'boolean' },
    committed: { type: 'boolean' }
  }
}

phase('Gauntlet')

const configuredMaxRuns = args?.maxRuns ?? 10
if (Object.prototype.hasOwnProperty.call(args ?? {}, 'maxRetries')) {
  log('loop refused: maxRetries is no longer supported; use integer maxRuns in [1,10]')
  return { completed: [], refused: 'unsupported maxRetries' }
}
if (!Number.isInteger(configuredMaxRuns) || configuredMaxRuns < 1 || configuredMaxRuns > 10) {
  log(`loop refused: maxRuns must be an integer in [1,10], received ${JSON.stringify(configuredMaxRuns)}`)
  return { completed: [], refused: 'invalid maxRuns' }
}

const maxTasks = args?.tasks ?? (budget.total ? 1000 : 1)
if (!Number.isInteger(maxTasks) || maxTasks < 1) {
  log(`loop refused: tasks must be a positive integer, received ${JSON.stringify(maxTasks)}`)
  return { completed: [], refused: 'invalid tasks' }
}

const state = await agent(
  'Read .eforest/project.json in this repo and report its "status" field verbatim (and "statusReason" as reason). Do not edit anything.',
  { label: 'loop-state', phase: 'Gauntlet', schema: STATE_SCHEMA, effort: 'low' }
)
if (state?.status !== 'building') {
  const observed = state?.status ?? 'unavailable'
  log(`loop refused: project status is "${observed}" (${state?.reason ?? 'no reason recorded'}) — exact status "building" is required`)
  return { completed: [], refused: observed }
}

const completed = []
const validVerdicts = new Set(['verified', 'refuted', 'needs-evidence'])
const activeStatuses = new Set(['pending', 'in-progress', 'implemented', 'refuted'])
const hasText = (value) => typeof value === 'string' && value.trim().length > 0

const validHistory = (history) => {
  if (!history?.ok || !hasText(history.taskId) || !hasText(history.taskPath)) return false
  if (!activeStatuses.has(history.status) || !Array.isArray(history.runs)) return false
  if (!Number.isInteger(history.progressAuditedThrough)) return false
  if (history.progressAuditedThrough < 0 || history.progressAuditedThrough > history.runs.length) return false
  if (history.progressAuditedThrough % 3 !== 0) return false
  return history.runs.every(
    (run, index) =>
      run?.run === index + 1 &&
      validVerdicts.has(run.verdict) &&
      run.verdict !== 'verified' &&
      Array.isArray(run.findings) &&
      run.findings.every(hasText) &&
      Array.isArray(run.promoted) &&
      run.promoted.every(hasText) &&
      typeof run.report === 'string' &&
      hasText(run.logEntry)
  )
}

const roundRecord = (run, verdict) => ({
  run,
  verdict: verdict?.verdict ?? 'none',
  findings: (verdict?.findings ?? []).map((finding) => (typeof finding === 'string' ? finding : JSON.stringify(finding))),
  promoted: (verdict?.promoted ?? []).filter(hasText),
  report: hasText(verdict?.report) ? verdict.report : verdict?.logEntry ?? '',
  logEntry: verdict?.logEntry ?? ''
})

const validCurrentVerdict = (record, verdict, taskId) =>
  verdict?.taskId === taskId &&
  verdict?.committed === true &&
  validVerdicts.has(record.verdict) &&
  record.findings.every(hasText) &&
  record.promoted.every(hasText) &&
  hasText(record.logEntry)

const validProgressAssessment = (progress) =>
  progress?.assessment === 'progressing' &&
  hasText(progress.rationale) &&
  Array.isArray(progress.evidence) &&
  progress.evidence.length > 0 &&
  progress.evidence.every(hasText) &&
  Array.isArray(progress.nextFocus) &&
  progress.nextFocus.length > 0 &&
  progress.nextFocus.every(hasText)

const flipInvalid = async (reason) => {
  log(`INVALID_LOOP: ${reason}`)
  await agent(
    `Per .eforest/loop.md, the build loop can no longer make progress honestly. Edit .eforest/project.json: set status to "invalid_loop", statusReason to ${JSON.stringify(reason)}, and updatedAt to today's date. Run python3 tools/build_queue.py. Commit with message "loop: invalid_loop — ${reason}". This is a loud stop for a human; do not attempt any workaround.`,
    {
      label: 'flip-invalid-loop',
      phase: 'Gauntlet',
      schema: { type: 'object', required: ['done'], properties: { done: { type: 'boolean' } } },
      effort: 'low'
    }
  )
}

for (let i = 0; i < maxTasks; i++) {
  if (budget.total && budget.remaining() < 150_000) {
    log(`stopping: ~${Math.round(budget.remaining() / 1000)}k tokens left is not enough for a full gauntlet pass`)
    break
  }

  const gate = await agent(
    `Read .eforest/tasks/QUEUE.md and the current gate task's readme.md. Do not edit anything. Return the current gate task id/path/status plus its DURABLE verification history from committed evidence.

Count exactly one run for each official critic/judge VERDICT entry, oldest first; builder claims and progress-critic entries are not runs. Number them monotonically from 1. For every run copy the complete official verdict entry verbatim into logEntry, use that same full text as report when no separate report exists, extract every finding bullet as a non-empty string, and list any promoted permanent artifacts as non-empty strings. progressAuditedThrough is the greatest ending run N in an official "progress critic — RUNS X-N" entry, or 0. Return ok:false if the queue has no current gate or if any run/audit cannot be reconstructed completely; never guess or omit a run.`,
    {
      label: `queue-run-history:${i + 1}`,
      phase: 'Gauntlet',
      schema: GATE_HISTORY_SCHEMA,
      effort: 'high'
    }
  )
  if (!validHistory(gate)) {
    log(`queue halted: durable run history unavailable or malformed (${gate?.reason ?? 'no complete result'})`)
    return { completed, refused: 'durable run history unavailable' }
  }

  const taskId = gate.taskId
  const taskPath = gate.taskPath
  const runs = [...gate.runs]
  const progressAudits = []

  const auditCheckpoint = async () => {
    const run = runs.length
    if (run === 0 || run % 3 !== 0 || gate.progressAuditedThrough >= run) return true

    const window = runs.slice(-3)
    const firstRun = window[0].run
    const progress = await agent(
      `You are the independent PROGRESS CRITIC defined by AGENTS.md and .eforest/loop.md. You are a fresh read-only session: do not edit files, fix code, or re-judge any single acceptance criterion in isolation.

Task: ${taskId}. Audit complete durable verification runs ${firstRun}-${run} below against ${taskPath}/readme.md and the commits/evidence those reports cite:
${JSON.stringify(window, null, 2)}

Decide whether these three runs demonstrate genuine convergence or a death spiral. Genuine progress requires concrete evidence that earlier findings were closed or meaningfully narrowed by a general invariant, permanent tests/evidence compounded, new failures moved to deeper or more compositional cases, and previously surviving behavior did not regress. A renamed finding, a sequence of one-off exceptions, a repeated counterexample, weakened gates/evidence, or regression is a death spiral. Every evidence item must cite a report, diff, test, fixture, digest, or command. If the reports do not contain enough comparable evidence, choose insufficient-evidence; uncertainty never earns another run. A progressing assessment must include a non-empty rationale, at least one concrete evidence citation, and at least one actionable next focus.`,
      {
        label: `progress-critic:${taskId}:runs-${firstRun}-${run}`,
        phase: 'Gauntlet',
        schema: PROGRESS_SCHEMA,
        effort: 'xhigh'
      }
    )
    progressAudits.push({ runs: `${firstRun}-${run}`, ...progress })
    if (!validProgressAssessment(progress)) {
      const assessment = progress?.assessment ?? 'no-result'
      await flipInvalid(`${taskId}: progress audit for runs ${firstRun}-${run} returned ${assessment} without complete cited proof: ${progress?.rationale ?? 'no rationale'}`)
      return false
    }

    const recorded = await agent(
      `Persist this accepted progress audit before any rework begins. In ${taskPath}/readme.md append a "progress critic — RUNS ${firstRun}-${run}: progressing" Verification log entry containing this exact rationale, every evidence item, and every next-focus item: ${JSON.stringify(progress)}. If the task is refuted, set its status to in-progress. Run python3 tools/build_queue.py and commit only the task log/status and generated queue with message "tasks: earn ${taskId} run ${run + 1}". Do not edit implementation or project state.`,
      {
        label: `record-progress-audit:${taskId}:runs-${firstRun}-${run}`,
        phase: 'Gauntlet',
        schema: PROGRESS_RECORD_SCHEMA,
        effort: 'low'
      }
    )
    if (recorded?.done !== true || recorded.committed !== true) {
      await flipInvalid(`${taskId}: progressing audit for runs ${firstRun}-${run} was not durably committed`)
      return false
    }
    gate.progressAuditedThrough = run
    gate.status = 'in-progress'
    log(`${taskId} progress audit ${firstRun}-${run}: progressing — durable next window earned`)
    return true
  }

  if (runs.length >= configuredMaxRuns) {
    await flipInvalid(`${taskId}: not verified after ${runs.length} verification run(s); hard ceiling is ${configuredMaxRuns}`)
    completed.push({ taskId, verdict: 'invalid_loop', runs: runs.length, reworks: Math.max(0, runs.length - 1), progressAudits })
    return { completed }
  }
  if (!(await auditCheckpoint())) {
    completed.push({ taskId, verdict: 'invalid_loop', runs: runs.length, reworks: Math.max(0, runs.length - 1), progressAudits })
    return { completed }
  }

  let impl
  if (gate.status === 'implemented') {
    impl = { claimed: true, taskId }
  } else {
    impl = await workflow('implement-task', {
      task: taskId,
      ...(runs.length > 0 ? { rework: true, report: runs.at(-1)?.report ?? '' } : {})
    })
  }
  if (!impl?.claimed || impl.taskId !== taskId) {
    log(`queue halted: ${impl?.reason ?? 'implement-task returned no matching claim'}`)
    if (impl?.reason === 'gate audits failed') {
      await flipInvalid(`${taskId}: gates cannot be made green honestly after 3 fixer rounds`)
    }
    break
  }

  let verdict = await workflow('verify-task', { task: taskId })
  let record = roundRecord(runs.length + 1, verdict)
  if (!validCurrentVerdict(record, verdict, taskId)) {
    await flipInvalid(`${taskId}: verify-task returned no complete committed verdict for run ${runs.length + 1}`)
    completed.push({ taskId, verdict: 'invalid_loop', runs: runs.length, reworks: Math.max(0, runs.length - 1), progressAudits })
    return { completed }
  }
  runs.push(record)

  while (verdict.verdict !== 'verified') {
    const run = runs.length
    if (run >= configuredMaxRuns) {
      await flipInvalid(`${taskId}: not verified after ${run} verification run(s); hard ceiling is ${configuredMaxRuns}`)
      completed.push({ taskId, verdict: 'invalid_loop', runs: run, reworks: run - 1, progressAudits })
      return { completed }
    }
    if (!(await auditCheckpoint())) {
      completed.push({ taskId, verdict: 'invalid_loop', runs: run, reworks: run - 1, progressAudits })
      return { completed }
    }

    const nextRun = run + 1
    log(`${taskId} ${verdict.verdict}; preparing verification run ${nextRun}/${configuredMaxRuns}`)
    const rework = await workflow('implement-task', {
      task: taskId,
      rework: true,
      report: verdict.report ?? ''
    })
    if (!rework?.claimed || rework.taskId !== taskId) {
      await flipInvalid(`${taskId}: rework failed to produce a matching claim for verification run ${nextRun}`)
      completed.push({ taskId, verdict: 'invalid_loop', runs: run, reworks: run - 1, progressAudits })
      return { completed }
    }

    verdict = await workflow('verify-task', { task: taskId })
    record = roundRecord(nextRun, verdict)
    if (!validCurrentVerdict(record, verdict, taskId)) {
      await flipInvalid(`${taskId}: verify-task returned no complete committed verdict for run ${nextRun}`)
      completed.push({ taskId, verdict: 'invalid_loop', runs: run, reworks: run - 1, progressAudits })
      return { completed }
    }
    runs.push(record)
  }

  completed.push({
    taskId,
    verdict: verdict.verdict,
    runs: runs.length,
    reworks: runs.length - 1,
    progressAudits
  })
  log(`${taskId} VERIFIED (${runs.length} verification run(s), ${runs.length - 1} rework(s)); queue advances`)
}

return { completed }
