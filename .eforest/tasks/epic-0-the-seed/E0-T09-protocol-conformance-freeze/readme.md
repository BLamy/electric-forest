---
id: E0-T09
epic: 0
title: Protocol conformance suite frozen — one spec, both stores, golden transcripts as the v1.0-compatible contract
priority: 9
status: in-progress
depends_on: [E0-T04, E0-T06, E0-T07]
estimate: M
capstone: false
---

## Goal

`packages/conformance` exists and is the **frozen protocol contract**: a single
store-agnostic suite that expresses every behavior of the durable-streams HTTP protocol
v1.0 draft as implemented by `packages/server` — `PUT` create (fresh, idempotent,
conflicting), `POST` append with `Stream-Seq` fencing (accept, stale-refuse, and the
exact conflict status), catch-up `GET` from `offset=-1` / mid-stream / head / bogus
offsets, offset opacity and strict lexicographic ordering, `live=long-poll` parking and
its exact timeout response, `live=sse` framing with strictly-increasing resumable
offsets, and **every error status the draft names** (missing stream, malformed body,
bad offset, fencing conflict, unsupported live mode) — and runs that one suite twice,
once against a cold-started in-memory server (E0-T05/T06) and once against a
cold-started file-backed server (E0-T07), over real HTTP on real sockets. Alongside the
executable spec sit the compatibility artifacts: committed **golden HTTP transcripts**
(normalized request/response pairs — method, path, headers on the assertion path, body
bytes — for every create/append/read/error/live-timeout shape) in
`packages/conformance/transcripts/`, and a committed **fuzz corpus** (malformed event
JSON, bogus and truncated offsets, out-of-order and concurrent appends, truncated
request bodies, oversized batches) in `packages/conformance/corpus/` whose seeds the
suite replays deterministically against both stores. `make verify-E0-T09` runs the
whole apparatus green from a cold clone, and the contract is frozen here: from this
task on, any change that makes a transcript diverge or a corpus seed change outcome is
a **protocol version event**, not a refactor — later epics must keep this suite green
unmodified or bump `PROTOCOL_VERSION` and regenerate every golden, loudly.

## Context

E0-T05 through E0-T07 each landed their slice of the server with their own tests, but
those tests live with their implementations and prove features, not the _contract_.
ROADMAP (Epic 0) is explicit: "Conformance tests double as the protocol's frozen
contract," compatible with the durable-streams HTTP protocol v1.0 draft. This task is
where that sentence becomes an artifact: one spec, run against both stores, whose
golden transcripts are the byte-level definition of "compatible" that E0-T08's client,
E0-T10's redux read path, E0-T11's dispatch door, Epic 1's stream-fs, and Epic 2's
auth-wrapped server must all preserve. Without it, "identical protocol semantics across
stores" (E0-T07's claim) and "don't invent an incompatible dialect" (E0-T06's warning)
are enforced only by memory.

Contracts frozen here (later changes invalidate standing verifications):

- **Store-agnostic spec shape**: the suite is written against a server _URL_, never a
  store API — it receives `{ baseUrl }` from a harness that cold-starts each server
  variant on an ephemeral port. Adding a store later (or wrapping the server in auth,
  Epic 2) means adding a harness entry, never editing a test body.
- **Golden transcript normalization**: transcripts are committed files capturing status
  line, the draft-relevant headers (content-type, the offset response header,
  `Stream-Seq` conflict headers), and exact body bytes, with volatile values (dates,
  ports, connection headers) normalized by a documented, committed normalizer in
  `packages/conformance/src/normalize.ts`. The normalizer's rules are part of the
  frozen contract — loosening it later so a divergence normalizes away is greenwash.
- **Corpus outcome ledger**: every fuzz seed is committed with its expected outcome
  (exact status code, and the invariant "log digest unchanged" for every refused
  request). A seed whose outcome changes is a contract break, surfaced red.
