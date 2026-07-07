export const meta = {
  name: 'golden-sweep',
  description: 'Re-earn every standing verification: golden event logs, replay determinism, convergence fixtures, promoted tests, fuzz smoke, cold-clone',
  whenToUse: 'Run periodically (or before a release/deploy) to catch drift in verified behavior. args {fileTasks: true} to file regression tasks for confirmed drift.',
  phases: [
    { title: 'Sweep', detail: 'each verification family re-runs in a fresh session' },
    { title: 'Confirm', detail: 'every failure is independently reproduced before it counts' },
    { title: 'Report', detail: 'drift summary; optionally file regression tasks' },
  ],
}

const SWEEP_SCHEMA = {
  type: 'object', required: ['family', 'ran', 'failures'],
  properties: {
    family: { type: 'string' },
    ran: { type: 'string', description: 'exact commands executed' },
    inapplicable: { type: 'boolean', description: 'true if this family has no infrastructure yet per the queue state' },
    failures: {
      type: 'array',
      items: {
        type: 'object', required: ['what', 'expected', 'observed', 'citation'],
        properties: {
          what: { type: 'string' }, expected: { type: 'string' }, observed: { type: 'string' },
          citation: { type: 'string', description: 'file/digest/offset path + the command that shows it' },
        },
      },
    },
  },
}

const CONFIRM_SCHEMA = {
  type: 'object', required: ['reproduced', 'detail'],
  properties: { reproduced: { type: 'boolean' }, detail: { type: 'string' } },
}

phase('Sweep')

const PREAMBLE = `You are re-earning standing verifications in this repo (read AGENTS.md; Makefile verify-* targets and tools/verify/ are the entry points — tools/verify/list.sh enumerates them if present). If your family's infrastructure doesn't exist yet per .eforest/tasks/QUEUE.md, report inapplicable rather than inventing checks. Never fix anything; report real output.`

const FAMILIES = [
  { key: 'golden-logs', prompt: 'Replay every checked-in golden event-log fixture (task evidence/ folders and any shared corpus) and compare the resulting state digests against the committed expected values. Any mismatch: cite fixture path, expected vs observed digest, and save the diverging state dump for inspection.' },
  { key: 'replay-determinism', prompt: 'Run every replay/state-digest check TWICE from clean state and compare: the same event log replayed twice must produce byte-identical canonical state digests across runs (and across store backends — in-memory vs file-backed — where both exist).' },
  { key: 'convergence', prompt: 'Run the two-client convergence harness over the checked-in scenarios (two independent clients driven through the same branch stream must reduce to byte-identical canonical state). Any divergence is a failure with the scenario + first divergent offset cited.' },
  { key: 'promoted-tests', prompt: 'Run the full promoted test suite: pnpm test across the workspace. Every failure cites the test name and output tail.' },
  { key: 'fuzz-smoke', prompt: 'Run each fuzz target briefly (~60s each or the corpus replay mode) over the committed corpus — event parsers, offset arithmetic, patch/merge logic, concurrent-append interleavings. Any crash/unhandled rejection: cite the input file and stack.' },
  { key: 'cold-clone', prompt: 'Cold-clone rule spot check: run the top-level verify entry point from a pristine clone via tools/verify/cold_clone.sh verify-all (it clones committed HEAD into a scratch dir with scrubbed env). Failures here mean our evidence depends on this machine.' },
]

const sweeps = (await parallel(FAMILIES.map(f => () =>
  agent(`${PREAMBLE}\nFamily: ${f.key}. ${f.prompt}`, { label: `sweep:${f.key}`, phase: 'Sweep', schema: SWEEP_SCHEMA })
))).filter(Boolean)

const applicable = sweeps.filter(s => !s.inapplicable)
const rawFailures = applicable.flatMap(s => (s.failures ?? []).map(f => ({ ...f, family: s.family })))
log(`${applicable.length}/${sweeps.length} families applicable; ${rawFailures.length} raw failure(s)`)

phase('Confirm')

const confirmed = (await parallel(rawFailures.map(f => () =>
  agent(
    `${PREAMBLE}\nIndependently reproduce this reported failure from scratch (fresh commands, no shared state with the reporter). If you cannot reproduce it exactly as cited, it does not count.\n${JSON.stringify(f, null, 1)}`,
    { label: `confirm:${f.family}`, phase: 'Confirm', schema: CONFIRM_SCHEMA, effort: 'high' }
  ).then(v => (v?.reproduced ? { ...f, confirmed: v.detail } : null))
))).filter(Boolean)

log(`${confirmed.length}/${rawFailures.length} failure(s) confirmed`)

phase('Report')

let filedTasks = []
if (confirmed.length && args?.fileTasks) {
  filedTasks = (await parallel(confirmed.map(f => () =>
    agent(
      `File a regression task for this confirmed drift in the appropriate epic folder (read .eforest/tasks/README.md; a task is a FOLDER with a readme.md; next free T-number, "regression:" title prefix, fractional priority to jump the queue since previously-verified behavior broke). Acceptance criteria: the cited check passes again AND the critic re-runs it from a cold clone. Include the citation verbatim. Run python3 tools/build_queue.py. Do not commit.\n${JSON.stringify(f, null, 1)}`,
      { label: `file:${f.family}`, phase: 'Report', schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } }
    )
  ))).filter(Boolean)
}

return {
  families: sweeps.map(s => ({ family: s.family, inapplicable: !!s.inapplicable, failures: (s.failures ?? []).length })),
  confirmedDrift: confirmed,
  filedTasks,
}
