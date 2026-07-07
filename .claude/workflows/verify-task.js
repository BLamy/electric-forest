export const meta = {
  name: 'verify-task',
  description: 'Adversarial verification: fresh hostile sessions attack an implemented task\'s claim from every direction, then a judge issues the verdict',
  whenToUse: 'Run against a task with status: implemented (args {task: "E0-T03"}, default: first implemented task in the queue). Never run it from the session that implemented.',
  phases: [
    { title: 'Orient', detail: 'read claim, diff, evidence; build the attack brief' },
    { title: 'Attack', detail: 'parallel critics: falsify, coverage, mocks/env, sabotage, fuzz, Replay interrogation' },
    { title: 'Cross-examine', detail: 'every finding is itself adversarially re-verified' },
    { title: 'Verdict', detail: 'judge writes the log entry, flips status, promotes suite artifacts' },
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

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'statement', 'citation', 'demand'],
        properties: {
          kind: { type: 'string', enum: ['falsified', 'insufficient-coverage', 'env-dependence', 'self-licking-test', 'sabotage-survived', 'fuzz-crash', 'replay-contradiction', 'other'] },
          statement: { type: 'string', description: 'prediction made, observed value — never an opinion' },
          citation: { type: 'string', description: 'event-log file+offset, digest, fixture path, Replay recording ID + point in time, or diff hunk — a point anyone can jump to' },
          demand: { type: 'string', description: 'one sentence: what the builder must do' },
        },
      },
    },
    notes: { type: 'string', description: 'what was attacked and survived — the judge needs this for the log entry' },
  },
}

