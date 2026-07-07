export const meta = {
  name: 'replay-triage',
  description: 'Interrogate production Replay recordings in parallel, cluster the defects, and file them as evidence-backed bug tasks in the queue',
  whenToUse: 'Run when production/dogfood Replay recordings need triage. args {recordings: ["<id-or-url>", ...]}; with no args, discovers recent recordings via the Replay MCP (server "replay" in .mcp.json).',
  phases: [
    { title: 'Discover', detail: 'resolve the recording list' },
    { title: 'Interrogate', detail: 'one fresh session per recording, via the Replay MCP' },
    { title: 'Cluster', detail: 'dedupe symptoms into distinct defects' },
    { title: 'File', detail: 'one bug task per defect, with the recording as mandatory evidence' },
  ],
}

const MCP_HINT = `Use the Replay MCP server (named "replay" in this repo's .mcp.json — it runs "npx -y replayio mcp" over stdio; load its tools via ToolSearch query "replay"). The replayio CLI is also available: "replayio list" enumerates local recordings, "replayio upload" pushes them. If the MCP tools fail to load, read tools/replay/README.md and report the connection problem instead of guessing.`

const DISCOVER_SCHEMA = {
  type: 'object', required: ['recordings'],
  properties: { recordings: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } },
}

const INTERROGATION_SCHEMA = {
  type: 'object',
  required: ['recording', 'symptoms'],
  properties: {
    recording: { type: 'string' },
    symptoms: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'observed', 'citation', 'suspectSubsystem', 'severity'],
        properties: {
          title: { type: 'string' },
          observed: { type: 'string', description: 'what the recording actually shows — console errors, failed requests, streams stuck behind head, stale trees after an edit, sync conflicts, auth loops' },
          citation: { type: 'string', description: 'recording ID + point in time/event, so anyone can jump to it' },
          reproSteps: { type: 'string', description: 'user actions leading up to it, reconstructed from the recording' },
          suspectSubsystem: { type: 'string', description: 'package/module most likely at fault, from source maps / stacks in the recording' },
          severity: { type: 'string', enum: ['crash', 'data-loss', 'wrong-state', 'degraded', 'cosmetic'] },
        },
      },
    },
    healthy: { type: 'string', description: 'what the session did successfully — clustering needs the negative space too' },
  },
}

const CLUSTER_SCHEMA = {
  type: 'object', required: ['defects'],
  properties: {
    defects: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'slug', 'severity', 'symptoms', 'suspectSubsystem'],
        properties: {
          title: { type: 'string' },
          slug: { type: 'string' },
          severity: { type: 'string' },
          suspectSubsystem: { type: 'string' },
          symptoms: { type: 'array', items: { type: 'object' }, description: 'the clustered symptom objects, citations intact' },
        },
      },
    },
  },
}

const FILE_SCHEMA = {
  type: 'object', required: ['filed', 'taskPath'],
  properties: { filed: { type: 'boolean' }, taskPath: { type: 'string' }, taskId: { type: 'string' } },
}

phase('Discover')

let recordings = args?.recordings
if (!recordings?.length) {
  const found = await agent(
    `${MCP_HINT}\nList the most recent Replay recordings available for this project (production and dogfood sessions). Return their IDs/URLs, most recent first, capped at 10.`,
    { label: 'discover', phase: 'Discover', schema: DISCOVER_SCHEMA, effort: 'low' }
  )
  recordings = found?.recordings ?? []
  if (found?.note) log(found.note)
}
if (!recordings.length) {
  log('no recordings to triage')
  return { defects: [], filed: [] }
}
log(`triaging ${recordings.length} recording(s)`)

phase('Interrogate')

const interrogations = (await parallel(recordings.map(r => () =>
  agent(
    `${MCP_HINT}\nYou are a production-triage critic for this repo (read AGENTS.md for the evidence doctrine). Interrogate Replay recording ${r} end to end, the way a critic interrogates a trace: reconstruct the user's session (events, console, network, DOM state over time), and report every symptom of misbehavior with a citation into the recording. Distinguish app defects from environmental noise (ad blockers, offline blips) — noise goes in "healthy", not symptoms. Check specifically for: console errors from our bundles, failed or hung stream requests (long-poll loops that never advance, offsets that regress), edits that never took effect or arrived out of order, trees that diverge between two views of the same branch, auth redirect loops, watcher sync conflicts surfacing wrongly.`,
    { label: `interrogate:${String(r).slice(-12)}`, phase: 'Interrogate', schema: INTERROGATION_SCHEMA }
  )
))).filter(Boolean)

const interrogationSummary = interrogations.map(i => ({ recording: i.recording, symptoms: i.symptoms?.length ?? 0 }))
const allSymptoms = interrogations.flatMap(i => i.symptoms ?? [])
log(`${allSymptoms.length} symptom(s) across ${interrogations.length} recording(s)`)
if (!allSymptoms.length) return { defects: [], filed: [], interrogations: interrogationSummary }

phase('Cluster')

// Barrier is deliberate: clustering needs every symptom from every recording at once.
const clustered = await agent(
  `Cluster these production symptoms into distinct defects (same root cause = one defect, keep every citation). Severity of a defect = worst severity among its symptoms. Symptoms:\n${JSON.stringify(allSymptoms, null, 1)}`,
  { label: 'cluster', phase: 'Cluster', schema: CLUSTER_SCHEMA, effort: 'high' }
)
const defects = clustered?.defects ?? []
log(`${defects.length} distinct defect(s)`)

phase('File')

const filed = (await parallel(defects.map(d => () =>
  agent(
    `File a bug task for this production defect in this repo's task system (read .eforest/tasks/README.md for the format — a task is a FOLDER with a readme.md — and AGENTS.md for the doctrine).
Defect: ${JSON.stringify(d, null, 1)}

Rules:
- Place it in the epic folder owning ${d.suspectSubsystem}, using the next free T-number in that epic (check existing folders AND other just-created bug tasks — re-list the folder right before writing). Title prefix "bug:".
- Priority: epic*100 + task number, but a crash/data-loss defect may take a fractional priority (e.g. 104.5) to jump the queue — say so in a frontmatter comment.
- Acceptance criteria must be binary-checkable and include: the Replay citations no longer reproduce (a NEW recording of the same steps shows the defect gone), plus a promoted regression test (and where the defect is stream-layer, the extracted event log replayed to a digest joins the regression corpus).
- The Adversarial verification section must instruct the critic to interrogate BOTH the original recording (defect present, citations: ${JSON.stringify(d.symptoms?.map(s => s.citation) ?? [])}) and the fix's new recording, via the Replay MCP (server "replay" in .mcp.json).
- Run python3 tools/build_queue.py after writing. Do not commit.`,
    { label: `file:${d.slug}`, phase: 'File', schema: FILE_SCHEMA }
  )
))).filter(Boolean)

log(`${filed.filter(f => f.filed).length}/${defects.length} bug task(s) filed; review + commit them yourself`)
return { defects, filed, interrogations: interrogationSummary }
