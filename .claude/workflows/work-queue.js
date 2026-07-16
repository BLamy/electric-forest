export const meta = {
  name: 'work-queue',
  description: 'The full gauntlet, looped: independently attest a commit-bound task ledger, implement, verify, audit progress every three failed runs, rework, and advance',
  whenToUse: 'Run to burn down .eforest/tasks/QUEUE.md unattended. args {tasks: 3} selects a fixed task count (default 1); {maxRuns: 10} sets an integer verification-run ceiling from 1 through 10. Invalid limits are refused before work starts.',
  phases: [{ title: 'Gauntlet', detail: 'commit snapshot → implement → verify → post-commit snapshot → progress audit → rework' }]
}

// The workflow runtime orchestrates agents but does not expose a shell primitive. Every
// control decision therefore consumes the byte-identical stdout of TWO fresh readers.
// Each reader pipes the snapshot CLI itself from a trusted commit, and that CLI imports its
// parser from the same commit while reading queue/project/task bytes from the source commit
// being inspected. Writers are trusted only after the PRE-WRITE attester observes the new
// commit, its exact changed-path set, immutable prior-ledger prefix, control-source digest,
// status, and queue identity.

const SNAPSHOT_SCHEMA = {
  type: 'object',
  required: ['snapshot'],
  properties: { snapshot: { type: 'string' } }
}

const COMMIT_SCHEMA = {
  type: 'object',
  required: ['baseCommit', 'commitOid'],
  properties: {
    baseCommit: { type: 'string' },
    commitOid: { type: 'string' }
  }
}

const PROGRESS_SCHEMA = {
  type: 'object',
  required: ['assessment', 'rationale', 'evidence', 'nextFocus'],
  properties: {
    assessment: { type: 'string', enum: ['progressing', 'death-spiral', 'insufficient-evidence'] },
    rationale: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'ref', 'supports'],
        properties: {
          kind: { type: 'string', enum: ['report', 'diff', 'test', 'fixture', 'digest', 'command'] },
          ref: { type: 'string' },
          supports: { type: 'string' }
        }
      }
    },
    nextFocus: { type: 'array', items: { type: 'string' } }
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

const OID = /^[0-9a-f]{40}$/
const DIGEST = /^[0-9a-f]{64}$/
const TASK = /^E\d+-T\d+$/
const SNAPSHOT_SCRIPT = 'packages/identity/scripts/work-queue-snapshot.mjs'
const QUEUE_PATH = '.eforest/tasks/QUEUE.md'
const activeStatuses = new Set(['pending', 'in-progress', 'implemented', 'refuted'])
const validVerdicts = new Set(['verified', 'refuted', 'needs-evidence'])
const hasText = (value) => typeof value === 'string' && value.trim().length > 0
const validTaskPath = (taskId, taskPath) => {
  const epic = /^E(\d+)-T\d+$/.exec(taskId)?.[1]
  return (
    epic !== undefined &&
    typeof taskPath === 'string' &&
    new RegExp(`^\\.eforest/tasks/epic-${epic}[^/]*/${taskId}(?:-[^/]+)?/readme\\.md$`).test(taskPath)
  )
}

const readSnapshot = async (label, taskId, attesterCommit = 'HEAD', transitionBaseCommit = null) => {
  if (attesterCommit !== 'HEAD' && !OID.test(attesterCommit)) return null
  if (transitionBaseCommit !== null && !OID.test(transitionBaseCommit)) return null
  if (taskId && !TASK.test(taskId)) return null
  const command = `git show ${attesterCommit}:${SNAPSHOT_SCRIPT} | node --input-type=module - --attester ${attesterCommit} --source HEAD${transitionBaseCommit ? ` --base ${transitionBaseCommit}` : ''}${taskId ? ` --task ${taskId}` : ''}`
  const prompt = `You are one of two independent read-only ledger readers. From the repository root run exactly:\n${command}\nDo not edit, checkout, fetch, commit, or run any other command. Return the command's one-line stdout byte-for-byte in snapshot. If the command fails, return no result; never reconstruct or repair its JSON yourself.`
  const readers = await parallel(
    ['a', 'b'].map((reader) => () =>
      agent(prompt, {
        label: `queue-snapshot:${label}:${reader}`,
        phase: 'Gauntlet',
        schema: SNAPSHOT_SCHEMA,
        effort: 'low'
      })
    )
  )
  if (!readers[0]?.snapshot || readers[0].snapshot !== readers[1]?.snapshot) return null
  try {
    return JSON.parse(readers[0].snapshot.trim())
  } catch {
    return null
  }
}

