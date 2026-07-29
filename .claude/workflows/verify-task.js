export const meta = {
  name: 'verify-task',
  description: 'Adversarial verification: fresh hostile sessions attack an implemented task\'s claim from every direction, then a judge issues the verdict',
  whenToUse: 'Run against a task with status: implemented (args {task: "E0-T03"}, default: first implemented task in the queue). Never run it from the session that implemented.',
  phases: [
    { title: 'Orient', detail: 'read claim, diff, evidence; build the attack brief' },
    { title: 'Attack', detail: 'one lead critic runs focused falsification, coverage, sabotage, task attacks, then one late cold clone' },
    { title: 'Verdict', detail: 'one fresh skeptic/judge batches cross-examination, writes the verdict, and promotes suite artifacts' },
  ],
}

const BRIEF_SCHEMA = {
  type: 'object',
  required: ['ok', 'taskId', 'taskPath', 'diffCmd', 'claims', 'criteria', 'attackAngles', 'changedHunks'],
  properties: {
    ok: { type: 'boolean' },
    reason: { type: 'string' },
    taskId: { type: 'string' },
    taskPath: { type: 'string', description: 'path to the task FOLDER (spec in readme.md)' },
    capstone: { type: 'boolean' },
    diffCmd: { type: 'string', description: 'exact git diff command scoped to the task\'s commits' },
    claims: { type: 'array', items: { type: 'string' }, description: 'each discrete claim from the builder\'s Verification log entry' },
    criteria: { type: 'array', items: { type: 'string' }, description: 'acceptance criteria verbatim' },
    attackAngles: { type: 'array', items: { type: 'string' }, description: 'the task\'s own Adversarial verification angles verbatim' },
    evidencePaths: { type: 'array', items: { type: 'string' } },
    replayRecordings: { type: 'array', items: { type: 'string' }, description: 'Replay recording IDs/URLs cited in the claim' },
    changedHunks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'lines'],
        properties: { file: { type: 'string' }, lines: { type: 'string' }, summary: { type: 'string' } },
      },
    },
  },
}

const LEAD_FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings', 'completion', 'notes'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'severity', 'statement', 'citation', 'demand'],
        properties: {
          kind: { type: 'string', enum: ['falsified', 'insufficient-coverage', 'env-dependence', 'self-licking-test', 'sabotage-survived', 'fuzz-crash', 'replay-contradiction', 'other'] },
          severity: { type: 'string', enum: ['blocking', 'follow-up'], description: 'blocking only for a task criterion, explicit security/correctness contract, or required evidence gap' },
          statement: { type: 'string', description: 'prediction made, observed value — never an opinion' },
          citation: { type: 'string', description: 'event-log file+offset, digest, fixture path, Replay recording ID + point in time, or diff hunk — a point anyone can jump to' },
          demand: { type: 'string', description: 'one sentence: what the builder must do' },
        },
      },
    },
    completion: {
      type: 'object',
      required: ['criteria', 'hunks', 'attacks', 'sabotage', 'environment', 'coldClone'],
      properties: {
        criteria: { type: 'array', items: { type: 'string' }, description: 'one completed prediction/result record per criterion' },
        hunks: { type: 'array', items: { type: 'string' }, description: 'one executed/dead/waived record per changed hunk' },
        attacks: { type: 'array', items: { type: 'string' }, description: 'one result per task attack plus one novel attack' },
        sabotage: { type: 'array', items: { type: 'string' }, description: 'three distinct mutation/result records' },
        environment: { type: 'string', description: 'environment and fixture hunt result' },
        coldClone: { type: 'string', enum: ['passed', 'not-run-blocked'], description: 'one cold clone passed, or was skipped because a blocking finding already existed' },
      },
    },
    notes: { type: 'string', description: 'what was attacked and survived — the judge needs this for the log entry' },
  },
}

const REPLAY_FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings', 'notes'],
  properties: {
    findings: LEAD_FINDINGS_SCHEMA.properties.findings,
    notes: LEAD_FINDINGS_SCHEMA.properties.notes,
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'logEntry', 'baseCommit', 'commitOid'],
  properties: {
    verdict: { type: 'string', enum: ['verified', 'refuted', 'needs-evidence'] },
    logEntry: { type: 'string' },
    baseCommit: { type: 'string', description: 'full git OID observed immediately before the verdict write' },
    commitOid: { type: 'string', description: 'full git OID observed immediately after committing the verdict' },
    promoted: { type: 'array', items: { type: 'string' }, description: 'suite artifacts promoted: tests, golden event logs, fuzz seeds, verify targets' },
    report: { type: 'string', description: 'summary for the builder if refuted/needs-evidence' },
  },
}

