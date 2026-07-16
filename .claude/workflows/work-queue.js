export const meta = {
  name: 'work-queue',
  description: 'The full gauntlet, looped: implement the next task, adversarially verify it, rework refutations, advance the queue — honoring the .eforest project states',
  whenToUse: 'Run to burn down .eforest/tasks/QUEUE.md unattended. args {tasks: 3} for a fixed count (default 1), {roundSize: 3} reworks per round and {maxAttempts: 10} total — after each round a progress judge decides whether rework continues. With a token budget set (+500k), loops until the budget runs low instead.',
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
// Rework budget per .eforest/loop.md: reworks run in rounds of `roundSize`. When a round
// ends without a verified verdict, a PROGRESS JUDGE — a third critic, separate from both
// the builder and the verifying critic — reads the round's verdicts and decides whether
// the reworks are converging. Only a "progressing" ruling buys another round, up to
// `maxAttempts` total reworks; anything else is an invalid_loop.
const roundSize = args?.roundSize ?? 3
const maxAttempts = args?.maxAttempts ?? 10
const completed = []

const PROGRESS_SCHEMA = {
  type: 'object', required: ['progressing', 'reason'],
  properties: { progressing: { type: 'boolean' }, reason: { type: 'string' } },
}

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
  const roundVerdicts = []
  while (verdict?.verdict !== 'verified' && retries < maxAttempts) {
    // Thrash detection per .eforest/loop.md: the same finding refuting twice means the
    // loop is not converging — that's an invalid_loop, not a third identical attempt.
    const reportKey = (verdict?.findings ?? []).map(f => `${f.kind}:${f.citation}`).sort().join('|')
    if (reportKey && seenReports.includes(reportKey)) {
      await flipInvalid(`${impl.taskId}: refuted twice with the identical finding set — rework is not converging`)
      completed.push({ taskId: impl.taskId, verdict: 'invalid_loop', retries })
      return { completed }
    }
    seenReports.push(reportKey)
    roundVerdicts.push(verdict?.report ?? verdict?.verdict ?? 'refuted')

    // End of a round: before spending another round of reworks, a progress judge —
    // fresh eyes, neither the builder nor the critic that refuted — rules on whether
    // the successive verdicts show convergence (shrinking finding sets, new ground
    // covered) or circling. Only "progressing" buys the next round.
    if (retries > 0 && retries % roundSize === 0) {
      const judgment = await agent(
        `You are the progress judge for task ${impl.taskId} in this repo. It has been refuted ${retries} time(s). Here are the successive critic verdicts, oldest first:\n\n${roundVerdicts.map((r, n) => `--- attempt ${n + 1} ---\n${r}`).join('\n\n')}\n\nRead .eforest/tasks/QUEUE.md and the task folder if you need context. Rule ONLY on convergence: are the reworks making real progress (findings shrinking or shifting to new, shallower ground), or is the loop circling (same class of failure, cosmetic changes, growing scope)? Do not fix anything.`,
        { label: `progress-judge:${impl.taskId}`, phase: 'Gauntlet', schema: PROGRESS_SCHEMA }
      )
      if (!judgment?.progressing) {
        await flipInvalid(`${impl.taskId}: progress judge halted rework after ${retries} attempt(s) — ${judgment?.reason ?? 'no ruling returned'}`)
        completed.push({ taskId: impl.taskId, verdict: 'invalid_loop', retries })
        return { completed }
      }
      log(`${impl.taskId} progress judge: still converging after ${retries}/${maxAttempts} — ${judgment.reason}`)
    }

    retries++
    log(`${impl.taskId} ${verdict?.verdict}; rework attempt ${retries}/${maxAttempts}`)
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
