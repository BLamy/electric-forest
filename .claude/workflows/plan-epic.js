export const meta = {
  name: 'plan-epic',
  description: 'Decompose a roadmap epic into task folders: independent proposals, a judge, parallel authors, then adversarial review of the task specs themselves',
  whenToUse: 'Run when an epic in ROADMAP.md needs its .eforest/tasks/ folder populated (or refreshed). args {epic: 3} required; {angle: "..."} optionally biases one proposal.',
  phases: [
    { title: 'Propose', detail: 'two independent decompositions of the epic' },
    { title: 'Judge', detail: 'merge into one task list with real dependencies' },
    { title: 'Author', detail: 'one writer per task folder' },
    { title: 'Attack the specs', detail: 'critics test acceptance criteria for binary-checkability and attack angles for teeth' },
  ],
}

if (args?.epic === undefined || args?.epic === null) {
  throw new Error('plan-epic requires args {epic: <number>} — which ROADMAP.md epic to decompose')
}
const EPIC = args.epic

const TASKLIST_SCHEMA = {
  type: 'object', required: ['tasks', 'rationale'],
  properties: {
    rationale: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'slug', 'estimate', 'depends_on', 'summary'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, slug: { type: 'string' },
          estimate: { type: 'string', enum: ['S', 'M', 'L'] },
          depends_on: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string', description: '2-3 sentences: outcome, key deliverables, what evidence proves it' },
          capstone: { type: 'boolean' },
        },
      },
    },
  },
}

const AUTHOR_SCHEMA = {
  type: 'object', required: ['written', 'path'],
  properties: { written: { type: 'boolean' }, path: { type: 'string' } },
}

const CRITIQUE_SCHEMA = {
  type: 'object', required: ['verdict', 'problems'],
  properties: {
    verdict: { type: 'string', enum: ['sharp', 'dull'] },
    problems: {
      type: 'array',
      items: {
        type: 'object', required: ['section', 'problem', 'fix'],
        properties: { section: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } },
      },
    },
  },
}

phase('Propose')

const CONTEXT = `Read ROADMAP.md (epic ${EPIC}'s section and its capstone demo), AGENTS.md (the evidence doctrine your tasks must be provable under), .eforest/tasks/README.md (format: a task is a FOLDER E{n}-T{nn}-{slug}/ containing readme.md; priority = epic*100 + task number), and .eforest/tasks/QUEUE.md if it exists (what is already verified/planned — including any existing epic-${EPIC} tasks; propose replacements only for ones still pending). One task = one focused session (S/M/L ≈ hours/half-day/day-plus).`

const proposals = (await parallel([
  `${CONTEXT}\nPropose the complete ordered task list for epic ${EPIC}. Sequence for demo-ability: the earliest tasks should light up visible, testable behavior; exactly one capstone task, last, whose demo is the epic's capstone demo from ROADMAP.md. ${args?.angle ?? ''}`,
  `${CONTEXT}\nPropose the complete ordered task list for epic ${EPIC}. Sequence for evidence: every feature task must be verifiable the moment it lands (what event log/state digest/convergence diff/Replay recording proves it?), and add explicit tasks for any missing verification infrastructure. Exactly one capstone task, last.`,
].map((p, i) => () =>
  agent(p, { label: `propose:${i === 0 ? 'demo-first' : 'evidence-first'}`, phase: 'Propose', schema: TASKLIST_SCHEMA, effort: 'high' })
))).filter(Boolean)

phase('Judge')

if (!proposals.length) throw new Error('both proposal agents failed — rerun plan-epic')
if (proposals.length < 2) log('only 1/2 proposals returned — judge merges a single decomposition; adversarial redundancy degraded')

