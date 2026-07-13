---
id: E1-T03
epic: 1
title: "Text patches: diff-based content events with deterministic apply, full-write fallback, and digest parity against full writes"
priority: 103
status: implemented
depends_on: [E1-T01]
estimate: M
capstone: false
---

## Goal

`packages/streamfs` (`@eforest/streamfs`) dispatches text edits as compact **patch
events** instead of full-content writes: an `fs.file.patch` action whose payload is
`{ path, baseDigest, ops, resultDigest }`, where `baseDigest` is the lowercase-hex
SHA-256 of the UTF-8 bytes of the file content the diff was computed against, `ops` is a
frozen byte-level op list (`["=", n]` copy n bytes from base, `["+", "utf8-string"]`
insert, `["-", n]` delete n bytes — in order, exhaustively consuming the base), and
`resultDigest` is the SHA-256 of the patched content. The reducer applies patches
**deterministically**: it refuses (typed, log untouched) any patch whose `baseDigest`
does not match the current content digest at `path`, whose ops are structurally invalid
or do not exactly consume the base, or whose applied output does not hash to
`resultDigest`. The writer API (`writeFile` in `@eforest/streamfs`) chooses the event
kind automatically: it emits `fs.file.patch` only when the target and base are both valid
UTF-8 text containing no NUL byte **and** the patch's wire bytes are strictly smaller
than the full write's wire bytes — where wire bytes are defined against E1-T01's
split-stream layout (a full write's cost includes the content bytes appended to the
per-file content stream, not just its metadata payload; exact formula in the fallback
rule below); otherwise it falls back to E1-T01's frozen full-content write event. The `fs.file.patch` payload shape, op
grammar, refusal taxonomy, and fallback rule are **frozen here** under the fs event
envelope and version E1-T01 established — changing any of them later invalidates the
golden patch logs committed by this task. `make verify-E1-T03` proves the headline
property: the same scripted edit sequence applied once via patches and once via forced
full writes replays (via `ef replay --digest` over each dumped log) to **identical
canonical tree digests**, while the patch log's summed wire bytes are strictly smaller.

## Context

Patches are the bandwidth story for everything downstream: E1-T05's `watch()` tails
content streams live, E4's watcher syncs working trees over them, and E7 streams
keystroke-granular AI edit sessions — none of that is viable if every keystroke ships
the whole file. Patches are also the substrate E1-T10's three-way merge operates on, so
the op grammar frozen here is load-bearing for merge semantics two tasks out.

The design center is the equivalence claim: a patch is *only* an encoding optimization.
Replayed state must be bit-for-bit indistinguishable from the full-write encoding of the
same edits — the canonical tree digest (E1-T01) is the judge, and `ef replay --digest`
(E0-T04) is the citation format. Anchoring (`baseDigest`) is what makes apply
deterministic and misapplication detectable; it is **not** concurrency control — the
stale-write *fencing* protocol (writes declaring their base and racing writers being
refused, per-writer `Stream-Seq`) is E1-T04's scope. Here, a mismatched `baseDigest` is
simply a malformed dispatch: refused with a typed error, head offset unchanged.

Contract frozen here (documented verbatim in the package readme, enforced by tests):

- **Envelope extension.** `fs.file.patch` follows E1-T01's dotted `fs.*` naming
  convention. Adding it is an *additive* extension of the current frozen envelope at
  `FS_EVENT_VERSION = 2`: the E1-T01/E1-T02 payload schemas are untouched, so **no
  additional version bump** and no regeneration of existing goldens; E1-T01's dispatch rule
  ("unknown `fs.*` types are refused") is extended in this task to accept exactly this
  one new type. Any *later* change to the `fs.file.patch` payload shape, op grammar,
  refusal taxonomy, or fallback rule is an envelope change: `FS_EVENT_VERSION` bump
  plus regeneration of every fs golden, this task's included.
