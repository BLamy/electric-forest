export const meta = {
  name: 'implement-task',
  description: 'Builder protocol: implement the next queue task through the gates, record evidence, write the claim',
  whenToUse: 'Run when ready to work the top of .eforest/tasks/QUEUE.md, or a specific task via args {task: "E0-T03"}. Rework after a refutation via args {task, rework: true}.',
  phases: [
    { title: 'Pick', detail: 'resolve the task, check deps, load its attack list' },
    { title: 'Threat model', detail: 'a fresh pre-critic turns the spec into falsifiable attacks before code is written' },
    { title: 'Implement', detail: 'one builder session: code, gates, self-validation' },
    { title: 'Gate audit', detail: 'one fresh auditor runs the ordered gate chain once for the immutable candidate' },
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

const THREAT_MODEL_SCHEMA = {
  type: 'object',
  required: ['threatModel', 'predictions', 'targetedCommands', 'coverageRisks'],
  properties: {
    threatModel: { type: 'string', description: 'explicit in-scope assets, actors, trust boundaries, and excluded universal claims' },
    predictions: { type: 'array', minItems: 1, items: { type: 'string', description: 'a falsifiable pre-implementation prediction tied to one criterion' } },
    targetedCommands: { type: 'array', minItems: 1, items: { type: 'string', description: 'cheap focused command or probe to run before the root gates' } },
    coverageRisks: { type: 'array', items: { type: 'string', description: 'branches or error paths the final evidence must execute' } },
  },
}

const AUDIT_CHAIN_SCHEMA = {
  type: 'object',
  required: ['passed', 'commitOid', 'gates'],
  properties: {
    passed: { type: 'boolean' },
    commitOid: { type: 'string', description: 'full git OID audited before the first gate ran' },
    gates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['gate', 'passed', 'output'],
        properties: {
          gate: { type: 'string' },
          passed: { type: 'boolean' },
          output: { type: 'string', description: 'tail of the real command output; never paraphrased' },
        },
      },
    },
  },
}

