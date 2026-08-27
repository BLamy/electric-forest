# Meadow contracts

<!-- frozen:E5-T08:branch-provisioning -->

Every repository's wiki is the ordinary stream-fs branch named `wiki`. Its metadata
stream id is `fs:<org>/<repo>:wiki:meta`, derived with the E1-T08 stream-fs branch-id
helper from E2-T06's `fs:<org>/<repo>` repo prefix. `ensureWikiBranch(org, repo)` is
bound to an injected authenticated door: it inspects through the existing authorized
read surface and creates the missing branch only by sending the standard
`fs.branch.genesis { v: 1, branch: "wiki" }` action through `/api/dispatch`. The branch
starts with an empty reduced tree at its own offset zero. It is parentless and is never
forked from `main`. A valid existing wiki branch is returned unchanged; a second call
appends nothing and returns the same stream id. Meadow owns no transport, route,
reducer, persistence, cache, or alternate write path.
<!-- /frozen:E5-T08:branch-provisioning -->

<!-- frozen:E5-T08:slug-path -->

A wiki page is one UTF-8 markdown file named `{slug}.md` at the wiki branch root.
Slugs match `[a-z0-9][a-z0-9-]*` exactly. There is no normalization. Uppercase,
leading hyphens, empty slugs, separators, and nested directories are refused by
Meadow's slug/path helper; the frozen grammar permits a trailing hyphen. The server has
no wiki-specific path rule:
foreign stream-fs tools may write any valid tree, while wiki consumers select only
root-level files matching this convention.
<!-- /frozen:E5-T08:slug-path -->

<!-- frozen:E5-T08:routes -->

The wiki index route is `/orgs/:org/repos/:repo/wiki`. The page route is
`/orgs/:org/repos/:repo/wiki/:slug`. The editor route is
`/orgs/:org/repos/:repo/wiki/:slug/edit`. These are consumer contracts only;
`@eforest/meadow` adds no server route.
<!-- /frozen:E5-T08:routes -->

<!-- frozen:E5-T06:outcome-events -->
`pr.merged` carries `{ v: 1, targetMergeOffset, kind: "fast-forward" | "three-way",
resultTreeDigest }` and is terminal; `pr.merge-conflicted` carries `{ v: 1,
targetMergeOffset, conflicts: [{ path, kind }] }` where `conflicts` mirrors, in the
same order, the `fs/merge-conflict` events the merge batch appended to the target
stream, and flips the PR to `conflicted`. These are the only two events the executor
may append to the PR stream per attempt.
<!-- /frozen:E5-T06:outcome-events -->

<!-- frozen:E5-T06:gate-and-refusals -->
The executor runs only from lifecycle state `approved`. Refusal reasons:
`pr/merge-not-approved` (any non-`approved` state, including `conflicted` — a
conflicted PR re-merges only after every conflict is resolved on the target via
E1-T10 `fs/merge-resolve` and the PR is re-approved per E5-T02's lifecycle),
`pr/already-merged` (terminal PR), `pr/merge-evidence-missing` (the PR's E5-T10
attachment stream reduces to zero attachments, zero linked recordings, AND zero
`evidence.waived` events — the AGENTS.md "Pull requests carry evidence" rule made
mechanical: a Replay recording, an uploaded artifact, or an explicit waiver with
justification is required before merge), plus E1-T09/E1-T10 refusals passed through
untranslated (`merge/target-advanced`, `merge/target-conflicted`). A refused merge
appends zero events to both the PR stream and the target stream.
<!-- /frozen:E5-T06:gate-and-refusals -->

<!-- frozen:E5-T06:recovery -->
The target-stream append and the PR-stream outcome event are two appends with a crash
window between them. Recovery is idempotent re-dispatch: before merging, the executor
scans the target's events after `forkOffset` for an existing merge event whose
`sourceStreamId` equals the PR's `sourceBranch`; if found, it appends only the missing
PR outcome event citing that offset, never a second merge. Re-dispatching `pr.merge`
on an already-merged PR refuses `pr/already-merged`.
<!-- /frozen:E5-T06:recovery -->

The committed PR-merge fixtures and expected digests are immutable contract artifacts.
Changing a frozen block or golden requires an explicit versioned contract update; tests
compare these blocks byte-for-byte with the E5-T06 task source to prevent silent drift.