- **Op grammar.** `ops` is a JSON array of `["=", n]` / `["+", s]` / `["-", n]` tuples,
  `n` a positive safe integer, `s` a non-empty string. Ops apply left-to-right over the
  base's UTF-8 bytes; the sum of `=` and `-` lengths must equal the base byte length
  exactly (no implicit trailing copy). Adjacent ops of the same kind are forbidden
  (canonical form). A `["+"]` insert string must contain no unpaired surrogate code
  units — equivalently, it must encode to valid UTF-8; a payload whose JSON string
  escapes decode to a lone surrogate (e.g. `"\uD800"` unpaired) is refused as
  `patch/malformed-ops`. Inserts land at byte positions; the *result* must decode as valid UTF-8 —
  a patch that splices mid-codepoint is refused even if structurally well-formed.
- **Wire bytes.** Defined against E1-T01's split-stream layout. A full write ships its
  metadata event payload `{ v: 2, path, contentSha256, size }` *plus* the full target
  content appended to the per-file content stream:
  `fullWireBytes = byteLength(canonicalJson(fullWritePayload)) + byteLength(targetBytes)`.
  A patch carries its ops inline in the metadata event payload and appends **nothing**
  to any content stream:
  `patchWireBytes = byteLength(canonicalJson(patchPayload))`.
  These two formulas are the only meaning of "wire bytes" anywhere in this task —
  in the fallback rule, the fixtures' `patchedWireBytes`/`fullwriteWireBytes`, and the
  bytes-on-the-wire acceptance criterion.
- **Fallback rule.** `fs.file.patch` is only emitted when: base and target are valid UTF-8
  with no `0x00` byte; `path` currently exists as a file; and
  `patchWireBytes < fullWireBytes` per the formulas above.
  Every other write — binary content, new files, large deltas, whole-file replaces
  where the diff loses — is a full-content write. The choice is a pure function of
  (base bytes, target bytes); it must not depend on time, randomness, or config.
- **Deterministic diff.** The diff generator is deterministic: the same (base, target)
  pair always yields the same `ops` byte-for-byte. Golden patch logs pin this; a smarter
  diff algorithm later is a contract change (regenerate goldens, loudly).
- **Refusal taxonomy.** Dispatch-time validation (through E0-T11's validated-dispatch
  door) refuses with a typed error body, distinct types at minimum:
  `patch/malformed-ops`, `patch/base-mismatch`, `patch/result-mismatch`,
  `patch/target-not-a-text-file`. Every refusal leaves the stream head offset unchanged.

Non-goals: no fencing (E1-T04), no `watch()` (E1-T05), no merge (E1-T09/T10), no rename
interplay beyond "patching a nonexistent path is refused" (directory ops are E1-T02 and
not a dependency here). Depends only on E1-T01: the frozen fs event envelope, per-file
content streams, file CRUD through dispatch, and the canonical tree digest in
`ef replay`.

## Deliverables

- `packages/streamfs/src/patch/ops.ts` — the frozen op types, `isPatchOps(value)`
  structural guard, and `applyPatch(baseBytes: Uint8Array, ops: PatchOps): Uint8Array`
  — pure, total over valid input, throws typed `PatchError` (carrying the refusal type
  above) on every invalid case.
- `packages/streamfs/src/patch/diff.ts` — `diffText(base: string, target: string):
  PatchOps` — deterministic; property-tested inverse of `applyPatch`.
- `packages/streamfs/src/patch/choose.ts` — `chooseWriteEvent(baseBytes, targetBytes,
  path): FsPatchAction | FsWriteAction` implementing the frozen fallback rule, with the
  size comparison computed per the frozen wire-bytes formulas (canonical-JSON payload
  bytes via `@eforest/protocol`, plus content-stream bytes on the full-write side).
