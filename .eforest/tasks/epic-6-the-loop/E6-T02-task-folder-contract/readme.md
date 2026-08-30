---
id: E6-T02
epic: 6
title: "Task-folder contract: parse and render readme, work, and evidence without losing bytes"
priority: 602
status: implemented
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

### 2026-08-30 — builder — implemented, not yet verified

- Implementation commit `aa36af19` (branch `e6-t02-task-folder-contract`, stacked on
  verified E6-T01). `packages/tasks/src/folder/{schema,paths,parse,render,generate}.ts`
  define `TaskFolderV1` and a **pure** snapshot parser/renderer: the parser takes an inert
  `TaskFolderSnapshot` (`{ folderName, entries[{ path, kind, bytes }] }`), so it never
  resolves a path against any filesystem and the same contract will apply to a stream-fs
  tree in E6-T05. `packages/tasks/io/disk.ts` (`@eforest/tasks/disk`) is the one
  `node:fs` boundary — a `readdir`-only walker that reports symlinks without following
  them and a writer that refuses non-empty targets — kept outside `src/` so
  verify-E6-T01's "no `node:fs` in `packages/tasks/src`" check still holds unchanged.
- Contract as frozen (`packages/tasks/README.md`, "Task-folder contract"): flat YAML
  **subset** read by a ~150-line hand-written reader (no YAML library — anchors, aliases,
  merge keys, tags, duplicate keys, block values, flow maps, nested lists, unknown keys,
  tabs, single quotes are all refusals with a reason from the frozen
  `TASK_FOLDER_REFUSAL_REASONS` (37) plus `readme.md:line:column`); exactly the eight keys
  `id/epic/title/priority/status/depends_on/estimate/capstone`, all required; the six
  sections in fixed order, recognised only as an exact `## <Name>` line outside a code
  fence (`---` rules, `#`/`###` headings, fenced `## Goal`, prose `## Goal` are body
  text; `## Goal ` with trailing space, indented `   ## Goal`, and an unterminated fence
  are refused); bodies, the preamble and an empty Verification log are kept verbatim with
  inclusive 1-based line spans and half-open UTF-8 byte spans; `evidence/**` is a sorted
  `{ path, size, sha256 }` manifest with bytes carried for render; `work/**` is a
  workshop inventory, never rendered, never in `taskFolderDigest` (SHA-256 of the canonical
  JSON of `{ v, folderName, frontmatter, readmeSha256, evidence }`). Paths: ASCII
  `[A-Za-z0-9._-]` segments only; absolute (`/`, `C:`, `\`), `.`/`..`, empty segments,
  any `%`, non-ASCII, trailing `.`, >255-byte segments, symlinks, special files, exact
  duplicates, file/dir clashes, and case-folded collisions are refused; only `readme.md`,
  `work/`, `evidence/` may exist at the root; frontmatter `id` must equal the folder
  prefix and `epic` the id's epic. Canonical render: keys in fixed order, `title` plain
  unless it needs quoting, `depends_on` as `[A, B]`, comments/blank frontmatter lines
  dropped — `render ∘ parse` is a fixed point of `parse ∘ render`. Smoke-parsing this
  repo's 104 task folders: 76 parse and re-render byte-identically or to the canonical
  rewrite (unneeded title quotes, trailing `# comments`); the 28 refusals are exactly the
  loop-ledger keys `work-queue` appends (`verification_run_ceiling` …), 20 readmes with no
  `## Context`, one `## 2026-07-13 runtime-boundary note`, and three evidence trees with
  root `references/`, a `%3A`-encoded name, and a `café/` directory — the README contract
  says none of those are in-format, so they are refused rather than tolerated.
- Exact commands: `pnpm format:check` (7 pre-existing files, none mine), `pnpm lint`
  (18 errors, the pre-existing baseline), `pnpm typecheck` (41, baseline), `pnpm test`
  (119 files: 116 passed, the same 3 pre-existing failures — meadow README drift,
  issues.test workflow-key count, pr fuzz timeout), `pnpm build` (green),
  `pnpm task-board:check` (green), `make verify-E6-T02` (green),
  `bash tools/verify/cold_clone.sh verify-E6-T02` → `PASSED from a pristine clone` of
  `aa36af19`, zero `SKIPPED:` lines.
- Evidence (all in `evidence/`, hashed before/after by the verifier so nothing regenerates
  at test time): `fixtures/valid/E9-T01-minimal` (readme only, empty Verification log),
  `fixtures/valid/E9-T02-complete` (quoted title with `: ` and `---`, `---` rule and
  fenced `## Goal`/`## Context`/`## Deliverables` in the body, seven evidence files
  including `nested/deep/blob.bin` — 4,096 bytes with NUL every fifth byte and a NUL
  last byte —, `nested/zeros.bin`, `empty.bin`, `.ef/state.json`, CRLF+NUL `notes.txt`,
  `ABC.txt`/`abd.txt`), `fixtures/valid/E9-T03-noncanonical` (comments, blank lines,
  shuffled keys, `903.5`, `[ E9-T01 ,E9-T02,E8 ]`, needlessly quoted title);
  `goldens/<id>.json` (canonical value + digest + rendered file hashes) and
  `goldens/<id>.readme.md`: E9-T01 `e72bbecc02d37cc29a18042157f63b52d9c1fff9cf62cc8caa8d8632a707b5bb`,
  E9-T02 `0b5465ef21a3762edcd2628c9537dc65ecc1097be5e3e3f040a48a940e2a74e3`,
  E9-T03 `a2c0c31aa8e7546404c476b638ef7a8ebaeaae7ba8bf27ed8082ac5a33406833` (E9-T01/E9-T02
  render byte-identical to their source; E9-T03 renders to the canonical rewrite);
  `fixtures/invalid/` — 40 on-disk malformed folders (duplicate key, anchor, alias, merge
  key, unknown/missing key, block list/scalar, flow map, single quotes, bad escape,
  id/epic mismatch, missing/out-of-order/duplicate/unknown section, trailing-space and
  indented headings, unterminated fence, CRLF, no trailing newline, no/unclosed
  frontmatter, `...`, tab, bad priority/status/dependency, nested list, stray root file,
  `%2e%2e` path, bad folder name, missing readme, and a committed mode-120000 symlink
  `evidence/escape -> ../../../../../../../readme.md`) plus `fixtures/invalid-snapshots.json`
  — 24 inline cases a checkout cannot hold (absolute and `C:` paths, `../` in `evidence/`
  and `work/`, `./`, backslash, case collisions in `evidence/`, `work/` and against
  `readme.md`, `work/` symlink and `%2e%2e`, Unicode slug and path, empty evidence dir,
  readme-as-directory, FIFO, control char, BOM, invalid UTF-8, duplicate path, file/dir
  clash, empty segment, trailing dot, 256-byte segment); `e6-t02-refusals.txt` — the 64
  frozen transcript lines (`ok:false` for every one, all 37 reasons covered);
  `e6-t02-fixtures.sha256` — the 54-entry fixture tree hash list; `e6-t02-property.txt` —
  seed `e6020000`, 1,000 generated folders, corpus SHA-256
  `3158c855c5ecd7c08f95b41b798b3ae0fb11977c4924950c2139b44def57cf54`;
  `e6-t02-sabotage.txt` — with `E6_T02_DUPLICATE_KEY_GUARD` set to false, the
  duplicate-key fixture parses `ok:true`, 4 contract tests and the verifier's transcript
  step go red (`refusal transcript drifted`), both exit 1.
- `make verify-E6-T02` = build, a `grep` gate that `src/folder` imports no `node:fs`/
  clock/randomness/YAML library (exit status held to exactly 1, so a missing tool cannot
  green-wash), the two suites `folder-contract.test.ts` + `folder-property.test.ts`
  (18 tests: goldens, fixed points, spans, NUL evidence, refusal pins, work/evidence
  boundary, 200 random binary payloads at nested paths), then
  `tools/verify/e6_t02_evidence.mjs`: holds the fixture tree to `e6-t02-fixtures.sha256`,
  byte-compares parse→render of every valid fixture to its golden and re-renders to a
  fixed point, re-executes all 64 refusals to a byte-identical transcript with the fixture
  tree unchanged afterwards, runs `e6_t02_property.mjs` in two fresh processes (foreign
  cwd + `Pacific/Kiritimati` vs repo cwd + UTC) to byte-identical 1,000-line output
  matching the frozen corpus digest, renders E9-T02 to a scratch directory and proves the
  boundary on disk (adding `work/probe.log` + `work/nested/blob.bin` leaves digest and
  manifest identical; one flipped byte in `evidence/notes.txt` moves both), prints the
  `SABOTAGE … EXPECTED-FAIL-WHEN-GUARD-REMOVED OK` sentinel, and checks every committed
  artifact's hash is unchanged. Registered in `tools/verify/cold_clone_targets.txt` and
  `verify-all`.
- `Replay: N/A (filesystem parser/renderer only)` + mitigation: byte-for-byte fixture
  round trips against committed goldens, independent-process manifests (two fresh
  processes, corpus digest frozen), 1,000 generated folders with `---`/fence/heading
  look-alike fuzz and NUL-bearing evidence, 200 random binary payloads, 64 frozen
  refusals, the on-disk work/evidence boundary, and the sabotage transcript.
- What the run demonstrates: a `.eforest/tasks` folder is now a versioned value with one
  strict reading — the README contract and nothing quieter. Every ambiguity a general
  YAML reader would resolve silently (last-key-wins, anchors, block forms) is a refusal
  with a stable address; every byte a builder or critic authored (Markdown bodies,
  including `---` and fenced headings, and arbitrary evidence bytes at nested paths)
  comes back identical after parse→render; the durable digest is blind to `work/` and
  sensitive to one evidence byte; two fresh processes agree on every rendered byte and
  manifest; and removing the duplicate-key guard turns the committed ambiguous fixture
  red, so the apparatus measures what it claims. One honest scope note: canonical render
  drops frontmatter comments (including a queue-jump reason on a fractional priority),
  and the loop-ledger keys some readmes carry are refused as unknown — where that ledger
  lives as events is E6-T03/E6-T04's decision, not a second format here.
- Known consequence, stated rather than hidden: this task's own folder is refused by its
  own parser (`paths/percent-escape` at
  `evidence/fixtures/invalid/percent-escape/E9-T41-percent-escape/evidence/%2e%2e/escape.txt`,
  and the mode-120000 symlink fixture behind it), because the hostile on-disk fixtures
  live inside `evidence/` where the spec asked for them. The contract is doing its job on
  the fixtures; if E6-T05 needs this folder itself to sync, those two cases must move to
  an inline/archived form. The critic should treat that as a documented boundary, not a
  surprise.