const FINAL_CANDIDATE_SCHEMA = {
  type: 'object',
  required: ['passed', 'auditedCommit', 'candidateCommit', 'changedPaths', 'reranGates', 'reason'],
  properties: {
    passed: { type: 'boolean' },
    auditedCommit: { type: 'string' },
    candidateCommit: { type: 'string' },
    changedPaths: { type: 'array', items: { type: 'string' } },
    reranGates: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

const CLAIM_SCHEMA = {
  type: 'object',
  required: ['claimed', 'evidencePaths', 'logEntry'],
  properties: {
    claimed: { type: 'boolean' },
    evidencePaths: { type: 'array', items: { type: 'string' }, description: 'event-log dumps, digest files, Playwright traces (in the task folder evidence/), Replay QA project/journey/test-run IDs, epic-closing exploration IDs, and attached recording URLs' },
    replayQaRuns: { type: 'array', items: { type: 'string' } },
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

phase('Threat model')

const threatModel = await agent(
  `You are a fresh, read-only PRE-CRITIC for ${pick.taskId} (${pick.taskPath}). Read AGENTS.md and the task spec. Do not edit files or run the expensive root suite. Before implementation exists, turn every acceptance criterion and adversarial angle into an explicit, finite threat model and falsifiable predictions. Prefer cheap focused commands and sensitivity probes that can fail in under two minutes. Identify error/removal/concurrency branches the final evidence must execute. Do not invent universal claims such as "secure against everything" or requirements absent from the task.\n\nAcceptance criteria:\n${(pick.acceptanceCriteria ?? []).map(c => `- ${c}`).join('\n')}\n\nTask attacks:\n${(pick.attackAngles ?? []).map(a => `- ${a}`).join('\n')}`,
  { label: `precritic:${pick.taskId}`, phase: 'Threat model', schema: THREAT_MODEL_SCHEMA, effort: 'high' }
)

if (!threatModel) {
  log('pre-critic returned no threat model — refusing to begin an expensive blind implementation')
  return { claimed: false, taskId: pick.taskId, reason: 'pre-critic failed' }
}

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
   The pre-critic froze this finite threat model before implementation:
   ${threatModel.threatModel}
   Predictions:
${threatModel.predictions.map(p => `   - ${p}`).join('\n')}
   Run these cheap targeted checks before the root gates:
${threatModel.targetedCommands.map(c => `   - ${c}`).join('\n')}
   Final-evidence coverage risks:
${threatModel.coverageRisks.map(r => `   - ${r}`).join('\n')}
5. Commit your implementation (do NOT set status implemented yet — evidence and claim come after the independent gate audit).

Return the exact commands you ran, files touched, and notes on what the final evidence run must exercise so that every changed hunk executes.`,
  { label: `work:${pick.taskId}`, phase: 'Implement', schema: WORK_SCHEMA, effort: 'high' }
)

if (!work?.done) {
  log(`builder blocked: ${work?.blockers ?? 'no result'}`)
  return { claimed: false, taskId: pick.taskId, reason: work?.blockers ?? 'builder failed' }
}

phase('Gate audit')

// The builder saying gates pass is a claim. One fresh auditor runs the ordered chain
// against one immutable candidate. Four concurrent package-manager processes made the
// old audit measure host contention and repeated unchanged setup work.

let audits = []
let auditedCommit = ''
for (let round = 0; round < 3; round++) {
  const audit = await agent(
    `Fresh gate audit for this repo at the current committed candidate. Record the full current git OID as commitOid before running anything. Never fix anything. Run this chain sequentially in ascending cost and stop on the first failure:\n${GATES.map(g => `${g.gate}: ${g.cmd}`).join('\n')}\nReport every attempted gate with its exact gate name and real output tail. If a surface is genuinely inapplicable at this queue point, explain why; otherwise it is a failure. Do not rerun a passing command and do not start concurrent package-manager processes.`,
    { label: `audit-chain:round${round + 1}`, phase: 'Gate audit', schema: AUDIT_CHAIN_SCHEMA, effort: 'low' }
  )
  auditedCommit = audit?.commitOid ?? ''
  audits = audit?.gates ?? []

  const attempted = audits.map(a => a.gate)
  const failedIndex = audits.findIndex(a => !a.passed)
  const requiredThrough = failedIndex >= 0 ? failedIndex + 1 : GATES.length
  const missing = GATES.slice(0, requiredThrough).filter(g => !attempted.includes(g.gate))
    .map(g => ({ gate: g.gate, passed: false, output: 'gate auditor returned no result — rerun required' }))
  audits = [...audits, ...missing]

  const failed = audits.filter(a => !a.passed)
  if (audit?.passed !== true && !failed.length) {
    failed.push({ gate: 'audit-chain', passed: false, output: 'gate auditor did not attest the full chain as passed' })
  }
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

Pre-critic coverage risks:
${threatModel.coverageRisks.map(r => `- ${r}`).join('\n')}

Exact-candidate gate audit (do not rerun these unchanged root gates during the evidence run):
${audits.map(a => `- ${a.gate}: ${a.passed ? 'passed' : 'failed'} — ${a.output}`).join('\n')}

1. RUN THE EVIDENCE JOURNEYS. Every behavior the diff changes must actually execute — the critic holds the Replay QA run against the diff, and uncovered changed code is either unproven or dead.
   - Stream layer (always): run the deterministic evidence tooling that exists at this point in the queue — event-log dumps replayed to state digests, replay-determinism checks, convergence diffs (see tools/ and Makefile verify-* targets). Before that infra exists (early Epic 0), evidence = deterministic test output captured to a file. Durable artifacts go in ${pick.taskPath}/evidence/ (committed); scratch stays in ${pick.taskPath}/work/ (gitignored).
   - Browser layer (${pick.browserImpacting ? 'REQUIRED — this task is browser-impacting' : 'skip — not browser-impacting'}): build and start the complete app, preserve its normal emulator/auth setup, and expose it through the Replay QA reverse-proxy tunnel bound by .replay/config.json. Direct local Playwright inspection is the deterministic inner loop, not final evidence. Create or update reusable named journeys for every changed browser behavior, with setup, exact actions, expected outcomes, and error/removal paths, and launch them inside the configured project. Do not run an open-ended exploration for an ordinary task. If this is the final remaining task in its epic, run one full open-ended exploration after the focused journeys pass and before closing the epic. Cite the project, journey/test-run/bug IDs, the epic-closing exploration ID when applicable, and any attached Replay recording URLs. Never substitute local Replay Chromium or a screencast for the Replay QA run. Also assert zero console errors and update the web app so it surfaces the new capability, per AGENTS.md 4a.
   ${pick.capstone ? '- CAPSTONE: the demo must run end-to-end from a cold start (fresh clone / fresh browser profile / fresh stream-server data dir), no state left over from development.' : ''}
2. WRITE THE CLAIM: append a Verification log entry to ${pick.taskPath}/readme.md: commit hash, exact commands, evidence paths, Replay QA project/journey/test-run IDs, the epic-closing exploration ID when applicable, and any attached recording URLs, plus one paragraph stating what the run demonstrates. Name the evidence layer for every claim; declare absence explicitly (Replay: N/A (<reason>) + mitigation).
3. Set status: implemented, run python3 tools/build_queue.py, commit.

Return the evidence paths and the log entry text.`,
  { label: `claim:${pick.taskId}`, phase: 'Claim', schema: CLAIM_SCHEMA, effort: 'high' }
)

if (!claim?.claimed) {
  log(`${pick.taskId} claim step failed before final candidate attestation`)
  return { claimed: false, taskId: pick.taskId, reason: 'claim step failed', audits }
}

const auditCommit = await agent(
  `You are the final candidate integrity auditor for ${pick.taskId}. The ordered root gate audit was run at full OID ${auditedCommit}. Independently inspect git history and the diff from that exact commit to current HEAD. The only allowed post-gate changes are ${pick.taskPath}/readme.md, files beneath ${pick.taskPath}/evidence/, and .eforest/tasks/QUEUE.md. If any source, config, executable verifier, lockfile, or other path changed, run the entire ordered root gate chain once against current HEAD; otherwise do not rerun it. Return both full OIDs, every changed path, whether gates were rerun, and passed=false on any ambiguity, missing/mismatched OID, disallowed ungated change, or red gate.`,
  { label: `candidate-integrity:${pick.taskId}`, phase: 'Claim', schema: FINAL_CANDIDATE_SCHEMA, effort: 'low' }
)

if (!auditCommit?.passed) {
  log(`final candidate was not bound to the gate audit: ${auditCommit?.reason ?? 'no integrity result'}`)
  return { claimed: false, taskId: pick.taskId, reason: auditCommit?.reason ?? 'candidate integrity failed', audits }
}

log(claim?.claimed
  ? `${pick.taskId} implemented + claimed; ready for verify-task`
  : `${pick.taskId} claim step failed`)

return {
  claimed: !!claim?.claimed,
  taskId: pick.taskId,
  taskPath: pick.taskPath,
  evidencePaths: claim?.evidencePaths ?? [],
  replayQaRuns: claim?.replayQaRuns ?? [],
  audits,
}
