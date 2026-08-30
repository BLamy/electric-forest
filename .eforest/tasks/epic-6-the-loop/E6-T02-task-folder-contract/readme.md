---
id: E6-T02
epic: 6
title: "Task-folder contract: parse and render readme, work, and evidence without losing bytes"
priority: 602
status: refuted
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

### 2026-08-30 — critic — VERDICT: refuted

- ORIENT — OK. Recomputed independently from a fresh `pnpm --filter @eforest/tasks build`:
  E9-T01 `e72bbecc…b5bb`, E9-T02 `0b5465ef…74e3`, E9-T03 `a2c0c31a…6833`; property corpus
  `node tools/verify/e6_t02_property.mjs | shasum -a 256` =
  `3158c855c5ecd7c08f95b41b798b3ae0fb11977c4924950c2139b44def57cf54`. No `.skip`/`.todo`/
  `.only`/inline lint disables/`@ts-ignore` in `git diff a0e09c83..HEAD`. Goldens are read
  from disk and hashed before/after by the verifier (`e6_t02_evidence.mjs` steps 1 and 7);
  nothing regenerates at test time. `bash tools/verify/cold_clone.sh verify-E6-T02` →
  `PASSED from a pristine clone` of fe8cf4b0, 18/18 tests, zero `SKIPPED:`.
- P-case-collision (contract: `packages/tasks/README.md:120` "case-folded collisions … are
  refused"; attack 1 "any accepted ambiguous parse … is a refutation"; attack 2 plants
  case-collision in `work/` and `evidence/`) — FAILED. Predicted refusal
  `paths/case-collision` for a snapshot holding `evidence/A/x.txt` + `evidence/a/y.txt`;
  observed `ok: true`. `parse.ts:113-137` folds only the full entry path, never the
  directory prefixes. Consequence on this machine (APFS, case-insensitive):
  `writeRenderedTaskFolder` then `readTaskFolderSnapshot` yields manifest
  `["A/x.txt","A/y.txt"]` and the durable `taskFolderDigest` differs from the pre-render
  value — the disk round trip the verifier itself relies on (step 5) is not a fixed point
  for an accepted folder. Variant `evidence/A` (file) + `evidence/a/y.txt`: accepted, then
  the writer throws `EEXIST … mkdir …/evidence/a` after writing 1 file — an accepted input
  leaves a half-rendered folder. `work/A/x` + `work/a/y` likewise accepted. Demand: extend
  the case-fold check to every directory prefix (and file-vs-directory prefix), add these
  four as inline `invalid-snapshots.json` cases, regenerate `e6-t02-refusals.txt` and the
  pinned-reason test, re-run cold clone.