const validRun = (run, expected) =>
  run?.run === expected &&
  validVerdicts.has(run.verdict) &&
  Array.isArray(run.findings) &&
  run.findings.length > 0 &&
  run.findings.every(hasText) &&
  Array.isArray(run.promoted) &&
  run.promoted.every(hasText) &&
  hasText(run.report) &&
  hasText(run.logEntry) &&
  DIGEST.test(run.entryDigest)

const validSnapshot = (
  snapshot,
  { taskId, requireCurrent = true, allowComplete = false, expectedAttester = null, expectedBase = null } = {}
) => {
  if (snapshot?.schemaVersion !== 2 || !OID.test(snapshot.sourceCommit)) return false
  if (!OID.test(snapshot.attesterSourceCommit) || !DIGEST.test(snapshot.attesterDigest)) return false
  if (!DIGEST.test(snapshot.controlDigest)) return false
  if (expectedAttester === null) {
    if (snapshot.attesterSourceCommit !== snapshot.sourceCommit) return false
  } else if (snapshot.attesterSourceCommit !== expectedAttester) return false
  if (snapshot.transitionBaseCommit !== expectedBase) return false
  if (!Array.isArray(snapshot.changedPaths) || snapshot.changedPaths.some((path) => !hasText(path))) return false
  if (JSON.stringify(snapshot.changedPaths) !== JSON.stringify([...snapshot.changedPaths].sort())) return false
  if (!DIGEST.test(snapshot.projectDigest) || !DIGEST.test(snapshot.queueDigest)) return false
  if (snapshot.projectStatus !== 'building' && !(allowComplete && snapshot.projectStatus === 'complete')) return false
  if (!taskId && snapshot.taskId === null && snapshot.currentGateTaskId === null) return snapshot.projectStatus === 'complete'
  if (!TASK.test(snapshot.taskId) || snapshot.taskId !== taskId) return false
  if (requireCurrent && snapshot.currentGateTaskId !== taskId) return false
  if (!validTaskPath(taskId, snapshot.taskPath)) return false
  if (!DIGEST.test(snapshot.taskDigest) || !Number.isInteger(snapshot.runCount) || snapshot.runCount < 0 || snapshot.runCount > 10) return false
  if (!DIGEST.test(snapshot.ledgerDigest)) return false
  if (!Array.isArray(snapshot.runEntryDigests) || snapshot.runEntryDigests.length !== snapshot.runCount) return false
  if (snapshot.runEntryDigests.some((value) => !DIGEST.test(value))) return false
  if (!Array.isArray(snapshot.auditEntryDigests) || snapshot.auditEntryDigests.some((value) => !DIGEST.test(value))) return false
  if (!Number.isInteger(snapshot.progressAuditedThrough) || snapshot.progressAuditedThrough < 0) return false
  if (!Array.isArray(snapshot.runs) || snapshot.runs.length !== Math.min(3, snapshot.runCount)) return false
  const firstRun = snapshot.runCount - snapshot.runs.length + 1
  if (!snapshot.runs.every((run, index) => validRun(run, firstRun + index))) return false
  if (!snapshot.runs.every((run) => snapshot.runEntryDigests[run.run - 1] === run.entryDigest)) return false

  if (snapshot.auditStart !== (taskId === 'E2-T01' ? 6 : 3)) return false
  if (!Array.isArray(snapshot.auditEnds) || snapshot.auditEnds.some((value) => !Number.isInteger(value))) return false
  if (snapshot.auditEntryDigests.length !== snapshot.auditEnds.length) return false
  const expectedAuditEnds = []
  for (let checkpoint = snapshot.auditStart; checkpoint <= snapshot.progressAuditedThrough; checkpoint += 3) {
    expectedAuditEnds.push(checkpoint)
  }
  if (JSON.stringify(snapshot.auditEnds) !== JSON.stringify(expectedAuditEnds)) return false
  const priorCheckpoint = Math.floor((snapshot.runCount - 1) / 3) * 3
  const possibleCheckpoint = Math.floor(snapshot.runCount / 3) * 3
  const requiredPriorCheckpoint = priorCheckpoint >= snapshot.auditStart ? priorCheckpoint : 0
  const latestPossibleCheckpoint = possibleCheckpoint >= snapshot.auditStart ? possibleCheckpoint : 0
  if (snapshot.progressAuditedThrough < requiredPriorCheckpoint || snapshot.progressAuditedThrough > latestPossibleCheckpoint) return false
  if (snapshot.progressAuditedThrough === 0) {
    if (snapshot.latestAudit !== null) return false
  } else if (
    snapshot.latestAudit?.lastRun !== snapshot.progressAuditedThrough ||
    snapshot.latestAudit.lastRun - snapshot.latestAudit.firstRun !== 2 ||
    !hasText(snapshot.latestAudit.entry) ||
    !DIGEST.test(snapshot.latestAudit.entryDigest) ||
    snapshot.auditEntryDigests.at(-1) !== snapshot.latestAudit.entryDigest
  ) {
    return false
  }

  if (snapshot.status === 'pending' && snapshot.runCount !== 0) return false
  if (snapshot.status === 'refuted' && snapshot.runCount === 0) return false
  if (snapshot.status === 'verified') {
    if (snapshot.runCount === 0 || snapshot.runs.at(-1)?.verdict !== 'verified') return false
  } else {
    if (!activeStatuses.has(snapshot.status) || snapshot.runs.some((run) => run.verdict === 'verified')) return false
  }
  if (
    !Array.isArray(snapshot.evidenceCatalog) ||
    snapshot.evidenceCatalog.some(
      (item) =>
        !['report', 'diff', 'test', 'fixture', 'digest', 'command'].includes(item?.kind) ||
        !hasText(item?.ref)
    )
  ) return false
  return true
}