- Reducer extension in `packages/streamfs` registering `fs.file.patch` apply: verify
  `baseDigest` against current content, `applyPatch`, verify `resultDigest`, update the
  content stream state — plus the dispatch-time validator wired through the E0-T11
  validation door so refusals never reach the log. **Replay-time apply is real, not
  trusted:** when folding a dumped log, the reducer tracks each file's content (full
  writes from the content-stream bytes in the dump, patches by running `applyPatch` on
  the tracked base), and a patch event whose ops do not reproduce `resultDigest` from
  the replayed base content makes `ef replay` exit nonzero. A reducer that copies the
  event's `resultDigest` into tree state without applying `ops` is nonconforming.
- `packages/streamfs/fixtures/patches/` — golden patch logs: at least three committed
  edit-sequence fixtures, each with (a) a scripted edit sequence
  (`*.edits.json`: ordered `{path, newContent}` steps), (b) the resulting patch-mode
  event log (`*.patched.events.jsonl`), (c) the forced full-write event log
  (`*.fullwrite.events.jsonl`) — both (b) and (c) are **combined dumps** containing the
  metadata events *and* the per-file content-stream appends they reference (the format
  `ef replay --digest` consumes), so replay has the base content bytes needed to run
  `applyPatch` — and (d) `*.expected.json` recording
  `{ treeDigest, patchedWireBytes, fullwriteWireBytes }`. Fixtures cover: a
  many-small-edits source file session; a unicode-heavy file (astral-plane, combining
  chars, CRLF mixed with LF); and a sequence that *triggers fallback mid-stream*
  (a binary write and a whole-file replacement interleaved with text edits).
- `packages/streamfs/fixtures/fuzz/patch-refusals/` — the committed refusal corpus:
  every malformed/misanchored payload class the fuzzer finds, one JSON file each,
  replayed as regression tests asserting the exact refusal type and an unchanged head
  offset.
- `packages/streamfs/test/patch.test.ts` — unit tests: op-grammar accept/reject
  matrix, including the unpaired-surrogate rule above (an insert whose JSON escapes
  decode to a lone surrogate such as `"\uD800"` is refused `patch/malformed-ops`;
  a properly paired surrogate escape sequence is accepted); `applyPatch` byte-exact
  vectors including multi-byte boundary and
  mid-codepoint-splice refusal; digest-anchoring refusals; canonical-form (no adjacent
  same-kind ops) enforcement.
- `packages/streamfs/test/patch.property.test.ts` — seeded property tests (committed
  seeds): `applyPatch(base, diffText(base, target)) === target` bytes-exact over
  generated unicode text pairs; diff determinism (`diffText` twice → identical ops);
  `chooseWriteEvent` purity (same input → same choice) and the size rule
  (`fs.file.patch` chosen ⟹ its canonical payload is strictly smaller).
- `packages/streamfs/test/patch.equivalence.test.ts` — the parity suite: for each
  fixture edit sequence, drive it through a real stream-server instance twice (patch
  mode and forced-full-write mode), dump both logs, `ef replay --digest` each, assert
  identical tree digests matching the committed `treeDigest`, and assert
  `patchedWireBytes < fullwriteWireBytes` recomputed from the dumped logs.
- `tools/verify/patch_parity.mjs` (called by the Makefile target) — runs the
  equivalence harness from committed fixtures in two separate node processes (one per
  mode), prints per-fixture
  `fixture=<name> patchDigest=<d> fullDigest=<d> expected=<d> patchBytes=<n>
  fullBytes=<n> OK`, then the sensitivity leg: flip bytes that fall **inside the
  `ops`, `baseDigest`, or `resultDigest` field value** of committed golden patch
  events (not the envelope, `ts`, or JSON framing — each flip must leave the line
  parseable as JSON), at least one mutation targeting `ops` and being
  grammar-preserving (a byte inside a `["+", s]` insert string's value, per the
  sensitivity criterion), and assert replay refuses or digest-mismatches (nonzero
  exit) per mutation, printing `MUTATION fixture=<name>
  field=<ops|baseDigest|resultDigest> byte=<offset> EXPECTED-FAIL OK`.
