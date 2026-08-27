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

## Cross-entity linking

<!-- frozen:E5-T07:entity-ref -->
An entity reference is the canonical-JSON object `{ "entity": <kind>, "stream":
<streamId> }` where `<kind>` is a member of the closed set `"issue"` (this task freezes
only `"issue"`; later tasks may extend the set additively, never reinterpret it) and
`<streamId>` is the referenced entity's stream id echoed verbatim as an opaque string —
never parsed, never fabricated, compared only by string equality. Closes-references
live in exactly one place: the optional `closes` array of the `pr.opened` payload. The
set of issues a merge closes is the `closes` array of the PR's own `pr.opened` event as
recorded on the PR stream — payload data on `pr.merge` or `pr.merged` never adds,
removes, or reorders refs. An empty or absent `closes` array is valid and propagates
nothing.
<!-- /frozen:E5-T07:entity-ref -->

<!-- frozen:E5-T07:propagation-rules -->
Propagation runs at dispatch time only, never in a reducer. On accepting `pr.opened`
with `closes`: for each ref, in array order, append `issue.linked { v: 2, by:
{ entity: "pr", stream: <prStream> }, atOffset: <openedOffset> }` to the referenced
issue stream; a ref whose stream does not exist yields `pr.link-noop { v: 1, ref,
reason: "dangling-reference" }` on the PR stream instead. After the E5-T06 executor
appends `pr.merged` at offset M on PR stream P: for each ref, in array order, read the
issue's reduced state; (a) if `closedBy` already contains `{ prStream: P,
prMergedOffset: M }`, append nothing for that ref; (b) else if `state === "done"`,
append `pr.link-noop { v: 1, ref, reason: "already-done" }`; (c) else if
`WORKFLOW_TRANSITIONS` makes `issue.state-changed { to: "done" }` illegal from the
current state, append `pr.link-noop { v: 1, ref, reason: "illegal-transition" }`;
(d) else if the ref's stream does not exist, `pr.link-noop { v: 1, ref, reason:
"dangling-reference" }`; (e) otherwise append `issue.state-changed { v: 2, to: "done",
via: { prStream: P, prMergedOffset: M } }` to the issue stream, fenced at the issue
head read during planning, followed by `pr.link-closed { v: 1, ref, issueOffset:
<offset of that state-changed event> }` on the PR stream. Duplicate refs to the same
stream within one `closes` array collapse to the first occurrence. Every `pr.link-noop`
is deduplicated on `(ref, prMergedOffset)` against the PR's reduced state — a re-run
that would re-record an identical no-op appends nothing. On accepting `pr.closed`
(close without merge): propagate nothing; every referenced issue stream's head is
untouched. All propagated appends go through the validated dispatch door; a fencing
race retries from a fresh read of the issue state (re-planning, so the idempotence
check re-runs) — propagation never blind-appends.
<!-- /frozen:E5-T07:propagation-rules -->

<!-- frozen:E5-T07:post-terminal-links -->
Amendment to E5-T02's terminal rule, additive and validator-enforced: after `pr.merged`,
exactly two event types remain legal on a PR stream — `pr.link-closed` and
`pr.link-noop` — and each is legal only when its `prMergedOffset` provenance
(`issueOffset`'s citing close for `link-closed`; the dedup key for `link-noop`) refers
to this PR's own `pr.merged` event. They carry no lifecycle effect: the reducer's
`status` stays `merged`; they fold only into the reduced `links` array. Every other
event type after `merged` or `closed` is refused `pr/terminal` exactly as E5-T02 froze.
After `pr.closed`, `pr.link-closed` and `pr.link-noop` are refused too — there is no
merge to cite.
<!-- /frozen:E5-T07:post-terminal-links -->

The concrete exact `pr.link-noop` schema resolves the frozen shorthand's provenance
requirement with a discriminated field:

- open-time noops carry `provenance: { trigger: "opened", openedOffset }`;
- merge-time noops carry `provenance: { trigger: "merged", prMergedOffset }`.

`pr.link-closed` remains `{ v: 1, ref, issueOffset }`; its validator resolves that issue
offset and verifies the closing event cites this PR's own merged offset. Reduced PR
links are one canonical entry per first-seen ref: `{ ref, state: "linked" | "closed" |
"noop", reason?, issueOffset?, provenance? }`. The provenance field is present only
for noops and is their exact replay/dedup key. Absent `closes` leaves both `closes` and
`links` absent from reduced state, preserving legacy E5-T02 v1 digests.

These three frozen blocks and all linking goldens are one versioned contract. Changing
any block or concrete payload shape invalidates the E5-T07 golden and every later Epic
5 linking golden.