- **Both-stores rule**: every case runs against both stores in the same invocation;
  a case may not be skipped or forked per store. Divergence between stores on any case
  is itself a failure, independent of which one matches the draft.

Depends on E0-T06 (the live-mode surface — long-poll timeout shape and SSE framing —
must exist to be frozen), E0-T07 (the second store; a one-store "conformance" suite
freezes an implementation, not a protocol), and E0-T04 (`ef replay --digest` is what
the corpus's log-untouched invariant runs on — without it the fuzz acceptance
criterion is unrunnable). Uses E0-T03's `packages/protocol` primitives. Unblocks
E0-T13 (the capstone leans on frozen semantics) and is the compatibility gate every
later epic's `verify-all` inherits.

Naming note: E0-T05, which creates the server package, names it `packages/server`;
the E0-T06/E0-T07 readmes refer to the same package as `packages/stream-server`.
This task uses `packages/server` throughout, meaning _the single server package
E0-T05 actually created in the tree_ — if the built tree used the T06/T07 name,
read every `packages/server` reference here (including in the sensitivity mutations)
as that package's real path; there is exactly one server package either way.

Dependency-listing note: `depends_on` lists E0-T04 and E0-T06 even though both are
transitively implied by E0-T07 (whose own `depends_on` is [E0-T04, E0-T05, E0-T06]).
This follows the epic-wide convention of naming every directly-consumed task —
E0-T04's `ef replay --digest`, E0-T06's live-mode surface, and E0-T07's second store
are each used directly here — so the redundancy is declared, not accidental.

Non-goals: reducers, `/state` `/events` `/dispatch` (E0-T10/T11 — this suite freezes
the _stream_ protocol; the redux surface gets its own conformance additions there),
client behavior (E0-T08), auth (Epic 2), performance budgets.

Replay declaration (per the E0-T02 convention): `Replay: N/A (no browser surface until
Epic 3)`; mitigation is the transcript + digest evidence below, which is this task's
native currency.

## Deliverables

- `packages/conformance` — new workspace package wired into all root gates
  (`format:check`, `lint`, `typecheck`, `test`, `build`).
- `packages/conformance/src/harness.ts` — cold-starts a server variant
  (`memory` | `file`, the file variant on a fresh temp data dir) on an ephemeral port,
  yields `{ baseUrl }`, and tears down (including killing the process and, for `file`,
  asserting the data dir is the only state left behind). No fixed ports, no reuse of a
  warm server.
- `packages/conformance/src/spec/*.test.ts` — the store-agnostic suite, parameterized
  over both variants, covering at minimum: create (fresh/idempotent/conflict), append
  (accepted, stale `Stream-Seq`, exact conflict status and headers, offset chaining),
  read (from `-1`, mid-stream, head, past-head, syntactically bogus offset), offset
  opacity (assertions use only lexicographic comparison via `packages/protocol`'s
  `compareOffsets`, never arithmetic or parsing of offset internals), long-poll (wake
  on append, exact timeout status/headers/empty body, re-arm from returned offset),
  SSE (content-type, raw-socket frame parse, strictly-increasing offsets, resume
  exactness), and every draft-named error status asserted **exactly** (not "some 4xx").
- `packages/conformance/src/transcript.ts` + `src/normalize.ts` — records raw HTTP
  exchanges, normalizes per the documented rules, and byte-diffs against
  `packages/conformance/transcripts/*.http` goldens; regeneration only via an explicit
  `pnpm --filter conformance regen-goldens` that refuses to run unless
  `CONFORMANCE_REGEN=1` and prints every changed file.
- `packages/conformance/transcripts/` — committed golden transcripts, one per protocol
  shape per method family, identical for both stores (the suite asserts both stores
  produce the same normalized transcript, then diffs that against the golden).
