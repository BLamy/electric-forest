export const meta = {
  name: 'work-queue',
  description: 'The full gauntlet, looped: independently attest a commit-bound task ledger, implement, verify, audit progress every three failed runs, rework, and advance',
  whenToUse: 'Run to burn down .eforest/tasks/QUEUE.md unattended. args {tasks: 3} selects a fixed task count (default 1); {maxRuns: 10} sets an integer verification-run ceiling from 1 through 10. Invalid limits are refused before work starts.',
  phases: [{ title: 'Gauntlet', detail: 'commit snapshot → implement → verify → post-commit snapshot → progress audit → rework' }]
}

// The workflow runtime orchestrates agents but does not expose a shell primitive. Every
// control decision therefore consumes the byte-identical stdout of TWO fresh readers.
// A human-authorized bridge may add only digest-pinned compatibility for frozen history;
// it never rewrites task/project bytes or infers mutable legacy entries.
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
          kind: { type: 'string', enum: ['report', 'diff', 'commit', 'test', 'fixture', 'digest'] },
          ref: { type: 'string' },
          supports: { type: 'string' }
        }
      }
    },
    nextFocus: { type: 'array', items: { type: 'string' } }
  }
}

phase('Gauntlet')

const requestedMaxRuns = args?.maxRuns
if (Object.prototype.hasOwnProperty.call(args ?? {}, 'maxRetries')) {
  log('loop refused: maxRetries is no longer supported; use integer maxRuns in [1,10]')
  return { completed: [], refused: 'unsupported maxRetries' }
}
if (
  requestedMaxRuns !== undefined &&
  (!Number.isInteger(requestedMaxRuns) || requestedMaxRuns < 1 || requestedMaxRuns > 100)
) {
  log(`loop refused: maxRuns must be an integer in [1,100], received ${JSON.stringify(requestedMaxRuns)}`)
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
const E2_T06_PRE_RUN_INVALID_LOOP_COMMIT = 'f1f21df7ad71bb1978ef0dd12081ddc425368e3c'
const SNAPSHOT_SCRIPT = 'packages/identity/scripts/work-queue-snapshot.mjs'
const QUEUE_PATH = '.eforest/tasks/QUEUE.md'
const PROJECT_PATH = '.eforest/project.json'
const activeStatuses = new Set(['pending', 'in-progress', 'implemented', 'refuted'])
const validVerdicts = new Set(['verified', 'refuted', 'needs-evidence'])
const hasText = (value) => typeof value === 'string' && value.trim().length > 0
const canonicalText = (value) => value.trim().replace(/\s+/g, ' ')
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

const validCatalogItem = (item) => {
  if (!hasText(item?.ref) || !hasText(item?.target)) return false
  if (item.kind === 'report') return item.verifier === 'ledger-entry' && DIGEST.test(item.target)
  if (item.kind === 'digest') {
    return item.verifier === 'ledger-entry-digest' && DIGEST.test(item.ref) && item.target.includes('#judge-run-')
  }
  if (item.kind === 'diff' || item.kind === 'commit') {
    return item.verifier === 'git-commit' && item.target === item.ref
  }
  if (item.kind === 'test' || item.kind === 'fixture') {
    return item.verifier === 'git-path' && item.target === item.ref
  }
  return false
}

const validRecoveryAuthorization = (snapshot) => {
  const value = snapshot.recoveryAuthorization
  if (snapshot.runCeiling === 10) return value === null
  return (
    value?.authorizedCeiling === snapshot.runCeiling &&
    Number.isInteger(value.baseRun) &&
    (value.baseRun >= 1 ||
      (snapshot.taskId === 'E2-T06' &&
        value.baseRun === 0 &&
        snapshot.runCeiling === 3 &&
        value.invalidLoopCommit === E2_T06_PRE_RUN_INVALID_LOOP_COMMIT)) &&
    value.baseRun < snapshot.runCeiling &&
    snapshot.runCeiling - value.baseRun <= 3 &&
    OID.test(value.resumeCommit) &&
    OID.test(value.invalidLoopCommit) &&
    value.resumeCommit !== value.invalidLoopCommit &&
    (value.controlCommit === null || OID.test(value.controlCommit)) &&
    (value.controlCommit === null || value.controlCommit !== value.resumeCommit) &&
    (value.controlCommit === null || value.controlCommit !== value.invalidLoopCommit) &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    DIGEST.test(value.entryDigest) &&
    DIGEST.test(value.statusReasonDigest) &&
    DIGEST.test(value.priorLedgerDigest) &&
    DIGEST.test(value.priorRunEntryDigestsDigest) &&
    DIGEST.test(value.priorAuditEntryDigestsDigest) &&
    DIGEST.test(value.resumeRunEntryDigestsDigest) &&
    DIGEST.test(value.resumeAuditEntryDigestsDigest) &&
    value.firstRun === value.baseRun + 1 &&
    value.lastRun === snapshot.runCeiling &&
    value.priorRunCount === value.baseRun &&
    value.resumeRunCount === value.baseRun &&
    Number.isInteger(value.priorAuditCount) &&
    Number.isInteger(value.resumeAuditCount) &&
    value.resumeAuditCount >= value.priorAuditCount &&
    value.resumeParentVerified === true &&
    value.resumeAncestorVerified === true &&
    value.invalidLoopStatusVerified === true &&
    value.ceilingIntroducedVerified === true &&
    value.statusReasonVerified === true &&
    value.approvalPathsVerified === true &&
    value.historyPrefixVerified === true &&
    typeof value.checkpointAuditInherited === 'boolean' &&
    (value.controlCommit === null
      ? value.controlParentVerified === null
      : value.controlParentVerified === true) &&
    (value.baseRun > 0 && value.baseRun % 3 === 0
      ? value.checkpointOverrideVerified === true &&
        (value.checkpointAssessment === 'progressing' ||
          value.checkpointAssessment === 'death-spiral' ||
          value.checkpointAssessment === 'insufficient-evidence') &&
        (value.checkpointAuditInherited
          ? value.resumeAuditCount === value.priorAuditCount
          : value.resumeAuditCount === value.priorAuditCount + 1 &&
            value.checkpointAssessment !== 'progressing')
      : value.checkpointAuditInherited === false &&
        value.checkpointAssessment === null &&
        value.resumeAuditCount === value.priorAuditCount) &&
    value.sameGateVerified === true
  )
}

const validSnapshot = (
  snapshot,
  {
    taskId,
    requireCurrent = true,
    allowComplete = false,
    allowInvalid = false,
    expectedAttester = null,
    expectedBase = null
  } = {}
) => {
  if (snapshot?.schemaVersion !== 2 || !OID.test(snapshot.sourceCommit)) return false
  if (!OID.test(snapshot.attesterSourceCommit) || !DIGEST.test(snapshot.attesterDigest)) return false
  if (!DIGEST.test(snapshot.controlDigest)) return false
  if (expectedAttester === null) {
    if (snapshot.attesterSourceCommit !== snapshot.sourceCommit) return false
  } else if (snapshot.attesterSourceCommit !== expectedAttester) return false
  if (snapshot.transitionBaseCommit !== expectedBase) return false
  if (
    (expectedBase === null && snapshot.transitionBaseIsDirectParent !== null) ||
    (expectedBase !== null && snapshot.transitionBaseIsDirectParent !== true)
  ) return false
  if (!Array.isArray(snapshot.changedPaths) || snapshot.changedPaths.some((path) => !hasText(path))) return false
  if (JSON.stringify(snapshot.changedPaths) !== JSON.stringify([...snapshot.changedPaths].sort())) return false
  if (!DIGEST.test(snapshot.projectDigest) || !DIGEST.test(snapshot.queueDigest)) return false
  if (
    snapshot.projectStatus !== 'building' &&
    !(allowComplete && snapshot.projectStatus === 'complete') &&
    !(allowInvalid && snapshot.projectStatus === 'invalid_loop')
  ) return false
  if (!taskId && snapshot.taskId === null && snapshot.currentGateTaskId === null) return snapshot.projectStatus === 'complete'
  if (!TASK.test(snapshot.taskId) || snapshot.taskId !== taskId) return false
  if (requireCurrent && snapshot.currentGateTaskId !== taskId) return false
  if (!validTaskPath(taskId, snapshot.taskPath)) return false
  if (
    !DIGEST.test(snapshot.taskDigest) ||
    !Number.isInteger(snapshot.runCeiling) ||
    snapshot.runCeiling < 2 ||
    snapshot.runCeiling > 100 ||
    !Number.isInteger(snapshot.runCount) ||
    snapshot.runCount < 0 ||
    snapshot.runCount > snapshot.runCeiling
  ) return false
  if (!validRecoveryAuthorization(snapshot)) return false
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
    (snapshot.latestAudit.assessment !== 'progressing' &&
      !(
        snapshot.recoveryAuthorization?.baseRun === snapshot.latestAudit.lastRun &&
        snapshot.recoveryAuthorization?.checkpointOverrideVerified === true &&
        snapshot.recoveryAuthorization?.checkpointAssessment === snapshot.latestAudit.assessment
      )) ||
    !hasText(snapshot.latestAudit.rationale) ||
    !Array.isArray(snapshot.latestAudit.evidence) ||
    snapshot.latestAudit.evidence.length === 0 ||
    snapshot.latestAudit.evidence.some(
      (item) => !hasText(item?.kind) || !hasText(item?.ref) || !hasText(item?.supports)
    ) ||
    !Array.isArray(snapshot.latestAudit.nextFocus) ||
    snapshot.latestAudit.nextFocus.length === 0 ||
    snapshot.latestAudit.nextFocus.some((value) => !hasText(value)) ||
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
    snapshot.evidenceCatalog.some((item) => !validCatalogItem(item)) ||
    new Set(snapshot.evidenceCatalog.map((item) => `${item.kind}:${item.ref}`)).size !==
      snapshot.evidenceCatalog.length
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
  JSON.stringify(before.recoveryAuthorization) === JSON.stringify(after.recoveryAuthorization) &&
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

const exactChanged = (snapshot, expected) =>
  JSON.stringify(snapshot.changedPaths) === JSON.stringify([...expected].sort())

const implementationChanged = (snapshot, taskPath) =>
  snapshot.changedPaths.includes(taskPath) &&
  snapshot.changedPaths.includes(QUEUE_PATH) &&
  !snapshot.changedPaths.includes(PROJECT_PATH)

const verdictChanged = (snapshot, taskPath) =>
  exactChanged(
    snapshot,
    snapshot.projectStatus === 'complete'
      ? [taskPath, QUEUE_PATH, PROJECT_PATH]
      : [taskPath, QUEUE_PATH]
  )

const observedCommit = (claim, before, after) =>
  OID.test(claim?.baseCommit) &&
  OID.test(claim?.commitOid) &&
  claim.baseCommit === before.sourceCommit &&
  claim.commitOid === after.sourceCommit &&
  after.sourceCommit !== before.sourceCommit &&
  after.attesterSourceCommit === before.sourceCommit &&
  after.transitionBaseCommit === before.sourceCommit

const flipInvalid = async (reason, before) => {
  log(`INVALID_LOOP: ${reason}`)
  const committed = await agent(
    `Per .eforest/loop.md, the loop can no longer progress honestly. Base commit must be ${before.sourceCommit}. Set .eforest/project.json status to "invalid_loop", record this exact statusReason: ${JSON.stringify(reason)}, update updatedAt, run python3 tools/build_queue.py, and commit the actual generated diff (project state must change; QUEUE.md is included only if regeneration changes its bytes). Return the full baseCommit and commitOid. Do not fabricate a queue delta, weaken, or route around the stop.`,
    {
      label: 'flip-invalid-loop',
      phase: 'Gauntlet',
      schema: COMMIT_SCHEMA,
      effort: 'low'
    }
  )
  const after = await readSnapshot(
    `invalid-loop-${before.taskId}-${before.runCount}`,
    before.taskId,
    before.sourceCommit,
    before.sourceCommit
  )
  const persisted =
    validSnapshot(after, {
      taskId: before.taskId,
      requireCurrent: false,
      allowInvalid: true,
      expectedAttester: before.sourceCommit,
      expectedBase: before.sourceCommit
    }) &&
    observedCommit(committed, before, after) &&
    after.projectStatus === 'invalid_loop' &&
    after.attesterDigest === before.attesterDigest &&
    sameLedger(before, after) &&
    exactChanged(after, [PROJECT_PATH])
  if (!persisted) log(`INVALID_LOOP persistence could not be independently attested: ${reason}`)
  return persisted
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
  const configuredMaxRuns = requestedMaxRuns ?? snapshot.runCeiling
  if (configuredMaxRuns > snapshot.runCeiling) {
    log(
      `loop refused: maxRuns ${configuredMaxRuns} exceeds committed ceiling ${snapshot.runCeiling} for ${taskId}`
    )
    return { completed, refused: 'maxRuns exceeds committed ceiling' }
  }
  const initialRunCount = snapshot.runCount
  const progressAudits = []
  const unpersistedStop = (reason) => ({
    completed,
    refused: 'invalid_loop persistence unconfirmed',
    reason
  })
  const stopInvalid = async (reason, before, runs = before.runCount) => {
    if (!(await flipInvalid(reason, before))) return unpersistedStop(reason)
    completed.push({ taskId, verdict: 'invalid_loop', runs, progressAudits })
    return { completed }
  }

  const auditCheckpoint = async () => {
    const run = snapshot.runCount
    if (run === 0 || run % 3 !== 0 || snapshot.progressAuditedThrough === run) return null
    const window = snapshot.runs
    const firstRun = run - 2
    if (window.length !== 3 || window[0].run !== firstRun || window[2].run !== run) {
      const reason = `${taskId}: progress audit ${firstRun}-${run} lacked its complete report window`
      return stopInvalid(reason, snapshot)
    }
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
      const reason = `${taskId}: progress audit ${firstRun}-${run} lacked complete resolvable proof`
      return stopInvalid(reason, snapshot)
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
      exactChanged(after, [snapshot.taskPath, QUEUE_PATH]) &&
      canonicalText(after.latestAudit.rationale) === canonicalText(progress.rationale) &&
      JSON.stringify(
        after.latestAudit.evidence.map((item) => ({
          kind: item.kind,
          ref: item.ref,
          supports: canonicalText(item.supports)
        }))
      ) ===
        JSON.stringify(
          progress.evidence.map((item) => ({
            kind: item.kind,
            ref: item.ref,
            supports: canonicalText(item.supports)
          }))
        ) &&
      JSON.stringify(after.latestAudit.nextFocus.map(canonicalText)) ===
        JSON.stringify(progress.nextFocus.map(canonicalText))
    if (!progressPersisted) {
      const reason = `${taskId}: progress audit ${firstRun}-${run} was not independently observed at its claimed commit`
      return stopInvalid(reason, snapshot)
    }
    snapshot = after
    return null
  }

  if (snapshot.runCount >= configuredMaxRuns) {
    const reason = `${taskId}: not verified after ${snapshot.runCount} run(s); hard ceiling is ${configuredMaxRuns}`
    return stopInvalid(reason, snapshot)
  }
  const initialAuditStop = await auditCheckpoint()
  if (initialAuditStop) return initialAuditStop

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
      !implementationChanged(after, before.taskPath) ||
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
      verdictChanged(after, before.taskPath) &&
      validVerdicts.has(verdict?.verdict) &&
      last?.verdict === verdict.verdict &&
      last?.run === after.runCount &&
      last?.logEntry === verdict?.logEntry?.trim() &&
      after.status === expectedStatus
    if (!persisted) {
      const reason = `${taskId}: run ${before.runCount + 1} verdict was not independently observed at its claimed commit`
      return stopInvalid(reason, before)
    }
    snapshot = after
    finalVerdict = verdict.verdict
    if (finalVerdict === 'verified') break

    if (snapshot.runCount >= configuredMaxRuns) {
      const reason = `${taskId}: not verified after ${snapshot.runCount} run(s); hard ceiling is ${configuredMaxRuns}`
      return stopInvalid(reason, snapshot)
    }
    const auditStop = await auditCheckpoint()
    if (auditStop) return auditStop
    if (!(await implement(snapshot.runs.at(-1)?.report ?? ''))) {
      const reason = `${taskId}: rework did not produce an independently observed claim for run ${snapshot.runCount + 1}`
      return stopInvalid(reason, snapshot)
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