const DOCTRINE = `You are an adversarial CRITIC per AGENTS.md (read it first — the Critic charter section is your contract). You never fix implementation code. Your goal is to REFUTE the claim, not confirm it. Every finding must cite a point anyone can jump to. Honor the NO-FIRE LIST: no style nits, no performance findings without a stated budget, nothing you cannot anchor to an event-log offset, digest, recording point, or diff line. A finding is blocking when it falsifies an acceptance criterion, a builder claim, an explicit security/correctness contract, required evidence coverage, or the mandatory sensitivity of the measuring apparatus. Apparatus polish, wording that does not make the claim false, and useful hardening outside the task threat model are follow-ups. Re-check every finding once before raising it.`

phase('Orient')

const brief = await agent(
  `${DOCTRINE}

ORIENT ONLY — no attacks yet. ${args?.task ? `Target task: ${args.task}.` : 'Target: the first task in .eforest/tasks/QUEUE.md with status implemented ([?]).'}
A task is a FOLDER (.eforest/tasks/epic-*/E*-T*-slug/) whose spec is its readme.md; its committed evidence lives in evidence/ inside it. Read the task readme (claims in its Verification log, acceptance criteria, Adversarial verification section), determine the git diff scoped to the task's commits (git log for commits mentioning the task id since the last verified entry), and list every changed hunk. Extract the evidence paths and any Replay recording IDs/URLs from the builder's log entry. Cheap sweeps: does the cited evidence exist on disk, does any digest mismatch the claimed one (a builder citing a stale event log fails immediately — report ok:false with reason), any test .skip'd/.todo'd or lint rule disabled inline in the diff (report as a changedHunk summary).`,
  { label: 'orient', phase: 'Orient', schema: BRIEF_SCHEMA, effort: 'high' }
)

if (!brief?.ok) {
  log(`cannot verify: ${brief?.reason ?? 'orient failed'}`)
  return { verdict: 'needs-evidence', reason: brief?.reason ?? 'orient failed' }
}
// Schema-optional fields: normalize so a conforming-but-sparse orient can't crash the attack phase.
brief.replayRecordings ??= []
brief.evidencePaths ??= []
if (!brief.criteria.length) {
  log('orient produced zero acceptance criteria — refusing to verify')
  return { verdict: 'needs-evidence', reason: 'orient extracted no acceptance criteria; the falsification arm would be empty' }
}
log(`attacking ${brief.taskId}: ${brief.claims.length} claims, ${brief.changedHunks.length} hunks, ${brief.replayRecordings.length} recording(s)`)

phase('Attack')

const ctx = `Task ${brief.taskId} (${brief.taskPath}). Diff: ${brief.diffCmd}. Evidence: ${JSON.stringify(brief.evidencePaths)}. Builder claims: ${JSON.stringify(brief.claims)}.`

// One lead critic owns the whole finite threat model. This preserves adversarial depth
// while avoiding seven agents independently reinstalling, rebuilding, and rediscovering
// the same context. Its disposable worktree is also the sabotage surface.
const lead = await agent(
  `${DOCTRINE}\n${ctx}\n\nYou are the LEAD CRITIC in a disposable worktree. Execute this order:\n1. Cheap integrity sweep: exact-head evidence exists and matches; no skipped/todo tests or disabled lint in the diff. Do not rerun unchanged root fmt/lint/typecheck/test/build commands already cited by the exact candidate unless their attestation is stale.\n2. For EVERY criterion below, state a falsifiable prediction before inspection and use the narrowest targeted command or replay/digest probe that can falsify it.\n3. Hold every changed hunk against evidence coverage; classify unexecuted behavior as needs-evidence, dead, or explicitly waived.\n4. Run every task attack with fresh inputs and one novel attack.\n5. Sabotage at least three materially distinct changed behaviors in this disposable worktree and confirm the focused tests go red. Restore between mutations. A measuring apparatus that survives its relevant mutation is blocking.\n6. Hunt inherited environment, warm services, self-computed goldens, and magic constants.\n7. ONLY if steps 1-6 produce no blocking finding, run exactly ONE registered task-specific cold clone. Do not run a second cold clone and do not run it beside any other suite. For a capstone, that one cold clone includes its required end-to-end cold start.\n\nCriteria:\n${brief.criteria.map(c => `- ${c}`).join('\n')}\n\nTask attacks:\n${brief.attackAngles.map(a => `- ${a}`).join('\n')}\n\nChanged hunks:\n${brief.changedHunks.map(h => `- ${h.file}:${h.lines} ${h.summary ?? ''}`).join('\n')}\n\nReport failures with severity. The completion manifest is mandatory: exactly one record per criterion, at least one per hunk, one per task attack plus a novel attack, at least three distinct sabotage records, a nonempty environment result, and coldClone=passed unless a blocking finding caused not-run-blocked.${brief.capstone ? '\nThis is a capstone: the single cold-clone run must include the end-to-end demo with fresh state.' : ''}`,
  { label: 'lead-critic', phase: 'Attack', schema: LEAD_FINDINGS_SCHEMA, effort: 'xhigh', isolation: 'worktree' }
)