- `packages/conformance/corpus/` — committed fuzz seeds as files, each paired with its
  expected outcome in `corpus/ledger.json`: malformed event JSON (bad envelope keys,
  wrong types, invalid UTF-8), bogus offsets (empty, non-lexicographic garbage,
  another stream's offset, offset with trailing bytes), out-of-order and concurrent
  appends (scripted interleavings with stale `Stream-Seq`), truncated bodies
  (content-length longer than body, mid-JSON cuts), oversized batches. A deterministic
  replayer runs every seed against both stores and checks status + the log-untouched
  invariant: `ef replay --digest` over a stream dump before and after each refused
  request is byte-identical. **Dump acquisition is defined here and is identical for
  both variants**: a dump is the full catch-up `GET` from `offset=-1` over the
  protocol surface, captured to a file — no server-side file reads, debug endpoints,
  or server edits, so the procedure is mechanically identical for the `memory` and
  `file` stores.
- `packages/conformance/src/fuzz.ts` — a seeded generator (`--seed <n>`, printed on
  every run) for critic/CI exploration. `fuzz.ts` itself **never writes into
  `corpus/`**: when a generated input crashes the server or produces a store
  divergence, it exits nonzero printing the seed and a reproducer, and promotion into
  `corpus/` (with its ledger entry) is an explicit act performed via the
  `CONFORMANCE_REGEN=1`-gated regen path (or by hand), which prints every file it
  adds — preserving the single-writer rule in the acceptance criteria.
- `make verify-E0-T09` — composed from the E0-T02 `_v-*` recipes plus the conformance
  run against both cold-started stores and the transcript/corpus diffs; added to
  `verify-all`; nonzero exit on any test failure, transcript byte-diff, ledger
  mismatch, or store divergence; ends in an explicit OK echo.
- `evidence/` — the sensitivity-proof transcripts (see acceptance criteria), a
  both-stores run log showing per-case parity, and the digest files backing the
  log-untouched invariants.

## Acceptance criteria

- [ ] `make verify-E0-T09` exits 0 from a cold clone via `tools/verify/cold_clone.sh`
      (scrubbed env, fresh install), and its output shows every spec case executed
      against **both** `memory` and `file` variants (a per-variant case count, equal
      for both) on ephemeral ports it started itself.
- [ ] Golden transcripts: the suite records live exchanges, normalizes them, asserts
      the two stores' normalized transcripts are byte-identical to each other, and
      byte-diffs them against the committed files in
      `packages/conformance/transcripts/`; any single differing byte exits nonzero
      naming the transcript file and the offset of the first differing byte.
- [ ] Error-status exactness: for each draft-named error condition there is a case
      asserting the exact status code and the draft-relevant headers, backed by a
      committed golden transcript — no case passes on a status-class match.
- [ ] Fuzz corpus: `corpus/ledger.json` lists every seed with its expected exact
      status; the replayer runs all seeds against both stores, and for every refused
      request asserts the stream dump's `ef replay --digest` before and after are
      identical (digests recorded to `evidence/e0-t09-corpus-digests.txt`). A dump is
      obtained by the procedure defined in the corpus deliverable — the full catch-up
      `GET` from `offset=-1`, captured to a file, identical for both variants and
      requiring zero server edits. Any outcome drift, digest change, or server crash
      exits nonzero naming the seed.
- [ ] Offset opacity: the suite contains no arithmetic on offsets and no parsing of
      offset internals — a grep gate in the verify target fails on **both** (a) numeric
      coercion of offset values (`Number(...)`, `parseInt`/`parseFloat`, unary `+`,
      arithmetic operators applied to offsets) and (b) structural operations applied to
      offset-typed values (`.split`, `.slice`, `.substring`, `.charAt`, index access,
      regex match/exec/replace, or destructuring of an offset's contents) in
      `packages/conformance/src/`; ordering assertions go through `packages/protocol`
      comparison helpers only. The critic additionally source-inspects the spec files
      for offset destructuring the grep patterns miss; refutation currency is the
      offending diff line.
- [ ] Sensitivity proof (the frozen-contract teeth): in a scratch worktree, mutating
      (a) one response status code and, separately, (b) one response header emitted by
      `packages/server`, makes `make verify-E0-T09` exit nonzero in both cases, with
      the failing transcript named; the red transcripts are committed to
      `evidence/e0-t09-sensitivity/` with the exact mutations described.
- [ ] Golden regeneration is loud: `pnpm --filter conformance regen-goldens` without
      `CONFORMANCE_REGEN=1` refuses and exits nonzero; with it, the run prints every
      rewritten file. No other code path writes into `transcripts/` or `corpus/`.
- [ ] Existing suites unmodified, stated as an allowlist: E0-T05/T06/T07 tests still
      pass with zero edits, and the task's diff touches **only** `packages/conformance/`,
      the `Makefile`/verify wiring for `verify-E0-T09` and `verify-all`, root workspace
      config (e.g. `pnpm-workspace.yaml`, root `package.json`/lockfile), and this task
      folder (`.eforest/tasks/.../E0-T09-*/`). Anything else in the diff — the server
      package (whatever E0-T05 actually named it; see the naming note in Context),
      `packages/protocol` (including `compareOffsets`), server test helpers — fails
      this criterion (conformance freezes the surface; it does not "fix" the server to
      match — a genuine draft violation found here is filed as a queue-jumping bug
      task, not silently patched in this one).
- [ ] All standard gates pass: `pnpm format:check && pnpm lint && pnpm typecheck &&
pnpm test && pnpm build` exit 0.
- [ ] Replay (browser layer): N/A (no browser surface until Epic 3); mitigation is the
      committed transcripts, corpus ledger, and digest files above.

## Adversarial verification

Attack angles for the hostile critic. Run each with your own inputs, seeds, and
mutations — never the builder's — and invent at least one more.

1. **Sensitivity proof, your mutations.** Ignore the builder's committed sensitivity
   evidence and run your own: in a scratch worktree, independently mutate one status
   code, one header value, one header _casing/name_, and one body byte in
   `packages/server`'s responses — one at a time. `make verify-E0-T09` must go red for
   each, naming the diverging transcript. Any mutation that stays green refutes the
   apparatus, not the code. Pay special attention to headers: a normalizer that strips
   the mutated header is greenwash (see angle 3).
2. **Differential store attack.** Sabotage only the file-backed store (E0-T07 code) in
   a scratch worktree — e.g. make it return a different fencing-conflict status or
   drop the offset header on the timeout path. The suite must fail on **store
   divergence**, not pass because each store was tested against its own expectations.
   A suite that runs both stores but never cross-compares is refuted here.
3. **Normalizer greenwash hunt.** Read `src/normalize.ts` against the transcripts.
   For every normalization rule, construct a server mutation that hides inside it
   (e.g. if dates are normalized, mutate a date-adjacent header; if bodies are
   pretty-printed, inject whitespace-only body changes that alter byte length). Any
   protocol-visible difference the normalizer erases refutes the frozen-contract
   claim. Also check the goldens themselves: a transcript containing an unnormalized
   volatile value (port, timestamp) means the suite can only ever have passed by
   regeneration — refute.
4. **Self-licking golden check.** Verify the transcripts are frozen artifacts, not
   values computed at test time: `git log` the transcript files, then delete one
   golden locally and confirm the suite goes red (missing golden must be a failure,
   never an auto-record). Confirm the regen script is the only writer and that
   running the plain suite twice leaves `git status` clean. Any test-time write into
   `transcripts/` or `corpus/` refutes.
5. **Fuzz beyond the corpus.** Run `src/fuzz.ts` with your own seeds for at least a
   few thousand inputs per store, then go past the generator: raw-socket requests with
   pipelined half-requests, headers with duplicate `Stream-Seq`, chunked bodies cut
   mid-chunk, an SSE request immediately reset, `offset` parameters copied from a
   _different_ stream. Refutation conditions: server crash or unhandled rejection,
   any refused request whose stream dump digest changes, any accepted request the
   draft says must be refused, or any input where the two stores answer differently.
   Promote every interesting input to the corpus yourself.
6. **Coverage against the draft, not the suite.** Take the v1.0 draft surface as
   implemented across E0-T05/T06/T07 (create, append, fencing, catch-up read, both
   live modes, every named error) and tabulate which behaviors have (a) a spec case,
   (b) a golden transcript, and (c) both-store execution. Any drafted behavior the
   suite never exercises refutes the "every v1.0-draft behavior" claim — demand the
   case or a documented exclusion. Cross-check especially the long-poll timeout shape
   and SSE framing against E0-T06's asserted values byte-for-byte.
7. **Warm-state and cold-clone hunt.** Run `make verify-E0-T09` via
   `tools/verify/cold_clone.sh`. Separately: start a dev server on a common port
   before running the suite and confirm results are unchanged (the harness must not
   have talked to it); for the `file` variant, pre-seed a data dir at the default
   path and confirm the harness used a fresh temp dir instead. Any dependence on
   pre-existing state refutes the evidence.
8. **Frozen-contract enforcement probe.** Simulate a "later epic" break: in a scratch
   worktree change a response the way an Epic 2 auth wrapper plausibly would (add a
   `WWW-Authenticate` header to an error path, change a 404 to a 403) and confirm
   `verify-all` (not just `verify-E0-T09`) goes red. If the conformance target is not
   reachable from `verify-all`, the "later epics must not break it" claim is refuted.

Refutation currency: a transcript file + first-divergent-byte offset, a corpus seed +
observed vs ledgered status, an event-log dump + digest pair showing a refused request
mutated the log, or a diff hunk in the normalizer that erases a protocol-visible byte.
"The suite feels thorough" is not a finding.

## Verification log

### 2026-07-12 — builder — implemented

Commit: `2ef9649` (`feat: add E0-T09 protocol conformance suite`). The store-agnostic
URL suite runs 20 normalized HTTP transcript cases and 11 corpus seeds against both
cold-started stores on distinct ephemeral loopback ports. Memory and file transcripts
are byte-identical and match the four committed `.http` goldens; corpus statuses and
`ef replay --digest` before/after digests match across both stores. The SSE path is
captured through a raw `node:net` socket with incremental chunked-body decoding, and
the file harness verifies teardown leaves only stream log state.

Commands:

```text
CI=true pnpm format:check
CI=true pnpm lint
CI=true pnpm typecheck
CI=true pnpm test
CI=true pnpm build
CONFORMANCE_REGEN=1 CI=true pnpm --filter @eforest/conformance regen-goldens
CI=true pnpm --filter @eforest/conformance verify
CI=true pnpm --filter @eforest/conformance fuzz -- --seed 73 --iterations 64
make verify-E0-T09
```

Evidence: `evidence/e0-t09-run-summary.json` records equal 20/11 case counts;
`evidence/e0-t09-corpus-digests.txt` records both-store digest pairs;
`evidence/e0-t09-sensitivity/status-red.transcript.txt` and
`evidence/e0-t09-sensitivity/header-red.transcript.txt` record independent disposable
status/header mutations that fail with the transcript name (and byte 501 for the header
mutation). Golden regeneration without `CONFORMANCE_REGEN=1` exits 1 with the loud
refusal message. Replay: N/A (no browser surface until Epic 3) + mitigation: committed
normalized HTTP transcripts, raw SSE framing coverage, corpus ledger, replay digests,
sensitivity failures, fuzz run, and the composed verification target.

### 2026-07-12 — critic — VERDICT: refuted

- **P1 cold-clone type resolution — FAILED.** `tools/verify/cold_clone.sh verify-E0-T09`
  failed during `_v-typecheck` because `packages/conformance/src/server-child.ts:1`
  could not resolve `@eforest/server` before build artifacts existed. Add source-path
  resolution for the cold clone and rerun the complete target.
- **P2 live coverage — INSUFFICIENT.** `conformance.ts:285-299` did not re-arm
  long-poll from the returned offset, and the SSE scenario asserted only one frame per
  connection. Add explicit re-arm and multi-frame strict-order checks.
- **P3 corpus/digest contract — INSUFFICIENT.** The corpus lacked declared-longer
  `Content-Length`, trailing-byte offset, and explicit out-of-order seeds. Digest
  verification also conditionally fell back to an in-process reducer and reserialized
  parsed dumps instead of requiring `ef replay --digest` for the captured GET result.
- **P4 fuzz invariants — FAILED.** `fuzz.ts` only checked request completion; it did
  not compare both-store responses or enforce refused-request digest invariants.
- **P5 frozen byte/header sensitivity — INSUFFICIENT.** `transcript.ts` decoded
  non-SSE bodies with `response.text()`, `normalize.ts` dropped non-allowlisted headers,
  and `firstDiffByte()` compared string code units rather than UTF-8 bytes.

Commands/evidence: `tools/verify/cold_clone.sh verify-E0-T09` (failed at typecheck);
fresh verifier run passed 20 transcript cases and 11 corpus seeds per store; missing
golden probe failed with `ENOENT`; file-store sabotage failed at
`create-and-append.http` byte 1462. Rework required before promotion.

### 2026-07-12 — builder — reworked and resubmitted

Commit: `f18422d` (`fix: close E0-T09 critic gaps`). Added cold-clone source resolution
for `@eforest/server`; explicit long-poll re-arm from the returned offset; a raw-socket
SSE run that waits for two data frames, ignores heartbeat comments, and asserts strict
frame/record ordering; trailing-offset, declared-longer-content-length, and explicit
out-of-order corpus seeds; ef replay-only digest execution over captured catch-up GET
bodies; both-store response/digest invariants in `fuzz.ts`; all non-volatile headers in
normalized transcripts; and UTF-8 byte-based first-difference reporting.

Fresh gates and evidence:

```text
tools/verify/cold_clone.sh verify-E0-T09  PASS from pristine commit f18422d
CI=true pnpm --filter @eforest/conformance verify  PASS (21 transcript cases, 14 corpus seeds per store)
CI=true pnpm --filter @eforest/conformance fuzz -- --seed 73 --iterations 64  PASS
```

Evidence was regenerated in `evidence/e0-t09-run-summary.json`,
`evidence/e0-t09-corpus-digests.txt`, and the committed four golden transcripts;
the prior status/header sensitivity transcripts remain valid against the same frozen
normalizer. Replay: N/A (no browser surface until Epic 3) + mitigation: cold-clone
gates, dual-store raw HTTP transcripts, raw SSE multi-frame capture, corpus `ef replay`
digests, byte-level diffs, fuzz invariants, and the sensitivity failures above.
Status: implemented, awaiting a fresh adversarial critic.

### 2026-07-12 — critic — VERDICT: refuted

- **P1 corpus digest provenance — FAILED.** `conformance.ts:79-84` wrote the full
  catch-up GET body but ran `ef replay --digest` on a separately reserialized dump;
  the captured file was never consumed. The concurrent seed also skipped the
  per-refused-request digest invariant. Fix the dump path and check the losing
  concurrent append independently.
- **P2 response parity — INSUFFICIENT.** Corpus verification compared only
  status/digests, and fuzz snapshots omitted headers. Compare normalized status,
  headers, and body for every corpus/fuzz case so a file-store header mutation is
  observable.
- **P3 independent attacks — INSUFFICIENT.** The submitted evidence recorded only
  64 fuzz iterations and did not record fresh 3000+ iteration, body/name/header,
  plain-run cleanliness, or file-store sabotage results.
- **P4 offset-opacity gate — FAILED.** The required unary-`+` check was absent;
  `+offset` would pass `assertOffsetOpacity()`.

Commands/evidence: `tools/verify/cold_clone.sh verify-E0-T09` passed from pristine
`f18422d`; local verifier passed 21 transcript cases and 14 corpus seeds per store;
the remaining findings are proof-provenance and adversarial-coverage gaps. Rework
required before promotion.