const validEvidence = (item, snapshot) => {
  if (!hasText(item?.supports) || !hasText(item?.ref)) return false
  return snapshot.evidenceCatalog.some(
    (candidate) => candidate.kind === item.kind && candidate.ref === item.ref
  )
}

const validProgress = (progress, snapshot) =>
  progress?.assessment === 'progressing' &&
  hasText(progress.rationale) &&
  Array.isArray(progress.evidence) &&
  progress.evidence.length > 0 &&
  progress.evidence.every((item) => validEvidence(item, snapshot)) &&
  Array.isArray(progress.nextFocus) &&
  progress.nextFocus.length > 0 &&
  progress.nextFocus.every(hasText)

const sameLedger = (before, after) =>
  before.taskId === after.taskId &&
  before.taskPath === after.taskPath &&
  before.runCount === after.runCount &&
  before.progressAuditedThrough === after.progressAuditedThrough &&
  before.auditStart === after.auditStart &&
  before.attesterDigest === after.attesterDigest &&
  before.controlDigest === after.controlDigest &&
  before.ledgerDigest === after.ledgerDigest &&
  JSON.stringify(before.runEntryDigests) === JSON.stringify(after.runEntryDigests) &&
  JSON.stringify(before.auditEnds) === JSON.stringify(after.auditEnds) &&
  JSON.stringify(before.auditEntryDigests) === JSON.stringify(after.auditEntryDigests)

const samePrefix = (before, after, field, appended) =>
  after[field].length === before[field].length + appended &&
  before[field].every((value, index) => after[field][index] === value)

const onlyChanged = (snapshot, allowed) =>
  snapshot.changedPaths.every((path) => allowed.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)))

const observedCommit = (claim, before, after) =>
  OID.test(claim?.baseCommit) &&
  OID.test(claim?.commitOid) &&
  claim.baseCommit === before.sourceCommit &&
  claim.commitOid === after.sourceCommit &&
  after.sourceCommit !== before.sourceCommit &&
  after.attesterSourceCommit === before.sourceCommit &&
  after.transitionBaseCommit === before.sourceCommit

const flipInvalid = async (reason) => {
  log(`INVALID_LOOP: ${reason}`)
  await agent(
    `Per .eforest/loop.md, the loop can no longer progress honestly. Set .eforest/project.json status to "invalid_loop", record this exact statusReason: ${JSON.stringify(reason)}, update updatedAt, run python3 tools/build_queue.py, and commit. Do not weaken or route around the stop.`,
    {
      label: 'flip-invalid-loop',
      phase: 'Gauntlet',
      schema: { type: 'object', required: ['done'], properties: { done: { type: 'boolean' } } },
      effort: 'low'
    }
  )
}