const plan = await agent(
  `${CONTEXT}\n${proposals.length} independent decomposition(s) of epic ${EPIC}:\n${JSON.stringify(proposals, null, 1)}\nMerge into ONE definitive list: ids E${EPIC}-T01.. contiguous, real dependencies only (keep the graph wide — several tasks eligible at once where possible), exactly one capstone last. Every task's summary must name the evidence that will prove it.`,
  { label: 'judge', phase: 'Judge', schema: TASKLIST_SCHEMA, effort: 'xhigh' }
)
if (!plan?.tasks?.length) throw new Error('judge returned no tasks')
log(`epic ${EPIC}: ${plan.tasks.length} tasks planned`)

phase('Author')

const authorOne = t => agent(
  `Write the task folder for ${t.id} in this repo. ${CONTEXT}
Task: ${JSON.stringify(t, null, 1)}
Full epic plan for context (dependencies must reference these ids): ${JSON.stringify(plan.tasks.map(x => ({ id: x.id, title: x.title })), null, 1)}

Create .eforest/tasks/<epic-${EPIC}-folder>/${t.id}-${t.slug}/readme.md, matching the epic folder naming in ROADMAP.md ("the scale" section) and .eforest/tasks/ exactly. Follow .eforest/tasks/README.md format: flat-YAML frontmatter (id, epic, title, priority = ${EPIC}*100 + task number, status: pending, depends_on inline list, estimate, capstone), then Goal (outcome, not activity, with exact package names/endpoints/types), Context, Deliverables (concrete packages/files/functions/endpoints/tests), Acceptance criteria (checkboxes, objective and binary-checkable, tied to evidence: event-log offsets, state digests, convergence diffs, Replay recordings), Adversarial verification (written FOR a hostile critic: concrete attack angles — fuzzing, sabotage, differential, cold-start — what to diff against, what constitutes refutation; study 2-3 existing task readmes first if any exist and match their teeth), empty Verification log. Only readme.md goes in the folder now (work/ and evidence/ appear when a builder works it). Do not commit.`,
  { label: `author:${t.id}`, phase: 'Author', schema: AUTHOR_SCHEMA }
)

const critiqueOne = (written, t) => {
  if (!written?.written) return null
  return agent(
    `You are a hostile reviewer of TASK SPECS (not code) for this repo. Read ${written.path} and AGENTS.md.
Attack it: Is every acceptance criterion binary-checkable by a critic with no goodwill (no "works correctly", no "reasonable")? Does each criterion name its evidence layer (stream event log/digest vs Replay recording)? Do the Adversarial verification angles have teeth — could they actually refute a lazy implementation, including at least one sabotage/fuzz/differential/cold-start angle where applicable? Are depends_on real and minimal? Is the priority exactly ${EPIC}*100 + its task number (fractional only with a stated reason)? Verdict "dull" if ANY problem found.`,
    { label: `critique:${t.id}`, phase: 'Attack the specs', schema: CRITIQUE_SCHEMA, effort: 'high' }
  ).then(async crit => {
    if (!crit || crit.verdict === 'sharp' || !crit.problems?.length) return { id: t.id, path: written.path, status: 'sharp' }
    await agent(
      `Fix these problems in the task readme ${written.path} (edit in place, keep everything else; do not commit):\n${JSON.stringify(crit.problems, null, 1)}`,
      { label: `sharpen:${t.id}`, phase: 'Attack the specs', schema: AUTHOR_SCHEMA }
    )
    return { id: t.id, path: written.path, status: 'sharpened', problems: crit.problems.length }
  })
}

const results = (await pipeline(plan.tasks, authorOne, critiqueOne)).filter(Boolean)

const rebuilt = await agent(
  'Run python3 tools/build_queue.py in this repo and report its output verbatim, including every warning. Do not commit.',
  { label: 'rebuild-queue', phase: 'Attack the specs', schema: { type: 'object', required: ['output'], properties: { output: { type: 'string' } } }, effort: 'low' }
)
log(`queue rebuilt: ${rebuilt?.output ?? 'no output'}`)

return { epic: EPIC, planned: plan.tasks.length, results, queueOutput: rebuilt?.output }