- P-root-file (contract `packages/tasks/README.md:125` "`render(parse(x))` is a fixed point
  of `parse ∘ render`"; README contract "Only `readme.md`, `work/`, and `evidence/` may
  exist at the folder root") — FAILED. Predicted `folder/unexpected-entry` for a regular
  *file* named `evidence` at the root; observed `ok: true` with evidence manifest
  `[{"path":"","size":9,…}]` (`parse.ts:148-154` accepts any non-directory whose root
  segment is `evidence`; `parse.ts:202` slices `"evidence"` to `""`). `renderTaskFolder`
  then emits path `evidence/`, and `parseTaskFolder(snapshotOfRendered(...))` refuses
  `paths/empty-segment@evidence/`. A file named `work` at the root likewise produces a
  workshop entry with path `""`. Repro on disk: `touch <folder>/evidence` next to a valid
  readme. Demand: refuse a root `evidence`/`work` entry that is not a directory (new or
  existing reason, e.g. `folder/unexpected-entry`), add both as inline fixtures, regenerate
  the transcript.
- P1 cold clone / goldens — PASSED (above). P2 exact keys + ordered sections + stable
  path:line:column — PASSED on my own inputs: duplicate key (`4:1`, and via a `#id:` comment
  decoy `5:1`), anchor/alias/merge key/tag, block `|`, flow map, nested list, `[E1` and
  `[E1,]`, `key :`, `--- ` close, `...` end, `ID:` casing, `id: E9-T50#c`, `epic: 09`,
  `950.50`, `.5`, `True`/`yes`, lowercase id, slug with uppercase or `--`, empty file,
  `---`-only, all refused with the frozen reasons; shuffled keys + comments accepted and
  canonicalised. P3 two fresh processes — PASSED (verifier; plus my own 9,000-byte NUL-bearing
  blob rendered from cwd `/` + `TZ=Asia/Tokyo` and from scratch + `TZ=UTC LANG=C`:
  manifests and bytes `cmp`-identical). P4 bytes/`---`/empty log — PASSED: 20,000 random
  bodies over `---`/```/~~~/````/`## Goal`/` ## Goal`/`    ## Goal`/`##Goal`/`## `/`##`/
  `> ## Goal`/`- ## Goal`/tab-heading lines: 4,004 accepted, 0 render drift, 0 throws;
  20,000 random titles over `" # \ : - [ ] { & * ! | > % @ , ? '`: 10,968 accepted, 0
  drift, 0 throws; 1 MiB line, setext `Goal\n---`, `---\nid: x\n---` in body, `## Verification
  log` inside a fence all accepted verbatim. P5 work/ boundary — PASSED (add, remove work
  files: digest and manifest unchanged; one evidence byte: both move). P6 refusals write
  nothing — PASSED for refused inputs (fixture tree hash unchanged after 64 refusals; my
  symlink canary below); the accepted-then-EEXIST case above is a P-root/P-case failure,
  not a P6 one. P7 Replay N/A — accepted, filesystem-only.
- ENV/MOCK HUNT — OK. `io/disk.ts` walks with `readdirSync(withFileTypes)` and reports
  `isSymbolicLink()` before `isDirectory()`; canary: `evidence/fifo-link -> <outside>/fifo`
  (a FIFO — following would block), `work/dir-link -> <outside dir>`, `evidence/rel-link ->
  ../../outside/canary.txt`: walk returned in 0 ms with three `symlink` entries and no
  bytes; parser refused `paths/symlink@evidence/fifo-link`. The walker only ever joins
  `readdir` names, so no path outside the root is constructed. `fe8cf4b0` Makefile hardening
  verified: `sh -c 'command grepzz …; test $? -eq 1'` exits 1 (missing tool → red), a clean
  scan exits 0, a match exits 1.
- SABOTAGE (scratch worktree, my own mutations, not the builder's flag) — all red:
  (A) delete the duplicate-key block → `refusal transcript drifted`, exit 1; (B) delete the
  symlink refusal → drifted, exit 1; (C) append one byte to `goldens/E9-T01.readme.md` →
  `E9-T01-minimal: readme golden`, exit 1; (D) flip one byte in
  `fixtures/valid/E9-T02-complete/evidence/nested/zeros.bin` → `fixture tree drifted`,
  exit 1; (E) delete the `..` traversal refusal → drifted, exit 1.
- Unlisted attacks: CRLF (`readme/crlf@11:8`), lone CR, BOM (`1:1`), no trailing newline,
  NUL/FF/DEL in body (`readme/control-character`), invalid and overlong UTF-8
  (`readme/not-utf8`), `## Goal ##` closing hashes and `##\tGoal` (refused), HTML-comment
  block containing `## Goal` (refused as duplicate — strict, acceptable), Unicode/emoji/
  ZWSP/NBSP/fullwidth-colon titles (accepted, round-trip stable), `..x` segment (accepted,
  correctly), Windows reserved name `CON` (accepted — noted, not in scope). One
  observation, not a finding: `stripComment` uses `String.prototype.trim`, so a title with
  trailing NBSP or U+0085 is canonicalised to the trimmed value (render remains a fixed
  point).
- Boundaries judged: (a) refusing 28/104 repo folders (loop-ledger keys, missing
  `## Context`, ad-hoc H2, `references/`, `%3A`, `café/`) is consistent with the criterion
  "accepts exactly the flat keys … requires … in order" — the criterion freezes the README
  contract, not the repo's current drift — but E6-T05 cannot sync this repo until the
  ledger keys move to events and those readmes are brought into format; (b) the task's own
  folder being refused because hostile fixtures live under `evidence/` is a documented
  consequence of "malformed path … cases" being deliverables, not a criterion miss.
- COVERAGE: `src/folder/{schema,paths,parse,render,generate}.ts`, `io/disk.ts`,
  `test/folder-*.ts`, `tools/verify/e6_t02_*.mjs`, Makefile `_v-e6-t02` and the `_v-e6-t01`
  grep line — executed (cold clone + attacks above). `src/index.ts`, `src/folder/index.ts`,
  `package.json` exports, `tsconfig*.json`, `cold_clone_targets.txt`, docs, QUEUE.md —
  waived (config/re-exports/docs). Dead: none. The gates are at baseline (18 lint, 41 TS,
  7 prettier; none in E6-T02 files).
- SUITE: n/a until the two refutations clear; on rework promote the four case-collision
  and two root-file snapshots into `invalid-snapshots.json` so the transcript pins them.
Commands: `bash tools/verify/cold_clone.sh verify-E6-T02`; `node tools/verify/e6_t02_property.mjs | shasum -a 256`; `node work/critic-attacks.mjs`; `node work/critic-disk.mjs`; `node work/critic-fm2.mjs`; worktree sabotages A–E via `node tools/verify/e6_t02_evidence.mjs`; `pnpm lint`/`typecheck`/`format:check`.