const XCHECK_SCHEMA = {
  type: 'object',
  required: ['stands', 'reason'],
  properties: {
    stands: { type: 'boolean', description: 'true if the finding survives your attempt to refute it' },
    reason: { type: 'string' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['verdict', 'logEntry', 'committed'],
  properties: {
    verdict: { type: 'string', enum: ['verified', 'refuted', 'needs-evidence'] },
    logEntry: { type: 'string' },
    committed: { type: 'boolean' },
    promoted: { type: 'array', items: { type: 'string' }, description: 'suite artifacts promoted: tests, golden event logs, fuzz seeds, verify targets' },
    report: { type: 'string', description: 'summary for the builder if refuted/needs-evidence' },
  },
}

const DOCTRINE = `You are an adversarial CRITIC per AGENTS.md (read it first — the Critic charter section is your contract). You never fix implementation code. Your goal is to REFUTE the claim, not confirm it. Every finding must cite a point anyone can jump to. Honor the NO-FIRE LIST: no style nits, no performance findings without a stated budget, nothing you cannot anchor to an event-log offset, digest, recording point, or diff line. Re-check every finding once before raising it.`

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

// Chunk acceptance criteria so each falsifier holds a few predictions deeply.
const chunks = []
for (let i = 0; i < brief.criteria.length; i += 3) chunks.push(brief.criteria.slice(i, i + 3))

const ctx = `Task ${brief.taskId} (${brief.taskPath}). Diff: ${brief.diffCmd}. Evidence: ${JSON.stringify(brief.evidencePaths)}. Builder claims: ${JSON.stringify(brief.claims)}.`

const attackers = [
  ...chunks.map((c, i) => ({
    label: `falsify:${i + 1}`,
    prompt: `${DOCTRINE}\n${ctx}\n\nFALSIFICATION. For each acceptance criterion below, write a falsifiable prediction about concrete program state at a specific point BEFORE inspecting that state (a prediction made after looking is a caption, not a check). Then verify with the narrowest tool that can falsify it: replaying cited event logs to state digests, digest-bisecting divergences to exact offsets, driving two independent clients and diffing their canonical state, or re-running the evidence commands yourself. Criteria:\n${c.map(x => `- ${x}`).join('\n')}\nReport only failures and near-misses as findings; put what survived in notes.`,
  })),
  {
    label: 'coverage',
    prompt: `${DOCTRINE}\n${ctx}\n\nCOVERAGE. Hold the recorded evidence run against the diff. For each changed hunk, determine whether it executed during the evidence run (instrument, add temporary logging in a scratch checkout, re-run the recorded commands — whatever gives ground truth; never edit the real tree). Classify every unexecuted hunk: needs-evidence (name the exact run the builder must record), dead (demand deletion), or waived (types/config/logging — one line of reasoning each). Hunks:\n${brief.changedHunks.map(h => `- ${h.file}:${h.lines} ${h.summary ?? ''}`).join('\n')}`,
  },
  {
    label: 'mock-env-hunt',
    prompt: `${DOCTRINE}\n${ctx}\n\nMOCK & ENV HUNT. Find every fixture the evidence run depended on: hardcoded golden values computed by the code under test (self-licking test), magic constants, seeded RNG defaults, NODE_ENV-conditional behavior leaking semantics, inherited environment, a stream server left warm from development (stale data dir, reused ports/offsets). Cold-clone rule: run the acceptance commands from a pristine clone in a scratch dir with scrubbed env (NODE_OPTIONS, NODE_ENV, npm_config_* unset) — use tools/verify/cold_clone.sh if it exists, otherwise git clone to a temp dir yourself. "Works on the builder's machine" is a refutation, not an excuse.`,
  },
  {
    label: 'sabotage',
    isolation: 'worktree',
    prompt: `${DOCTRINE}\n${ctx}\n\nSABOTAGE CHECK (you are in a disposable worktree — break things freely). Deliberately break the implementation the diff introduced (invert a condition, off-by-one an offset, drop an event from the log, swap two appended messages) and confirm the builder's tests actually go red. A test suite that stays green under sabotage is a finding (kind: sabotage-survived) citing the exact mutation. Try at least 3 distinct mutations targeting different changed hunks.`,
  },
  {
    label: 'own-attacks',
    prompt: `${DOCTRINE}\n${ctx}\n\nRUN THE TASK'S OWN ATTACKS — with your own seeds/inputs, never the builder's — and invent at least ONE attack the list doesn't mention. Where the diff touches parsing, offsets, sync, or merge logic, fuzz it: malformed events, out-of-order appends, concurrent writers, truncated streams, duplicate offsets. The task's angles:\n${brief.attackAngles.map(a => `- ${a}`).join('\n')}${brief.capstone ? '\n\nCAPSTONE: additionally perform the demo end-to-end from a cold start (fresh clone, fresh browser profile, fresh stream-server data dir). Any dependence on development leftovers is a refutation.' : ''}`,
  },
  ...brief.replayRecordings.map(r => ({
    label: `replay:${String(r).slice(-12)}`,
    agentType: 'replay-critic',
    prompt: `${ctx}\n\nREPLAY INTERROGATION of recording ${r}, on behalf of the adversarial critic for task ${brief.taskId} (the repo doctrine is AGENTS.md; your own critic charter applies — you are read-only, you inspect evidence, you never drive a fresh browser). Note: you are invoked with a structured output schema — report each would-be VERDICT bullet as a finding in that schema; your charter's textual VERDICT/SUITE format applies only to freeform invocations. Inspect the recording through the Replay MCP tools (server "replay" from this repo's .mcp.json — npx -y replayio mcp; load the tools via ToolSearch query "replay"). If the MCP tools are unavailable, return a single finding (kind: other) that browser-layer evidence is uninspectable and name the missing capability. Otherwise: orient on the timeline (interactions, network, console, exceptions), run cheap global checks first (uncaught exceptions, failed requests, console errors from our bundles), then for each browser-layer claim write a falsifiable prediction at a specific timeline point BEFORE inspecting it. Hold the recording against the diff hunks: changed browser-reaching behavior that never executed in the session is insufficient-coverage. Audit recorded sources/state for fixture data production could not ship, and confirm claimed stream offsets/digests exposed in the DOM exist IN the recording. Every finding cites the recording ID plus a point/timeline link anyone can open.`,
  })),
]

const attackerResults = await parallel(attackers.map(a => () =>
  agent(a.prompt, { label: a.label, phase: 'Attack', schema: FINDINGS_SCHEMA, effort: 'high', isolation: a.isolation, agentType: a.agentType })
))
// A silently-dead attacker must never read as "nothing found" — that path ends at a false 'verified'.
const failedAttackers = attackers.filter((a, i) => !attackerResults[i]).map(a => a.label)
const rawFindings = attackerResults.filter(Boolean)
if (failedAttackers.length) log(`ATTACKERS FAILED (no result): ${failedAttackers.join(', ')} — verdict is capped at needs-evidence`)

const survivedNotes = rawFindings.map(r => r.notes).filter(Boolean)
const findings = rawFindings.flatMap(r => r.findings ?? [])
log(`${findings.length} raw finding(s) from ${rawFindings.length}/${attackers.length} attacker(s)`)

phase('Cross-examine')

// A refutation is also a claim. Each finding must survive its own skeptic before it
// reaches the judge — this is what keeps false refutations from thrashing the queue.
const confirmed = (await parallel(findings.map(f => () =>
  agent(
    `${DOCTRINE}\n${ctx}\n\nCROSS-EXAMINE this finding raised by another critic. Try to REFUTE the finding itself: re-derive it from the citation, check the cited point actually shows what the finding says, check it isn't on the NO-FIRE list, check the demand follows. Finding:\n${JSON.stringify(f, null, 1)}\nIf you cannot reproduce the citation or the reasoning, it does not stand.`,
    { label: `xcheck:${f.kind}`, phase: 'Cross-examine', schema: XCHECK_SCHEMA, effort: 'high' }
  ).then(v => (v?.stands ? { ...f, xcheck: v.reason } : null))
))).filter(Boolean)

log(`${confirmed.length}/${findings.length} finding(s) survived cross-examination`)

phase('Verdict')

const verdict = await agent(
  `${DOCTRINE}\n${ctx}\n\nYou are the VERDICT judge. Confirmed findings (each survived independent cross-examination):\n${JSON.stringify(confirmed, null, 1)}\n${failedAttackers.length ? `\nATTACKERS THAT RETURNED NO RESULT: ${failedAttackers.join(', ')} — their angles are UNVERIFIED, so the verdict must NOT be 'verified'; at best 'needs-evidence' naming these angles.\n` : ''}\nWhat the attackers report survived:\n${survivedNotes.join('\n')}\n\nPer AGENTS.md Critic charter:
1. Verdict: refuted if any finding falsifies a claim/criterion; needs-evidence if the only confirmed findings are coverage/evidence gaps; verified only if nothing stands.
2. SUITE (only if verified): judge what survives as a permanent artifact — promote a deterministic test asserting what YOU verified, check in golden event logs/digests as fixtures, add fuzz corpus entries, or a make verify-* recipe; or discard with one line of why. Commit promotions.
3. Append the log entry to ${brief.taskPath}/readme.md in the AGENTS.md example format: first line "VERDICT: ...", one bullet per finding (prediction, observed, citation, demand), Commands: line. Flip status (verified, or back to in-progress with your report as the builder's new context; needs-evidence also goes back to in-progress). Run python3 tools/build_queue.py. Commit.
Return the verdict, the exact log entry, and (if not verified) a report for the builder.`,
  { label: 'verdict', phase: 'Verdict', schema: VERDICT_SCHEMA, effort: 'xhigh' }
)

let finalVerdict = verdict?.verdict ?? 'needs-evidence'
if (failedAttackers.length && finalVerdict === 'verified') finalVerdict = 'needs-evidence'
log(`VERDICT for ${brief.taskId}: ${finalVerdict}${verdict?.verdict === 'verified' && finalVerdict !== 'verified' ? ` (downgraded from verified: attackers failed — ${failedAttackers.join(', ')})` : ''}`)

return {
  taskId: brief.taskId,
  verdict: finalVerdict,
  findings: confirmed,
  promoted: verdict?.promoted ?? [],
  report: verdict?.report ?? '',
  logEntry: verdict?.logEntry ?? '',
}