- `Makefile`: `verify-E1-T03` inside the marker section composing the frozen `_v-*`
  gates plus `patch_parity.sh`; joins `verify-all`; `make verify-list` maps it to this
  task; `tools/verify/self_check.sh` still passes.

## Acceptance criteria

- [ ] `make verify-E1-T03` exits 0 from a pristine cold clone
      (`tools/verify/cold_clone.sh` path) with zero `SKIPPED:` lines — evidence, two
      separate commands: (a) `tools/verify/cold_clone.sh make verify-E1-T03;
      echo exit=$?` prints `exit=0`, and (b)
      `make verify-E1-T03 2>&1 | awk '/^SKIPPED:/{n++} END{print n+0}'` prints `0`.
- [ ] **Equivalence digest.** For every committed fixture edit sequence, the patch-mode
      combined dump and the forced-full-write combined dump (metadata events plus
      content-stream appends, per the fixtures deliverable) replay to byte-identical
      canonical tree digests equal to the committed `treeDigest`, computed by
      `ef replay --digest` in two separate node processes. Digest parity must depend on
      actual patch application, not on a digest carried in the event: `ef replay` must
      exit nonzero on a patch event whose ops do not reproduce `resultDigest` from the
      replayed base content — evidence: `make verify-E1-T03` output contains one
      `fixture=<name> patchDigest=<d> fullDigest=<d> expected=<d> ... OK` line per
      fixture with all three digests equal, and the sensitivity leg below demonstrates
      the nonzero exit on a corrupted `ops` field.
- [ ] **Bytes on the wire.** For every fixture, `patchBytes < fullBytes`, each computed
      per the frozen wire-bytes formulas (sum over events of canonical-JSON metadata
      payload bytes, plus, for each full write, the content bytes it appended to the
      per-file content stream) and recomputed from that mode's dumped combined log —
      both the metadata events and the content-stream appends recorded in it — not read
      from the expected file — and the harness must also compare each recomputed value
      against the corresponding `patchedWireBytes`/`fullwriteWireBytes` in
      `*.expected.json`, printing a grep-able `WIREBYTES-MISMATCH` marker and exiting
      nonzero on any disagreement — evidence: the same output lines; the harness exits
      nonzero if any fixture's patch log is not strictly smaller; and recomputation has
      a tooth: in a disposable worktree, corrupt `patchedWireBytes` in one
      `*.expected.json` — `make verify-E1-T03` must go red there with
      `make verify-E1-T03 2>&1 | grep -c 'WIREBYTES-MISMATCH'` ≥ 1, proving the values
      are recomputed rather than echoed from the expected file.
- [ ] **Fallback.** The mixed fixture's patch-mode log demonstrably contains both event
      kinds: at least one `fs.file.patch` and at least one `fs.file.write` (the full-content
      write event type frozen by E1-T01) for its binary and whole-file-replace steps —
      evidence: `grep -c '"fs.file.patch"' <fixture>.patched.events.jsonl` ≥ 1 and
      `grep -c '"fs.file.write"' <fixture>.patched.events.jsonl` ≥ 1 against the
      committed golden.
- [ ] **Refusals leave the log untouched.** Every corpus file under
      `fixtures/fuzz/patch-refusals/` dispatched against a live server is refused with
      its recorded typed error, and the stream head offset read before and after the
      refused dispatch is identical — evidence: the regression test asserts
      offset-before === offset-after per case; `pnpm test --filter @eforest/streamfs`
      exits 0 with the corpus non-empty
      (`ls packages/streamfs/fixtures/fuzz/patch-refusals/ | wc -l` ≥ 8) and covering
      all four refusal types — per-type evidence: for each of `patch/malformed-ops`,
      `patch/base-mismatch`, `patch/result-mismatch`, and
      `patch/target-not-a-text-file`,
      `grep -rl '<type>' packages/streamfs/fixtures/fuzz/patch-refusals/ | wc -l`
      prints ≥ 1.
