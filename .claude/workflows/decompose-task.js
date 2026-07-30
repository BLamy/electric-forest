export const meta = {
  name: 'decompose-task',
  description: 'Atomically split a task shape exhausted at run 10 into a finite, coverage-complete child graph',
  whenToUse: 'Called only by work-queue after a non-verified run 10. It preserves the parent ledger and starts one global three-run child probation.',
  phases: [
    { title: 'Partition', detail: 'fresh read-only critic assigns every criterion and finding' },
    { title: 'Attack', detail: 'fresh skeptic rejects overlap, gaps, resets, and false independence' },
    { title: 'Commit', detail: 'one writer atomically cancels parent, creates children, retargets dependents, and rebuilds queue' },
  ],
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['children', 'coverage'],
  properties: {
    children: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      items: {
        type: 'object',
        required: ['id', 'title', 'slug', 'goal', 'writeScope', 'dependsOn'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          slug: { type: 'string' },
          goal: { type: 'string' },
          writeScope: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    coverage: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['parentItem', 'childId'],
        properties: { parentItem: { type: 'string' }, childId: { type: 'string' } },
      },
    },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['safe', 'problems'],
  properties: {
    safe: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
  },
}

const COMMIT_SCHEMA = {
  type: 'object',
  required: ['baseCommit', 'commitOid', 'childIds', 'childPaths', 'changedPaths'],
  properties: {
    baseCommit: { type: 'string' },
    commitOid: { type: 'string' },
    childIds: { type: 'array', items: { type: 'string' } },
    childPaths: { type: 'array', items: { type: 'string' } },
    changedPaths: { type: 'array', items: { type: 'string' } },
  },
}

if (!args?.task || !args?.baseCommit || args?.globalProbationRuns !== 3) {
  throw new Error('decompose-task requires {task, baseCommit, globalProbationRuns: 3}')
}

phase('Partition')
const plan = await agent(
  `You are the fresh read-only DECOMPOSITION CRITIC from AGENTS.md. At exact commit ${args.baseCommit}, read task ${args.task}, its complete ten-run ledger, open findings, dependents, AGENTS.md, and .eforest/loop.md. Do not edit. Propose exactly 2-3 dependency-ordered children. Child ids append a lowercase suffix to ${args.task}. Their write scopes must not overlap. The coverage list must assign every acceptance criterion, open finding, evidence obligation, and dependency exactly once; no item may be waived and history may not reset.`,
  { label: `decompose:${args.task}`, phase: 'Partition', schema: PLAN_SCHEMA, effort: 'xhigh' }
)

phase('Attack')
const review = await agent(
  `You are a fresh read-only skeptic. Attack this run-10 decomposition for omitted parent criteria/findings, overlapping write scopes, circular or false dependencies, reset history, dangling dependents, or a child too large to confirm within the ONE global three-run probation:\n${JSON.stringify(plan, null, 2)}\nReturn safe only if the partition is finite, complete, non-overlapping, and independently verifiable.`,
  { label: `decomposition-skeptic:${args.task}`, phase: 'Attack', schema: REVIEW_SCHEMA, effort: 'xhigh' }
)
if (!review?.safe) return { committed: false, problems: review?.problems ?? ['skeptic failed'] }

phase('Commit')
return await agent(
  `Base commit must be exactly ${args.baseCommit}. Atomically apply this approved decomposition:\n${JSON.stringify(plan, null, 2)}\nPreserve ${args.task}'s readme and ten-run ledger byte-for-byte except frontmatter status cancelled plus explicit superseded_by child ids and one visible decomposition entry containing the complete coverage manifest. Create every child readme with split_from ${args.task}, decomposition_probation_runs: 3, full assigned criteria/findings, Verification log, and non-overlapping write_scope. Set only the first child in-progress and the rest pending; retarget every dependent to the terminal child; run python3 tools/build_queue.py. Commit exactly the parent readme, all child readmes, affected dependent readmes, and QUEUE.md. If any undeclared path would be required, fail instead. Return baseCommit, full commitOid, childIds in dependency order, childPaths, and the complete sorted changedPaths list.`,
  { label: `commit-decomposition:${args.task}`, phase: 'Commit', schema: COMMIT_SCHEMA, effort: 'high' }
)
