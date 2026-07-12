export const meta = {
  name: 'implement-task',
  description: 'Builder protocol: implement the next queue task through the gates, record evidence, write the claim',
  whenToUse: 'Run when ready to work the top of .eforest/tasks/QUEUE.md, or a specific task via args {task: "E0-T03"}. Rework after a refutation via args {task, rework: true}.',
  phases: [
    { title: 'Pick', detail: 'resolve the task, check deps, load its attack list' },
    { title: 'Implement', detail: 'one builder session: code, gates, self-validation' },
    { title: 'Gate audit', detail: 'independent fresh sessions re-run every gate' },
    { title: 'Claim', detail: 'record evidence of the final happy run, write the Verification log entry' },
  ],
}

// The builder/critic doctrine lives in AGENTS.md — agents read it at runtime so this
// script never drifts from the repo's source of truth.

const PICK_SCHEMA = {
  type: 'object',
  required: ['ok', 'taskId', 'taskPath', 'title', 'browserImpacting'],
  properties: {
    ok: { type: 'boolean', description: 'false if the task is not eligible (deps unverified, wrong status, missing folder)' },
    reason: { type: 'string' },
    taskId: { type: 'string' },
    taskPath: { type: 'string', description: 'path to the task FOLDER (its spec is readme.md inside it)' },
    title: { type: 'string' },
    capstone: { type: 'boolean' },
    browserImpacting: { type: 'boolean', description: 'true if the change touches anything a user reaches through the web app' },
    acceptanceCriteria: { type: 'array', items: { type: 'string' } },
    attackAngles: { type: 'array', items: { type: 'string' } },
  },
}

const WORK_SCHEMA = {
  type: 'object',
  required: ['done', 'commands', 'filesTouched', 'notes'],
  properties: {
    done: { type: 'boolean' },
    commands: { type: 'array', items: { type: 'string' }, description: 'exact commands run for gates + self-validation' },
    filesTouched: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'what was built, key decisions, anything the evidence recorder must exercise' },
    blockers: { type: 'string' },
  },
}

const AUDIT_SCHEMA = {
  type: 'object',
  required: ['gate', 'passed', 'output'],
  properties: {
    gate: { type: 'string' },
    passed: { type: 'boolean' },
    output: { type: 'string', description: 'tail of the real command output; never paraphrased' },
  },
}

const CLAIM_SCHEMA = {
  type: 'object',
  required: ['claimed', 'evidencePaths', 'logEntry'],
  properties: {
    claimed: { type: 'boolean' },
    evidencePaths: { type: 'array', items: { type: 'string' }, description: 'event-log dumps, digest files, Playwright traces (in the task folder evidence/), Replay recording IDs/URLs' },
    replayRecordings: { type: 'array', items: { type: 'string' } },
    logEntry: { type: 'string', description: 'the Verification log entry appended to the task readme' },
  },
}

phase('Pick')

const pick = await agent(
  `Read AGENTS.md and .eforest/tasks/README.md in this repo, then .eforest/tasks/QUEUE.md.
${args?.task ? `Target task: ${args.task}.` : 'Target task: the TOP entry of the "Next up" section.'}
A task is a FOLDER (.eforest/tasks/epic-*/E*-T*-slug/) whose spec is its readme.md. Read the target task readme in full. Confirm eligibility: status is pending or refuted, and every depends_on is verified (a bare epic dep like "E1" means that epic's capstone is verified). Report the task metadata, its acceptance criteria verbatim, and its Adversarial verification attack angles verbatim. Judge browserImpacting per AGENTS.md's rule (does the change touch anything a user can reach through the web app?). Do NOT start implementing.`,
  { label: 'pick', phase: 'Pick', schema: PICK_SCHEMA, effort: 'low' }
)

if (!pick?.ok) {
  log(`task not eligible: ${pick?.reason ?? 'pick agent failed'}`)
  return { claimed: false, reason: pick?.reason ?? 'pick failed' }
}
log(`working ${pick.taskId} — ${pick.title}`)

// The one true gate list: the builder is told exactly what the fresh-session auditors will re-run.
const GATES = [
  { gate: 'fmt+lint', cmd: 'pnpm format:check && pnpm lint' },
  { gate: 'typecheck', cmd: 'pnpm typecheck' },
  { gate: 'tests', cmd: 'pnpm test' },
  { gate: 'build', cmd: 'pnpm build' },
]

phase('Implement')

const reworkNote = args?.rework
  ? `\nThis is REWORK after a refutation. The critic's report is in the task readme's Verification log — read it first; every finding there is your work list. Failure means starting over, not patching in place: re-earn every gate.\n${args?.report ? `Critic report summary:\n${args.report}` : ''}`
  : ''

const work = await agent(
  `You are the BUILDER for task ${pick.taskId} (${pick.taskPath}). Read AGENTS.md fully and follow the Builder protocol exactly.${reworkNote}

Steps:
1. Set the task readme's frontmatter status to in-progress, run python3 tools/build_queue.py, and commit that status change.
2. Implement the task. Gates in ascending cost, any failure returns to the top — independent fresh sessions will re-run EXACTLY these commands after you finish:
${GATES.map(g => `   ${g.cmd}`).join('\n')}
   (If the workspace predates some gate — e.g. no package.json yet because THIS task creates it — the gate applies from the moment it can.)
3. Self-validate freely: drive the code however you want; nothing in this inner loop is evidence. ALL scratch work (throwaway scripts, probes, ad-hoc validation) goes in ${pick.taskPath}/work/ — the task folder is your whole workshop; /tmp is forbidden.
4. Build for the attack: the task's Adversarial verification section tells you how a hostile critic will attack your claim. Their angles, verbatim:
${(pick.attackAngles ?? []).map(a => `   - ${a}`).join('\n')}
5. Commit your implementation (do NOT set status implemented yet — evidence and claim come after independent gate audits).

Return the exact commands you ran, files touched, and notes on what the final evidence run must exercise so that every changed hunk executes.`,
  { label: `work:${pick.taskId}`, phase: 'Implement', schema: WORK_SCHEMA, effort: 'high' }
)

