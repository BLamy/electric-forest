export const meta = {
  name: 'roadmap-audit',
  description: 'Audit the truthfulness of the board: queue vs task readmes, statuses vs Verification logs, project state vs reality, doctrine references vs the actual tree',
  whenToUse: 'Run periodically or when the queue feels stale — catches statuses that lie, deps that dangle, a project.json state that no longer matches the queue, and an app silently falling behind what is verified.',
  phases: [
    { title: 'Audit', detail: 'four independent auditors' },
    { title: 'Mend', detail: 'apply mechanical fixes; report judgment calls' },
  ],
}

const AUDIT_SCHEMA = {
  type: 'object', required: ['auditor', 'issues'],
  properties: {
    auditor: { type: 'string' },
    issues: {
      type: 'array',
      items: {
        type: 'object', required: ['what', 'where', 'severity', 'mechanicalFix'],
        properties: {
          what: { type: 'string' },
          where: { type: 'string', description: 'file / task id' },
          severity: { type: 'string', enum: ['lie', 'dangling', 'stale', 'cosmetic'] },
          mechanicalFix: { type: 'string', description: 'exact edit if it is safe to apply mechanically; empty if it needs a human/judgment' },
        },
      },
    },
  },
}

phase('Audit')

const AUDITORS = [
  {
    key: 'queue-integrity',
    prompt: `Run python3 tools/build_queue.py and capture every warning. Then check every task folder under .eforest/tasks/epic-*/: readme.md frontmatter parses, id matches the folder name, priority == epic*100 + task number (fractional allowed only with a stated reason in a comment), status is a legal value, every depends_on references an existing task id or epic id, no dependency cycles, exactly one capstone per epic. QUEUE.md must be byte-identical to a fresh rebuild (a hand-edited QUEUE.md is a lie).`,
  },
  {
    key: 'status-truth',
    prompt: `For every task with status verified or implemented: does its readme's Verification log actually contain the required entries (builder claim with commit hash + evidence paths for implemented; a critic VERDICT entry for verified)? A verified task whose log has no critic entry — or whose verdict line says refuted/needs-evidence — is a lie, the worst severity. For in-progress tasks: is more than one task in-progress at once (doctrine says one in-flight)? Also audit .eforest/project.json: its status must match reality per .eforest/loop.md (e.g. "complete" with pending tasks is a lie; "building" with an un-actioned invalid_loop trigger recorded in a task log is stale).`,
  },
  {
    key: 'app-drift',
    prompt: `Compare what .eforest/tasks/QUEUE.md says is verified against what ROADMAP.md claims and what the web app surfaces (read apps/web if present; before Epic 3 lands report inapplicable rather than inventing checks). Per AGENTS.md the app must never silently fall behind what's landed: every verified browser-reaching capability should be visible/reachable, and nothing should be marked live/verified that isn't. List each drift.`,
  },
  {
    key: 'doctrine-refs',
    prompt: `Read AGENTS.md, CLAUDE.md, .eforest/loop.md, .eforest/tasks/README.md, ROADMAP.md, tools/replay/README.md and every .claude/workflows/*.js meta. Check every concrete reference against the tree: cited scripts exist (tools/build_queue.py, tools/verify/*, tools/replay/*), cited make targets exist in the Makefile, cited task ids exist, cited MCP setup instructions match .mcp.json / documented ports. A doctrine that references tooling that doesn't exist yet must say WHICH task or epic delivers it — flag any that don't.`,
  },
]

const audits = (await parallel(AUDITORS.map(a => () =>
  agent(
    `You are the ${a.key} auditor for this repo's task system (read AGENTS.md and .eforest/tasks/README.md first). Report issues only — never edit anything. ${a.prompt}`,
    { label: `audit:${a.key}`, phase: 'Audit', schema: AUDIT_SCHEMA, effort: 'high' }
  )
))).filter(Boolean)

const issues = audits.flatMap(a => (a.issues ?? []).map(i => ({ ...i, auditor: a.auditor })))
const lies = issues.filter(i => i.severity === 'lie')
log(`${issues.length} issue(s); ${lies.length} lie(s)`)

phase('Mend')

const mechanical = issues.filter(i => i.mechanicalFix)
let mended = []
if (mechanical.length) {
  const m = await agent(
    `Apply these mechanical fixes to the repo exactly as specified (nothing beyond them), then run python3 tools/build_queue.py. Do not commit. Fixes:\n${JSON.stringify(mechanical, null, 1)}`,
    { label: 'mend', phase: 'Mend', schema: { type: 'object', required: ['applied'], properties: { applied: { type: 'array', items: { type: 'string' } } } } }
  )
  mended = m?.applied ?? []
}

return {
  issues,
  lies,
  mended,
  needsHuman: issues.filter(i => !i.mechanicalFix),
}