const completed = []
for (let taskIndex = 0; taskIndex < maxTasks; taskIndex += 1) {
  if (budget.total && budget.remaining() < 10000) {
    log('budget low — stopping before next task')
    break
  }

  let snapshot = await readSnapshot(`gate-${taskIndex + 1}`)
  if (snapshot?.taskId === null && snapshot.currentGateTaskId === null && snapshot.projectStatus === 'complete') break
  const taskId = snapshot?.taskId
  if (!validSnapshot(snapshot, { taskId, requireCurrent: true })) {
    log('queue halted: two fresh readers could not attest one valid committed gate snapshot')
    return { completed, refused: 'invalid committed gate snapshot' }
  }
  const initialRunCount = snapshot.runCount
  const progressAudits = []

  const auditCheckpoint = async () => {
    const run = snapshot.runCount
    if (run === 0 || run % 3 !== 0 || snapshot.progressAuditedThrough === run) return true
    const window = snapshot.runs
    if (window.length !== 3 || window[0].run !== run - 2 || window[2].run !== run) return false
    const firstRun = run - 2
    const progress = await agent(
      `You are the independent PROGRESS CRITIC defined by AGENTS.md and .eforest/loop.md. You are a fresh read-only session and never implemented or judged this task. Audit the COMPLETE commit-bound official reports for ${taskId} runs ${firstRun}-${run}:\n${JSON.stringify(window, null, 2)}\n\nDecide convergence versus death spiral. Progress requires cited closure/narrowing of earlier findings through general invariants, compounding permanent evidence, deeper new attacks, and no regression. Every evidence kind/ref MUST be selected byte-for-byte from this catalog already resolved at commit ${snapshot.sourceCommit}:\n${JSON.stringify(snapshot.evidenceCatalog, null, 2)}\nThe supports field states what the selected ref proves. Uncertainty is insufficient-evidence and stops.`,
      {
        label: `progress-critic:${taskId}:runs-${firstRun}-${run}`,
        phase: 'Gauntlet',
        schema: PROGRESS_SCHEMA,
        effort: 'xhigh'
      }
    )
    progressAudits.push({ runs: `${firstRun}-${run}`, ...progress })
    if (!validProgress(progress, snapshot)) {
      await flipInvalid(`${taskId}: progress audit ${firstRun}-${run} lacked complete resolvable proof`)
      return false
    }

    const committed = await agent(
      `Persist this accepted audit before any rework. Base commit must be ${snapshot.sourceCommit}. In ${snapshot.taskPath} append the exact heading "### YYYY-MM-DD — progress critic — RUNS ${firstRun}-${run}: progressing" followed by these top-level bullets: "- Rationale: <exact rationale>", one "- Evidence (<kind>): <ref> — <supports>" for every item, one "- Next focus: <exact value>" for every value, and "- Assessment: progressing". Values: ${JSON.stringify(progress)}. Set status in-progress, run python3 tools/build_queue.py, commit only task record and queue, then return the full baseCommit and new commitOid from git.`,
      {
        label: `record-progress-audit:${taskId}:runs-${firstRun}-${run}`,
        phase: 'Gauntlet',
        schema: COMMIT_SCHEMA,
        effort: 'low'
      }
    )
    const after = await readSnapshot(
      `audit-${taskId}-${run}`,
      taskId,
      snapshot.sourceCommit,
      snapshot.sourceCommit
    )
    const auditEntry = after?.latestAudit?.entry ?? ''
    const progressPersisted =
      validSnapshot(after, {
        taskId,
        requireCurrent: true,
        expectedAttester: snapshot.sourceCommit,
        expectedBase: snapshot.sourceCommit
      }) &&
      observedCommit(committed, snapshot, after) &&
      after.attesterDigest === snapshot.attesterDigest &&
      after.controlDigest === snapshot.controlDigest &&
      after.runCount === run &&
      JSON.stringify(after.runEntryDigests) === JSON.stringify(snapshot.runEntryDigests) &&
      samePrefix(snapshot, after, 'auditEntryDigests', 1) &&
      after.progressAuditedThrough === run &&
      after.status === 'in-progress' &&
      onlyChanged(after, [snapshot.taskPath, QUEUE_PATH]) &&
      auditEntry.includes(progress.rationale) &&
      progress.evidence.every((item) => auditEntry.includes(item.ref) && auditEntry.includes(item.supports)) &&
      progress.nextFocus.every((focus) => auditEntry.includes(focus))
    if (!progressPersisted) {
      await flipInvalid(`${taskId}: progress audit ${firstRun}-${run} was not independently observed at its claimed commit`)
      return false
    }
    snapshot = after
    return true
  }

  if (snapshot.runCount >= configuredMaxRuns) {
    await flipInvalid(`${taskId}: not verified after ${snapshot.runCount} run(s); hard ceiling is ${configuredMaxRuns}`)
    completed.push({ taskId, verdict: 'invalid_loop', runs: snapshot.runCount, progressAudits })
    return { completed }
  }
  if (!(await auditCheckpoint())) {
    completed.push({ taskId, verdict: 'invalid_loop', runs: snapshot.runCount, progressAudits })
    return { completed }
  }

  const implement = async (report = '') => {
    if (snapshot.status === 'implemented') return true
    const before = snapshot
    const result = await workflow('implement-task', {
      task: taskId,
      ...(before.runCount > 0 ? { rework: true, report } : {})
    })
    if (!result?.claimed || result.taskId !== taskId) return false
    const after = await readSnapshot(
      `implemented-${taskId}-${before.runCount + 1}`,
      taskId,
      before.sourceCommit,
      before.sourceCommit
    )
    if (
      !validSnapshot(after, {
        taskId,
        requireCurrent: true,
        expectedAttester: before.sourceCommit,
        expectedBase: before.sourceCommit
      }) ||
      after.sourceCommit === before.sourceCommit ||
      !sameLedger(before, after) ||
      after.status !== 'implemented'
    ) {
      return false
    }
    snapshot = after
    return true
  }

  if (!(await implement(snapshot.runs.at(-1)?.report ?? ''))) {
    log(`queue halted: implement-task did not produce an independently observed ${taskId} claim`)
    break
  }

  let finalVerdict = 'none'
  while (true) {
    const before = snapshot
    const verdict = await workflow('verify-task', {
      task: taskId,
      run: before.runCount + 1,
      baseCommit: before.sourceCommit
    })
    const after = await readSnapshot(
      `verdict-${taskId}-${before.runCount + 1}`,
      taskId,
      before.sourceCommit,
      before.sourceCommit
    )
    const last = after?.runs?.at(-1)
    const expectedStatus = verdict?.verdict === 'verified' ? 'verified' : 'refuted'
    const persisted =
      validSnapshot(after, {
        taskId,
        requireCurrent: verdict?.verdict !== 'verified',
        allowComplete: verdict?.verdict === 'verified',
        expectedAttester: before.sourceCommit,
        expectedBase: before.sourceCommit
      }) &&
      observedCommit(verdict, before, after) &&
      verdict?.taskId === taskId &&
      after.taskPath === before.taskPath &&
      after.attesterDigest === before.attesterDigest &&
      after.controlDigest === before.controlDigest &&
      after.runCount === before.runCount + 1 &&
      samePrefix(before, after, 'runEntryDigests', 1) &&
      after.progressAuditedThrough === before.progressAuditedThrough &&
      after.auditStart === before.auditStart &&
      JSON.stringify(after.auditEnds) === JSON.stringify(before.auditEnds) &&
      JSON.stringify(after.auditEntryDigests) === JSON.stringify(before.auditEntryDigests) &&
      validVerdicts.has(verdict?.verdict) &&
      last?.verdict === verdict.verdict &&
      last?.run === after.runCount &&
      last?.logEntry === verdict?.logEntry?.trim() &&
      after.status === expectedStatus
    if (!persisted) {
      await flipInvalid(`${taskId}: run ${before.runCount + 1} verdict was not independently observed at its claimed commit`)
      completed.push({ taskId, verdict: 'invalid_loop', runs: before.runCount, progressAudits })
      return { completed }
    }
    snapshot = after
    finalVerdict = verdict.verdict
    if (finalVerdict === 'verified') break

    if (snapshot.runCount >= configuredMaxRuns) {
      await flipInvalid(`${taskId}: not verified after ${snapshot.runCount} run(s); hard ceiling is ${configuredMaxRuns}`)
      completed.push({ taskId, verdict: 'invalid_loop', runs: snapshot.runCount, progressAudits })
      return { completed }
    }
    if (!(await auditCheckpoint())) {
      completed.push({ taskId, verdict: 'invalid_loop', runs: snapshot.runCount, progressAudits })
      return { completed }
    }
    if (!(await implement(snapshot.runs.at(-1)?.report ?? ''))) {
      await flipInvalid(`${taskId}: rework did not produce an independently observed claim for run ${snapshot.runCount + 1}`)
      completed.push({ taskId, verdict: 'invalid_loop', runs: snapshot.runCount, progressAudits })
      return { completed }
    }
  }

  completed.push({
    taskId,
    verdict: finalVerdict,
    runs: snapshot.runCount,
    reworks: Math.max(0, snapshot.runCount - initialRunCount),
    progressAudits
  })
  log(`${taskId} VERIFIED at independently observed commit ${snapshot.sourceCommit}; queue advances`)
}

return { completed }
