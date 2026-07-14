---
id: E8-T04
epic: 8
title: "Gitless loop workspaces: builders and critics materialize, publish, diff, and merge exclusively through branch streams"
priority: 804
status: pending
depends_on: [E7]
estimate: L
capstone: false
---

## Goal

The hosted E6 builder/critic loop can execute this repository with no Git binary, no
`.git` directory, and no Git protocol traffic anywhere in the task path. A loop workspace
is materialized from a branch stream at a pinned offset into an ordinary directory with
an `.ef/` checkpoint; builder file changes publish through the E4 watcher/api/dispatch door;
critic diff coverage is computed as an exact stream event range from task-branch fork to
head; successful verdict merge uses E1/E5 branch/PR merge events. `packages/loop`
records a `WorkspaceProvenanceV1` for every role invocation containing project, branch,
fork/head offsets, input/output tree digests, task id, role, and command exit statuses.
For a project with `mergeRequired: true`, queue advancement and `project/complete` are
fenced on a merge event that cites the critic-verified branch head; `verified` without
integration is visible but cannot make the project complete.

## Context

Epic 6 made the loop a platform feature, but self-hosting raises the strictest possible
test: the source being built includes the tooling and task board that run the build. The
Epic 8 capstone says "no git", so merely hiding user-facing Git commands is insufficient.
The runner, diff/coverage audit, build gates, evidence capture, and merge all need
stream-native primitives. This task closes any integration seams exposed by running the
electric-forest workspace itself from a stream snapshot.

This work is independent of the import bridge and can proceed in parallel with E8-T01–03.
It must reuse E4 clone/watch, E1 branch/fork/merge, E5 PR/evidence, E6 task/agent/verdict,
and E7 live-session events rather than invent self-host-only machinery. Existing scripts
that require Git metadata must gain a stream-native input or be declared outside the
hosted loop; weakening the capstone to permit Git is not an option.

## Deliverables

- `packages/loop/src/run/workspace.ts` — extend E6-T07's workspace to materialize a branch at an explicit offset,
  verify the tree digest before command execution, checkpoint `.ef/`, and publish changes
  via the existing watcher with a verified output digest.
- `packages/loop/src/run/provenance.ts` — canonical `WorkspaceProvenanceV1` event and
  evidence artifact, registered on the task evidence stream.
- `packages/loop/src/run/stream-diff.ts` — changed paths/action ranges and source
  execution coverage inputs derived from `(forkOffset, headOffset)`, not Git diffs.
- Stream-native gate runner for the repository's format/lint/typecheck/test/build and
  task verify targets; any existing helper that shells out to Git receives an explicit
  offset/digest alternative.
- `packages/loop/src/controller/integrate.ts` and project-policy validation for
  `mergeRequired`: open/approve/merge through the existing E5 PR door after verification,
  then advance the queue or complete the project only from the integrated head.
- `tools/verify/no_git_runtime.sh` — runtime guard installs a failing `git` shim first in
  `PATH`, makes any inherited `.git` unreadable/absent, captures process/network traces,
  and fails on shim invocation, Git executable spawn, `.git` access, or Git-protocol URL.
- Integration tests covering builder publish, critic read-only run, refusal/rework,
  stream-range coverage, and PR merge; `verify-E8-T04` with event dumps, provenance,
  process trace, digests, and sensitivity results.

## Acceptance criteria

- [ ] `make verify-E8-T04` exits 0 from a cold clone after creating its hosted workspace
      solely by `ef clone`/branch materialization; before the runner starts, `test ! -e
      <workspace>/.git` succeeds and the failing Git shim is first in `PATH`.
- [ ] A builder run starts from a pinned task-branch head, passes the configured gates,
      changes a fixture source/test pair, and publishes events whose replayed output tree
      digest byte-equals `ef tree-digest` of the workspace at runner exit.
- [ ] A critic run materializes the builder head independently, computes its changed-path
      set from the stream range, and produces the exact same set as a canonical before/
      after tree comparison; no Git diff is executed or available.
- [ ] Builder, critic, refutation/rework, evidence attachment, verdict, and merge traces
      contain zero Git-shim calls, Git executable spawns, `.git` filesystem accesses, and
      `git://`, `ssh://git@`, or smart-HTTP Git network requests; the committed runtime
      audit reports every count as zero.
- [ ] `WorkspaceProvenanceV1` input offset/digest resolves to the branch dump before the
      run and output offset/digest resolves after it; role/task/project fields match the
      task stream and replaying the provenance evidence twice gives one digest.
- [ ] Critic execution is read-only until verdict dispatch: attempt to modify/publish
      source as critic is refused by role policy and leaves branch/project heads and
      digests unchanged.
- [ ] Restarting a builder after its publish response is lost reconciles from `.ef/` plus
      branch head, emits no duplicate patch, and records one output tree digest.
- [ ] Under `mergeRequired: true`, the exact lifecycle is critic `verified` -> PR
      `merged` citing that verified head -> queue advance/project completion. Killing or
      racing at each boundary produces one merge; a verified but unmerged or differently
      headed branch cannot advance the queue or complete the project.
- [ ] Sensitivity: allow the runner to inherit a `.git`, replace stream-range diff with
      an empty set, and disable output digest comparison in separate scratch worktrees.
      `verify-E8-T04` must fail a distinct assertion for each mutation; evidence is in
      `evidence/e8-t04-sensitivity.md`.
- [ ] All root gates and E4 clone/watch, E6 loop, and E7 live-session verify targets re-run
      green while the no-Git guard is active where their hosted path is exercised.

## Adversarial verification

1. Remove `git` from `PATH`, plant a shim that logs and exits 97, remove `.git`, scrub
   Git environment variables, and run the complete scenario. Any shim line or fallback
   to a hidden absolute Git path is an anchored refutation.
2. Use a task branch with add/delete/rename/binary/mode changes and a conflict. Compare
   the stream-range diff with independently materialized endpoint trees. One missing
   changed hunk refutes critic sufficiency.
3. Kill the builder between local write, dispatch acceptance, checkpoint update, and
   evidence attachment. Resume each case. Duplicate events, lost bytes, or provenance
   that cites a non-existent offset refutes workspace durability.
4. Attempt critic source dispatch using its actual token and runner context. Acceptance
   before a role transition refutes separation of duties.
5. Search process and network traces for Git helpers (`git`, `git-upload-pack`, libgit2,
   isomorphic-git) and `.git` probes, not only the literal command. Any unrecorded source
   dependency violates no-Git even if the demo finishes.
6. Sabotage output digest and coverage instruments one at a time. The committed
   sensitivity legs must turn red; a green sabotage refutes the proof apparatus.
7. Forge a merge that cites an earlier builder head and attempt project completion after
   verdict but before merge. Either acceptance refutes the integration fence.

## Verification log