- [ ] **Sensitivity.** The mutation leg runs inside `make verify-E1-T03`. At least one
      mutation must have `field=ops` (further mutations may additionally target
      `baseDigest` or `resultDigest`). The `ops` mutation must be **grammar-preserving**:
      flip a byte inside a `["+", s]` insert string's value so the ops remain
      structurally valid and still exactly consume the base, but produce different
      result content — only genuine replay-time `applyPatch` can then detect the
      `resultDigest` mismatch; a reducer that merely validates op grammar and trusts
      the event's `resultDigest` stays green and is caught. Every flip leaves the line
      parseable as JSON, so a green replay after the flip could only mean the anchoring
      apparatus is broken → replay goes red (refusal or digest mismatch), printed as
      `MUTATION ... EXPECTED-FAIL OK` only after observing the nonzero exit — evidence:
      `make verify-E1-T03 2>&1 | grep -c 'MUTATION .*field=ops.*EXPECTED-FAIL OK$'`
      ≥ 1.
- [ ] **Frozen contract.** The op grammar, fallback rule, and refusal taxonomy are
      documented verbatim in `packages/streamfs` readme with the golden-invalidation
      rule stated; property tests carry committed seeds (grep the seed constants in the
      diff); no `.skip`/`.todo` tests and no new inline lint disables in `src/` —
      evidence: the committed files plus `pnpm test` exit 0.
- [ ] All workspace gates pass repo-wide: `pnpm format:check && pnpm lint &&
      pnpm typecheck && pnpm test && pnpm build` exit 0; `make verify-list` shows
      `verify-E1-T03`; `tools/verify/self_check.sh` passes.
- [ ] Durable evidence committed under this task's `evidence/`: the final
      `make verify-E1-T03` output (all parity lines, byte counts, and the MUTATION
      marker), plus the dumped patch-mode and full-write logs for one fixture and their
      `ef replay --digest` outputs — cited by path and digest in the Verification log.
- [ ] Replay browser layer: N/A (no browser-reaching surface; stream-fs internals) —
      mitigation: stream-layer evidence above is the currency; the Verification log
      entry declares this explicitly per AGENTS.md.

## Adversarial verification

Your mission: prove a patch is *not* just an encoding — find one edit sequence, one
byte, or one refusal path where the patched world and the full-write world disagree.
Use your own inputs everywhere; the builder's fixtures are the floor, not the ceiling.

1. **Equivalence, your own edits.** Script your own edit sequences — do not reuse the
   fixtures — and run both modes through the harness: edits that splice at multi-byte
   UTF-8 boundaries, CRLF↔LF churn, an edit that makes the file empty then refills it,
   an append-only session, a whole-file replace, an edit whose diff is exactly one byte
   smaller than the full write. `ef replay --digest` over both dumped logs must be
   identical for every sequence. **One divergent digest refutes the task.**
2. **Fallback boundary sabotage.** Construct targets that sit exactly on the size rule:
   patch payload bytes == full payload bytes (must fall back — the rule is strict `<`),
   and == full − 1 (must patch). Then attack binary detection: a valid-UTF-8 file
   containing a `0x00` byte (must fall back), a file of only astral-plane codepoints
   (must patch), invalid UTF-8 in the *base* with a text target. Any `fs.file.patch` event
   whose canonical payload is ≥ its full-write equivalent on the wire, or any binary
   content shipped as a patch, refutes the frozen fallback rule.
3. **Misanchor attack.** Dispatch a structurally perfect patch whose `baseDigest`
   matches an *earlier* version of the file (write v1, write v2, then patch anchored to
   v1). It must be refused as `patch/base-mismatch` and — read the head offset via the
   stream API before and after — the log must be untouched. A patch that applies against
   the wrong base, or a refusal that still advanced the offset, is a refutation. Also
   dispatch a patch with a *correct* `baseDigest` but a wrong `resultDigest`: it must
   refuse as `patch/result-mismatch`, never half-apply.