// Replay inspection requires the Replay-specialized role. It is an evidence reader, not
// another general critic, and all recordings are handled in one session.
const replay = brief.replayRecordings.length
  ? await agent(
      `${ctx}\n\nYou are the single REPLAY EVIDENCE READER for all cited recordings: ${JSON.stringify(brief.replayRecordings)}. Inspect them through Replay MCP; never drive a fresh browser. Run global console/network/exception checks, then test the browser-layer claims and changed browser hunks at specific timeline points. Report only evidence-backed contradictions or coverage gaps, with severity. If MCP is unavailable, return one blocking insufficient-coverage finding naming the missing capability. Put what survived in notes.`,
      { label: 'replay-evidence', phase: 'Attack', schema: REPLAY_FINDINGS_SCHEMA, effort: 'high', agentType: 'replay-critic' }
    )
  : null

const failedAttackers = [!lead ? 'lead-critic' : null, brief.replayRecordings.length && !replay ? 'replay-evidence' : null].filter(Boolean)
const rawResults = [lead, replay].filter(Boolean)
const survivedNotes = rawResults.map(r => r.notes).filter(Boolean)
const findings = rawResults.flatMap(r => r.findings ?? [])
const leadBlocking = (lead?.findings ?? []).some(f => f.severity === 'blocking')
const leadComplete = !!lead &&
  lead.completion?.criteria?.length === brief.criteria.length &&
  lead.completion?.hunks?.length >= brief.changedHunks.length &&
  lead.completion?.attacks?.length >= brief.attackAngles.length + 1 &&
  lead.completion?.sabotage?.length >= 3 &&
  typeof lead.completion?.environment === 'string' && lead.completion.environment.trim().length > 0 &&
  (lead.completion?.coldClone === 'passed' || (leadBlocking && lead.completion?.coldClone === 'not-run-blocked'))
if (!leadComplete) failedAttackers.push('lead-completion-manifest')
if (failedAttackers.length) log(`REQUIRED REVIEWER FAILED: ${failedAttackers.join(', ')} — verdict is capped at needs-evidence`)
log(`${findings.length} raw finding(s) from consolidated lead review${replay ? ' + Replay evidence' : ''}`)

phase('Verdict')

const verdict = await agent(
  `${DOCTRINE}\n${ctx}\n\nYou are the fresh SKEPTIC/JUDGE. The lead critic never gets to convict on its own. Batch cross-examine every raw finding: reproduce its citation, try to refute its reasoning, enforce the finite task threat model and NO-FIRE list, and downgrade only non-claim, non-sensitivity apparatus polish or out-of-scope hardening to follow-up. Raw findings:\n${JSON.stringify(findings, null, 1)}\n${failedAttackers.length ? `\nREQUIRED REVIEWERS THAT RETURNED NO RESULT: ${failedAttackers.join(', ')} — their angles are UNVERIFIED, so the verdict must NOT be verified.\n` : ''}\nWhat survived the lead review:\n${survivedNotes.join('\n')}\n\nPer AGENTS.md Critic charter:
1. Verdict: refuted only if a blocking falsification survives your cross-examination; needs-evidence only if the surviving blocking items are coverage/evidence gaps; verified when no blocking item stands. Follow-ups are logged as non-refuting and do not block.
2. SUITE (only if verified): judge what survives as a permanent artifact — promote a deterministic test asserting what YOU verified, check in golden event logs/digests as fixtures, add fuzz corpus entries, or a make verify-* recipe; or discard with one line of why. Commit promotions.
3. Before editing, record the full current git OID as baseCommit; it must equal the orchestrator's expected base ${args?.baseCommit ?? '(not supplied)'}. Append the log entry to ${brief.taskPath}/readme.md with the exact heading form "YYYY-MM-DD — judge round ${args?.run ?? '(missing run)'} — VERDICT: <verdict>". Include at least one top-level evidence bullet even when verified (surviving criteria/coverage and SUITE disposition); every failure bullet includes prediction, observed value, citation, and demand. Include a Commands line. Flip status to verified, or to refuted for either non-verified verdict. Run python3 tools/build_queue.py. Commit only the allowed verdict artifacts, record the new full git OID as commitOid, and return both OIDs. A boolean claim of persistence is not evidence.
Return the verdict, the exact complete log entry as committed (including its heading), both full OIDs, and (if not verified) a report for the builder.`,
  { label: 'verdict', phase: 'Verdict', schema: VERDICT_SCHEMA, effort: 'xhigh' }
)

let finalVerdict = verdict?.verdict ?? 'needs-evidence'
if (failedAttackers.length && finalVerdict === 'verified') finalVerdict = 'needs-evidence'
log(`VERDICT for ${brief.taskId}: ${finalVerdict}${verdict?.verdict === 'verified' && finalVerdict !== 'verified' ? ` (downgraded from verified: attackers failed — ${failedAttackers.join(', ')})` : ''}`)

return {
  taskId: brief.taskId,
  verdict: finalVerdict,
  baseCommit: verdict?.baseCommit ?? '',
  commitOid: verdict?.commitOid ?? '',
  findings,
  promoted: verdict?.promoted ?? [],
  report: verdict?.report ?? '',
  logEntry: verdict?.logEntry ?? '',
}
