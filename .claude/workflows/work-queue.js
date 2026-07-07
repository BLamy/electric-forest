export const meta = {
  name: 'work-queue',
  description: 'The full gauntlet, looped: implement the next task, adversarially verify it, rework refutations, advance the queue — honoring the .eforest project states',
  whenToUse: 'Run to burn down .eforest/tasks/QUEUE.md unattended. args {tasks: 3} for a fixed count (default 1), {maxRetries: 2} for rework attempts per task. With a token budget set (+500k), loops until the budget runs low instead.',
  phases: [
    { title: 'Gauntlet', detail: 'implement → verify → rework loop per task' },
  ],
}

// This workflow IS .eforest/loop.md running. It must honor the project states: refuse to
// run unless status is "building", and flip to "invalid_loop" (loudly, committed) rather
// than push a task through dishonestly.

const STATE_SCHEMA = {
  type: 'object', required: ['status'],
  properties: { status: { type: 'string' }, reason: { type: 'string' } },
}

phase('Gauntlet')

const state = await agent(
  'Read .eforest/project.json in this repo and report its "status" field verbatim (and "statusReason" as reason). Do not edit anything.',
  { label: 'loop-state', phase: 'Gauntlet', schema: STATE_SCHEMA, effort: 'low' }
)
if (state?.status && state.status !== 'building') {
  log(`loop refused: project status is "${state.status}" (${state.reason ?? 'no reason recorded'}) — only a human flips it back to building`)
  return { completed: [], refused: state.status }
}

const maxTasks = args?.tasks ?? (budget.total ? 1000 : 1)
const maxRetries = args?.maxRetries ?? 2
const completed = []

const flipInvalid = async reason => {
  log(`INVALID_LOOP: ${reason}`)
  await agent(
    `Per .eforest/loop.md, the build loop can no longer make progress honestly. Edit .eforest/project.json: set status to "invalid_loop", statusReason to ${JSON.stringify(reason)}, and updatedAt to today's date. Run python3 tools/build_queue.py. Commit with message "loop: invalid_loop — ${reason}". This is a loud stop for a human; do not attempt any workaround.`,
    { label: 'flip-invalid-loop', phase: 'Gauntlet', schema: { type: 'object', required: ['done'], properties: { done: { type: 'boolean' } } }, effort: 'low' }
  )
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
  let retries = 0
  const seenReports = []
  while (verdict?.verdict !== 'verified' && retries < maxRetries) {
    // Thrash detection per .eforest/loop.md: the same finding refuting twice means the
    // loop is not converging — that's an invalid_loop, not a third identical attempt.
    const reportKey = (verdict?.findings ?? []).map(f => `${f.kind}:${f.citation}`).sort().join('|')
    if (reportKey && seenReports.includes(reportKey)) {
      await flipInvalid(`${impl.taskId}: refuted twice with the identical finding set — rework is not converging`)
      completed.push({ taskId: impl.taskId, verdict: 'invalid_loop', retries })
      return { completed }
    }
    seenReports.push(reportKey)

    retries++
    log(`${impl.taskId} ${verdict?.verdict}; rework attempt ${retries}/${maxRetries}`)
    const rework = await workflow('implement-task', { task: impl.taskId, rework: true, report: verdict?.report ?? '' })
    if (!rework?.claimed) break
    verdict = await workflow('verify-task', { task: impl.taskId })
  }

  completed.push({ taskId: impl.taskId, verdict: verdict?.verdict, retries })
  if (verdict?.verdict !== 'verified') {
    await flipInvalid(`${impl.taskId}: not verified after ${retries} rework(s) (last verdict: ${verdict?.verdict ?? 'none'})`)
    break
  }
  log(`${impl.taskId} VERIFIED (${retries} rework(s)); queue advances`)
}

return { completed }