4. **Ops fuzz.** Fuzz the dispatch door with your own generator (fresh seed, cite it):
   negative and zero lengths, `["=", n]` overrunning the base, ops that under-consume
   the base, adjacent same-kind ops, inserts that splice mid-codepoint, non-tuple
   junk, deeply nested arrays, `ops: []` against non-empty base. Every case must refuse
   with a taxonomy type and an unchanged head offset. **Any accepted malformed patch is
   a refutation; any refusal that mutated state is a worse one.** Promote every novel
   surviving case into `fixtures/fuzz/patch-refusals/`.
5. **Golden rot + generator determinism.** Regenerate the fixtures' patch logs from
   their `*.edits.json` with the committed code: byte-diff against the committed
   `*.patched.events.jsonl` — any difference refutes diff determinism. Then flip a byte
   of your own choosing (a different event and offset than the harness's) in a golden
   patch log and confirm replay goes red. A green replay of a corrupted golden refutes
   the anchoring apparatus entirely.
6. **Differential apply.** Take one committed `fs.file.patch` event and apply it
   independently — parse the ops and fold them over the base bytes in python or a
   from-scratch script, `shasum -a 256` the result — and compare against the event's
   `resultDigest` and the package's `applyPatch` output. Disagreement between
   independent apply and the package refutes the apply semantics; a `resultDigest` only
   the package's own code can reproduce is needs-evidence.
7. **Sabotage-check the suites.** In a disposable worktree: (a) off-by-one
   `applyPatch`'s copy length, (b) make `chooseWriteEvent` always choose patches,
   (c) skip the `baseDigest` check in the reducer, (d) make `diffText` nondeterministic
   (e.g. iterate a `Set`), (e) make the reducer copy the event's `resultDigest` into
   tree state without applying `ops` — the trusting reducer the Deliverables section
   names nonconforming. For each sabotage, `pnpm test` **and** `make verify-E1-T03`
   must both go red. Any sabotage that stays green refutes the suite it slipped past.
8. **Purity and environment.** Grep the patch modules for `Date.now`, `Math.random`,
   `process.env`, locale-sensitive APIs (`localeCompare`, `toLocaleString`, `Intl`);
   rerun the parity harness under `TZ=Pacific/Kiritimati LANG=C` — digests and wire-byte
   counts must be identical to the default-env run. Environment-sensitive output
   refutes deterministic apply.
9. **Cold-clone + scope creep audit.** Run `make verify-E1-T03` via
   `tools/verify/cold_clone.sh`. Confirm the two parity replays are separate OS
   processes. Then check the diff stayed in its lane: no fencing semantics (`Stream-Seq`
   conditional-append behavior is E1-T04), no watch/merge code smuggled in — unexercised
   out-of-scope diff is unproven-or-dead, critic's choice.

Refutation → `status: refuted`, repro appended below, back to the builder. No
refutation → promote at minimum: your own edit sequences from angle 1 as a committed
fixture, and every novel fuzz refusal from angle 4 into the corpus.

## Verification log

### 2026-07-12 — builder — IMPLEMENTED

- Commit `39e28e156e049d68349b6c0567f574f2e67cd194` implements the v2-additive
  `fs.file.patch` contract, deterministic byte diff/apply, strict full-write fallback,
  live typed refusals, replay-time content application, fixture parity, and the refusal
  corpus.
- `CI=true make verify-E1-T03` passed: format, lint, typecheck, 18 test files / 117
  tests, build, prior E1 gates, `verify-list`, three combined patch/full-write fixtures,
  wire-byte recomputation, and grammar-preserving ops sensitivity. The final output is
  committed at `evidence/final-verification.txt`.
- Stream evidence: `packages/streamfs/fixtures/patches/small-edits/patched.events.jsonl`
  and `fullwrite.events.jsonl` both replay to
  `d381fccda7ff8d2e987bca43208407a57f66378ce61dfc610b934507bef85c8f`; recomputed wire
  bytes are `1739 < 2011`. The mutation leg changes an insert byte and reports
  `MUTATION ... field=ops ... EXPECTED-FAIL OK`.
- `CI=true tools/verify/cold_clone.sh verify-E1-T03` passed from a pristine clone of
  the committed builder state; the transcript is `evidence/cold-clone.txt`.

Replay: N/A (stream-fs library, server, and CLI internals; no browser-reaching surface
until Epic 3) + mitigation: committed combined event logs, independent replay digests,
wire-byte recomputation, typed head-neutral refusal corpus, full workspace gates, and
scrubbed cold-clone evidence.

The recorded stream-layer run demonstrates compact text patches and full-write fallback
across ordinary, Unicode, binary, and whole-replacement edits; actual replay applies the
ops to tracked bytes, and the sensitivity mutation proves a reducer that merely trusts
`resultDigest` would fail. Status remains `implemented` until a fresh critic promotes or
refutes the claim.

### 2026-07-12 — critic — VERDICT: refuted

- **P1 consecutive live patches — FAILED.** Predicted a second patch would apply to the
  current bytes after the first patch; the live validator instead read only the last full
  content append, so the second Unicode patch was anchored to stale bytes and was refused
  (`patch/malformed-ops`). The failure is visible in the second patch of
  `packages/streamfs/fixtures/patches/unicode/patched.events.jsonl`; the old code path was
  `packages/streamfs/src/server.ts`'s `contentBytes()` helper. Demand a live regression
  test for consecutive patches and reconstruct current bytes from prior metadata patches.
- **P2 parity coverage — FAILED.** The original equivalence test folded committed combined
  logs directly and did not drive a real stream-server in patch and forced-full modes, so
  it could not catch the live validator failure. The test must exercise both modes through
  separate server instances.
- Commands/evidence: fresh critic attack against `39e28e1..fd292a1`; no Replay browser
  applies (stream-fs internals). Status returns to `in-progress` for builder rework.

### 2026-07-12 — builder — IMPLEMENTED after rework

- Commit `77135d8` reworks the live validator to reconstruct current bytes by folding
  prior metadata patches over the latest full content event, adds a consecutive-patch
  regression, and changes the equivalence suite to drive separate real stream-server
  instances in patch and forced-full modes. Fixture IDs now match the real stream-fs
  content-stream identity contract.
- `CI=true make verify-E1-T03` passed again: format, lint, typecheck, 18 test files / 117
  tests, build, prior E1 gates, verify-list, live refusal corpus, real-server parity,
  combined-log replay, wire-byte recomputation, and mutation sensitivity. The rework
  output is committed at `evidence/rework-verification.txt`.
- Updated stream evidence: `small-edits` patch/full combined logs replay to
  `72625bb7f9521e2508675cf668239d99d4f883b2d369e4bbec067b421f8bfcd2`, with recomputed
  wire bytes `1756 < 2028`; `unicode` replays to
  `ae1ea2f5adf84fcdeba49c686ca2c3065fd18613998776f526e5965e4e9d21dd` and exercises
  consecutive live patches.

Replay: N/A (stream-fs library, server, and CLI internals; no browser-reaching surface
until Epic 3) + mitigation: live server tests in separate patch/full instances,
committed combined event logs, independent replay digests, wire-byte recomputation,
typed head-neutral refusal corpus, full workspace gates, and the pending rework
cold-clone transcript.

The rework run demonstrates that consecutive live patches use the current reconstructed
content rather than a stale full-write base, while patch and forced-full server sessions
still converge to identical canonical tree digests. Status remains `implemented` until a
fresh critic re-audits the rework.
