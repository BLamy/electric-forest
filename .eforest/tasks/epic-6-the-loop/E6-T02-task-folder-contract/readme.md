---
id: E6-T02
epic: 6
title: "Task-folder contract: parse and render readme, work, and evidence without losing bytes"
priority: 602
status: pending
depends_on: [E5]
estimate: M
capstone: false
---

## Goal

`packages/tasks` parses a `.eforest/tasks/<epic>/<id>-<slug>/` tree into a versioned
`TaskFolder` value and renders it back deterministically. Flat YAML frontmatter,
required Markdown sections, `work/`, and `evidence/` have explicit semantics; malformed
or escaping paths are refused; parse -> render -> parse is canonical and preserves all
user-authored Markdown and evidence bytes.

## Context

The platform cannot productize `.eforest` by quietly inventing a second format. The
contract in `.eforest/tasks/README.md` is the input format, including inline
`depends_on`, empty verification logs, ignored scratch work, and committed evidence.
This task freezes a reusable parser/renderer before task streams and folder sync are
joined in E6-T05. It may run in parallel with the task reducer because it produces a
syntax-level `TaskFolder`, not task lifecycle state.

`work/` is visible as an ephemeral workshop inventory but is never promoted to durable
evidence or included in canonical task digests. `evidence/` is byte-addressed by SHA-256
and may contain nested paths. Symlinks, `..`, absolute paths, duplicate YAML keys, YAML
anchors, and non-flat values other than inline `depends_on` are refused.

## Deliverables

- `packages/tasks/src/folder/parse.ts`, `render.ts`, `schema.ts`, and `paths.ts`.
- A `TaskFolderV1` schema matching `.eforest/tasks/README.md`, including section spans,
  evidence manifests, and workshop inventory.
- Frozen fixtures for a minimal task, a complete task with binary evidence, and malformed
  path/frontmatter/section cases.
- Property tests for canonical round trips and arbitrary binary evidence payloads.
- `Makefile` target `verify-E6-T02` with fixture hashes and refusal transcripts.

## Acceptance criteria

- [ ] `make verify-E6-T02` exits 0 from a cold clone with zero skips and byte-compares
      parse -> render output for every frozen valid fixture against committed goldens.
- [ ] Parsing this repo's task readme contract accepts exactly the flat keys `id`,
      `epic`, `title`, `priority`, `status`, `depends_on`, `estimate`, and `capstone`,
      requires Goal/Context/Deliverables/Acceptance criteria/Adversarial verification/
      Verification log in order, and reports a stable path plus line/column on refusal.
- [ ] Rendering then reparsing 1,000 generated valid folders yields canonical values and
      evidence SHA-256 manifests that are byte-identical across two fresh processes.
- [ ] Arbitrary binary evidence, nested evidence paths, Markdown containing `---`, and an
      empty Verification log survive round trip without byte loss or section confusion.
- [ ] `work/` entries appear only in the workshop inventory; changing only `work/` leaves
      the durable task digest and evidence manifest byte-identical.
- [ ] Absolute paths, traversal, symlinks, duplicate YAML keys, anchors, unknown fields,
      missing sections, and an id/folder-name mismatch are all refused with no rendered
      output and no files changed.
- [ ] Browser evidence is declared `Replay: N/A (filesystem parser/renderer only)`;
      mitigation is byte-for-byte fixture round trips, independent-process manifests,
      fuzzing, and the sabotage proof above.

## Adversarial verification

1. Fuzz YAML delimiters, duplicate keys, inline lists, Unicode slugs, Markdown fences,
   and section-like headings. Any accepted ambiguous parse or nondeterministic render is
   a refutation.
2. Plant `../`, absolute, symlink, case-collision, and percent-encoded escape paths in
   both `work/` and `evidence/`. Any read outside the task root refutes containment.
3. Generate random binary evidence including NUL bytes, render twice in separate
   processes, and compare manifests and bytes exactly. Drift or corruption refutes.
4. Change a work file and then an evidence file. The first must not change the durable
   digest; the second must. Either inverse result refutes the boundary.
5. Sabotage duplicate-key rejection in a scratch worktree. The verify target must go red
   on a committed ambiguous fixture; green refutes sensitivity.

## Verification log
