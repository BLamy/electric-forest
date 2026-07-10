---
id: E8-T01
epic: 8
title: "Deterministic git-to-stream import plan: one selected Git tree becomes a canonical stream-fs baseline with frozen provenance"
priority: 801
status: pending
depends_on: [E7]
estimate: L
capstone: false
---

## Goal

`@eforest/import-git` (`packages/import-git`) converts one selected Git tree into a
pure, canonical `ImportPlanV1` before it performs any network mutation. The source
selector is an explicit ref or object id (`--ref`, default `HEAD`); the destination is
one new electric-forest `main` branch. The plan contains the source commit id, every
accepted path's bytes/mode/content SHA-256, the exact ordered stream-fs actions needed
to reproduce the tree, the expected E4 canonical tree digest, and a SHA-256 over the
canonical plan itself. `.git/` is never content, while `.eforest/` is ordinary source
and must be present. Running the planner twice against unchanged input emits
byte-identical JSON and plan digest; replaying its actions through the E1 reducer
produces a tree digest byte-equal to the selected Git tree projected through E4-T01's
frozen path/mode rules.

## Context

Epic 8 needs a one-time bridge from Git into the stream model. This task freezes the
bridge's read side and provenance boundary; E8-T02 is the only writer. A plan is
computed completely before dispatch so unsupported input cannot leave a half-created
project. The importer intentionally imports the selected tree as a baseline, not Git's
commit graph, tags, reflogs, remotes, or side branches. Historical Git ids are provenance
in the manifest, not synthetic stream history. After E8-T03 cutover, new history exists
only as stream events.

The planner reuses E4-T01's canonical enumeration, path normalization, executable-mode
mapping, and tree-digest implementation and E1's stream-fs action schemas; it must not
fork either contract. Git access is isolated in `packages/import-git/src/git-source.ts`.
All other modules consume a `SourceTree` interface so fixtures and future import sources
do not need Git. Unsupported Git entries produce one typed planning failure before any
writer is called. This task depends on E7 because the imported repository includes the
complete, already-verified product and its `.eforest` loop.

## Deliverables

- `packages/import-git/src/types.ts` — `SourceTree`, `SourceEntry`, `ImportPlanV1`,
  `ImportProvenanceV1`, and typed planning errors; no timestamp, host path, random id,
  or locale-dependent field is permitted in the canonical plan.
- `packages/import-git/src/git-source.ts` — the sole Git adapter: resolve a selected ref
  to an immutable object id and read the selected tree's blobs and modes without using
  the mutable working tree.
- `packages/import-git/src/plan.ts` — `planGitImport(source, destination)` producing the
  ordered stream-fs genesis/create/write actions, expected tree digest, per-entry hashes,
  source object id, and canonical plan digest.
- `packages/import-git/src/verify-plan.ts` — replay the plan in memory and assert action
  schema validity, content-hash parity, and final tree-digest parity before returning it.
- CLI preview wiring: `ef import-git <path> --ref <ref> --org <org> --repo <repo>
  --plan <file> --dry-run`; dry-run writes only the canonical plan file and performs zero
  HTTP requests.
- Tests and committed fixtures covering electric-forest-shaped content: `.eforest/`,
  executable scripts, zero-byte and binary blobs, Unicode paths, nested directories,
  and a source ref whose checked-out working tree is dirty but whose selected object is
  stable.
- `Makefile` target `verify-E8-T01`, joined to `verify-all`, plus committed golden plan,
  source-tree digest, replay digest, and mutation transcript under this task's
  `evidence/`.

## Acceptance criteria

- [ ] `make verify-E8-T01` exits 0 from `tools/verify/cold_clone.sh` with scrubbed
      environment and no skipped leg; its transcript is committed as
      `evidence/e8-t01-transcript.txt`.
- [ ] Two separate processes run `ef import-git <fixture> --ref HEAD --dry-run` and
      produce byte-identical plan files and identical 64-lowercase-hex plan digests;
      byte comparison and both values appear in the transcript.
- [ ] Replaying the golden plan's ordered actions twice produces one state digest, and
      the resulting tree digest byte-equals `ef tree-digest` over an independently
      materialized archive of the selected Git object; all three values are pinned in
      `evidence/e8-t01-digests.txt`.
- [ ] The golden plan contains `.eforest/project.json` and at least one task readme,
      contains no path equal to or below `.git`, and preserves the fixture's executable
      bit, zero-byte blob, binary bytes, and Unicode path exactly; committed tests assert
      hashes and modes field-by-field.
- [ ] A dirty working-tree edit not present in the selected object changes neither plan
      bytes nor digest. Changing the selected ref to a commit containing that byte does
      change the named entry hash, plan digest, and replayed tree digest.
- [ ] Dry-run sends zero HTTP requests, creates no server stream, and does not write
      `.ef/`; a request-counting server and before/after stream enumeration prove this.
- [ ] Unsupported entries, invalid refs, path collisions after E4 normalization, and an
      input whose blob changes while read each fail with a pinned typed error before the
      writer interface is invoked; the writer-spy call count remains zero.
- [ ] Sensitivity: flipping one byte in a temporary golden plan makes `verify-plan`
      fail at the exact entry and makes final digest comparison fail; replacing E4's
      enumerator with a permissive local clone also makes the target red. Both observed
      failures are recorded in `evidence/e8-t01-sensitivity.md`.
- [ ] Repo-wide static audit finds Git-process invocation for import planning only in
      `packages/import-git/src/git-source.ts`; `plan.ts` and `verify-plan.ts` pass tests
      against an in-memory `SourceTree` while `git` is absent from `PATH`.
- [ ] Root gates pass: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test &&
      pnpm build`; `make verify-E4-T01` and the applicable E1 stream-fs verify target
      re-run green unchanged.

## Adversarial verification

1. Build your own repository with hostile legal names, large binary blobs, empty files,
   executable files, `.eforest/`, `.gitignore`, and dirty uncommitted edits. Compare a
   separately archived selected object with plan replay byte-for-byte and mode-for-mode.
   One mismatch or leaked `.git` path refutes the projection.
2. Run the planner under different locale, timezone, `HOME`, absolute checkout path, and
   process count. Any plan-byte or digest difference for the same source object and
   destination refutes determinism.
3. Mutate one blob after ref resolution, replace a blob object with truncated bytes, and
   create two names that collide after the E4 normalization oracle. Any partial plan or
   writer call before the typed refusal refutes the preflight boundary.
4. Sabotage the measuring apparatus: make `verify-plan` trust the recorded expected
   digest, flip one action byte, and remove `.eforest` from the enumerator. The committed
   target must fail independently for all three changes; a green mutation refutes it.
5. Search the package and process trace for alternate Git access, shell pipelines, and
   reads from the checked-out working tree. A dirty-file byte entering a plan for an
   unchanged object id refutes the immutable-source claim.
6. Replay the golden plan with the registered E1 reducer in two fresh processes and
   independently materialize it through stream-fs. Digest equality without byte/mode
   parity is insufficient; either disagreement is a finding anchored to the plan entry.

## Verification log