if (!work?.done) {
  log(`builder blocked: ${work?.blockers ?? 'no result'}`)
  return { claimed: false, taskId: pick.taskId, reason: work?.blockers ?? 'builder failed' }
}

phase('Gate audit')

// The builder saying gates pass is a claim. Fresh sessions re-running them is evidence.

let audits = []
for (let round = 0; round < 3; round++) {
  audits = (await parallel(GATES.map(g => () =>
    agent(
      `Fresh gate audit for this repo. Gate name: "${g.gate}" — report exactly this string in the gate field. Run exactly: ${g.cmd}
If the workspace legitimately lacks the surface for this gate (e.g. no package.json yet and the task predates it), say so in output and report passed=true only when the gate is genuinely inapplicable per .eforest/tasks/QUEUE.md state — otherwise report the real result. Never fix anything.`,
      { label: `audit:${g.gate}`, phase: 'Gate audit', schema: AUDIT_SCHEMA, effort: 'low' }
    )
  ))).filter(Boolean)

  // An auditor that died is a failed gate, not a free pass.
  const missing = GATES.filter(g => !audits.some(a => a.gate === g.gate))
    .map(g => ({ gate: g.gate, passed: false, output: 'gate auditor returned no result — rerun required' }))
  audits = [...audits, ...missing]

  const failed = audits.filter(a => !a.passed)
  if (!failed.length) break
  if (round === 2) {
    log(`gates still red after 3 rounds: ${failed.map(f => f.gate).join(', ')}`)
    return { claimed: false, taskId: pick.taskId, reason: 'gate audits failed', audits }
  }
  log(`gate audit round ${round + 1} failed (${failed.map(f => f.gate).join(', ')}); dispatching fixer`)
  await agent(
    `You are the BUILDER for ${pick.taskId} continuing after failed gate audits. Real outputs:
${failed.map(f => `--- ${f.gate} ---\n${f.output}`).join('\n')}
Fix the code until these gates pass locally, then commit. Do not weaken a gate, .skip a test, or disable a lint rule to get green — that is a refutation waiting to happen (and the greenwash scanner tools/verify/self_check.sh polices the verify path).`,
    { label: `fix:round${round + 1}`, phase: 'Gate audit', schema: WORK_SCHEMA, effort: 'high' }
  )
}

phase('Claim')

const claim = await agent(
  `You are the BUILDER for ${pick.taskId} finishing per AGENTS.md: record the final happy run and write the claim.

Builder notes on what must be exercised:
${work.notes}

1. RECORD THE EVIDENCE RUN. Every behavior the diff changes must actually execute during it — the critic holds the recording against the diff, and unexecuted changed code is either unproven or dead.
   - Stream layer (always): run the deterministic evidence tooling that exists at this point in the queue — event-log dumps replayed to state digests, replay-determinism checks, convergence diffs (see tools/ and Makefile verify-* targets). Before that infra exists (early Epic 0), evidence = deterministic test output captured to a file. Durable artifacts go in ${pick.taskPath}/evidence/ (committed); scratch stays in ${pick.taskPath}/work/ (gitignored).
   - Browser layer (${pick.browserImpacting ? 'REQUIRED — this task is browser-impacting' : 'skip — not browser-impacting'}): build the web app, drive the changed behavior in a real browser, then re-run the final successful walkthrough under Replay Chromium and upload it (tools/replay/README.md documents the flow; the replayio skill's browser-open.js/browser-close.js lifecycle scripts and "replayio upload" do the recording). Capture the MP4 video too (browser-open.js --output recordings/<claim>.mp4, or Playwright video on the Replay Chromium run; multi-client runs stitch into ONE side-by-side MP4), embed it with markdown in your report — ![<claim>](recordings/<claim>.mp4) — and name the mp4 path + Replay URL in the Verification log entry (AGENTS.md 3a(d); recordings/ is gitignored, the Replay URL is the durable citation; no video = the run failed loudly). Cite the uploaded recording ID/URL — a read-only replay-critic will interrogate it through the Replay MCP, so the walkthrough must exercise every changed browser-reaching behavior, including error/removal paths. Also assert zero console errors and update the web app so it surfaces the new capability, per AGENTS.md 3a.
   ${pick.capstone ? '- CAPSTONE: the demo must run end-to-end from a cold start (fresh clone / fresh browser profile / fresh stream-server data dir), no state left over from development.' : ''}
2. WRITE THE CLAIM: append a Verification log entry to ${pick.taskPath}/readme.md: commit hash, exact commands, evidence paths / recording IDs, and one paragraph stating what the recording demonstrates. Name the evidence layer for every claim; declare absence explicitly (Replay: N/A (<reason>) + mitigation).
3. Set status: implemented, run python3 tools/build_queue.py, commit.

Return the evidence paths and the log entry text.`,
  { label: `claim:${pick.taskId}`, phase: 'Claim', schema: CLAIM_SCHEMA, effort: 'high' }
)

log(claim?.claimed
  ? `${pick.taskId} implemented + claimed; ready for verify-task`
  : `${pick.taskId} claim step failed`)

return {
  claimed: !!claim?.claimed,
  taskId: pick.taskId,
  taskPath: pick.taskPath,
  evidencePaths: claim?.evidencePaths ?? [],
  replayRecordings: claim?.replayRecordings ?? [],
  audits,
}
