---
id: E2-T10
epic: 2
title: "Authorization conformance matrix: standing verify harness sweeping identity x operation x visibility against golden decision transcripts"
priority: 210
status: pending
depends_on: [E2-T05, E2-T07, E2-T08, E2-T09]
estimate: M
capstone: false
---

## Goal

`make verify-E2-authz` is a **standing verification target** — not a one-task proof but
a permanent gate that the E2-T12 capstone and every later epic re-earn through
`golden-sweep` — that sweeps the full cartesian authorization matrix over real HTTP and
diffs every decision byte-exact against a committed golden transcript. The three frozen
axes: **identities** — `anonymous` (no `Authorization` header), `token-holder` (a
subject whose only credential is an E2-T05 device-flow CLI token, holding a branch
write grant), `member` (org member with a branch write grant, web-session-derived
token per E2-T04/T05 mint), `non-member` (valid token, zero relationship to the
fixture org), `org-admin` (admin-role membership per E2-T01's frozen role events),
`revoked-grant` (a subject whose write grant was revoked by a `grant.revoke` event at
a cited identity-stream offset, bearer token still cryptographically valid), and
`expired-token` (a token minted past its `exp` via the E2-T02 emulator's pinnable
clock — dies at E2-T03's 401 before any T07 logic runs); **operations** — exactly
seven columns: `create` (repo/branch creation through the E2-T06 namespace dispatch
door), `append` (raw protocol append, with fenced sub-probes: a stale own-lane
`Stream-Seq` must produce E2-T09's frozen 409 and a *different* identity's fence
state must not interfere), `dispatch` (the E0-T11 door), `read` (sub-probes: full
read, `GET /events`, `GET /state`, snapshot bootstrap), `live-tail` (sub-probes:
long-poll and SSE — both must agree with the cell's decision), `fork` (E1's
branch-fork-at-offset, the one write whose effects mint a second stream — every
stream the fork touches is decided, not just the addressed one), and `registry-list`
(sub-probes: E2-T08's `GET /registry/public`, `/registry/org/:org`,
`/registry/me`); **visibility** — one `public` and one `private` repo in the fixture
org (E2-T06 `ns.repo.create` events), targeting the `fs:<org>/<repo>` branch streams
E2-T07 authorizes. That is 7 × 7 × 2 = **98 cells minimum**, the arithmetic asserted
by the harness itself — a cell may carry several sub-probes but no cell may be
skipped, and if a dependency froze more door variants the matrix grows, never
shrinks. All identities exist only as events in a committed fixture identity log
(`packages/platform/fixtures/authz-matrix/identity.jsonl`, E2-T01 shapes) plus a
namespace log; tokens are minted at run time from the cold-started E2-T02 emulator.
Each cell executes over real HTTP against an auth-enabled server seeded solely by
replaying the fixture logs, and canonicalizes to one decision line:
`cell-id | identity | operation | sub-probe | visibility | status | error.class | error.reason`
(allow cells record the frozen success status and `-` for class/reason; no timestamps,
ports, offsets, or token material may appear in the line). The transcript diffs
byte-exact against `packages/platform/fixtures/authz-matrix/decisions.golden.txt`;
any drift anywhere in the matrix is a red run. Every deny cell is proven log-neutral
(head offset + `ef replay --digest` dump digest byte-identical before/after, per
E0-T11/E2-T03/E2-T07 doctrine). The golden is not a snapshot of what the server said:
expected decisions are **derived independently** from E2-T01's reduced authorization
view over the fixture identity log joined with the frozen E2-T07 decision table, and
the harness asserts derivation and observation agree cell-by-cell — two sources, one
truth. The apparatus is proven sensitive inside the target itself: flipping one
membership event in the fixture identity log, or weakening one authorization check in
a scratch worktree, turns the matrix red at exactly the affected cells — no fewer and
no more.

## Context

This is a missing-verification-infrastructure task. Epic 2's authorization behavior is
so far proven slice-by-slice: E2-T03 proved the bearer gate, E2-T05 proved grant
issuance and revocation, E2-T07 proved per-stream read/write and private-invisibility,
E2-T08 proved visibility-filtered registry reads, E2-T09 proved identity-scoped
fencing — each with its own fixtures, each green in isolation. What nothing verifies
is the **product of the slices**: that a revoked-grant subject cannot live-tail a
private repo while its token still authenticates; that an expired token dies with
T03's 401 on every one of the seven operations, not just the ones T03 happened to
probe; that a non-member's fenced append to a private repo is T07's 404, never T09's
409 (authorization precedes fencing); that a fork by a member with a grant on the
source branch does not quietly mint a writable stream the grant never named.
Authorization regressions live in exactly these interaction cells and they regress
silently: a later epic touches the router or reducer registry, one cell flips from
403 to 200, and every per-task suite stays green because none of them owns that cell.
This task closes the gap permanently: one harness, every cell, one golden, run
forever. `verify-E2-authz` is registered as a **standing gate** — added to the
verify-all aggregate and to the golden-sweep inventory (the sweep's job is to re-earn
standing verifications; this target is Epic 2's contribution) — so E2-T11's rate
limits, the E2-T12 capstone, and every Epic 3+ server-touching task inherit it as a
regression tripwire. The capstone's two headline shots (authorized append lands,
tokenless append refused) become two cells of a matrix that is green in its entirety.

Builds on: E2-T05 (the `token-holder` and `revoked-grant` identities are its grant
events; revocation here is one more fixture event, and the token-vs-grant split —
revoked grant refuses with 403/404 while the token still authenticates — is asserted
per T05's contract), E2-T07 (the frozen decision table and refusal shapes are the
policy this matrix industrializes; T07's scripted suite is the seed corpus, this task
is the standing sweep — statuses, classes, reasons, and the private-invisible 404
byte-contract are consumed, never reshaped), E2-T08 (the registry doors and their
per-identity visibility filtering are the `registry-list` column), E2-T09 (the
per-writer fencing semantics are the `append` column's fenced sub-probes, and layer
ordering — authz before fence — is asserted in the deny cells), E2-T01/T02/T03/T04/T06
transitively (identity event shapes, the emulator with seeded randomness and pinnable
clock, the 401 contract, session-derived tokens, the namespace grammar), E1-T03 (fork
semantics), E0-T02/T04 (the verify-target contract and `ef replay --digest`).
(`depends_on` lists E2-T05 and E2-T07 despite their transitivity through E2-T09
because their contracts — the grant/revocation events and the frozen decision
table — are consumed directly here, not only through T09.)

Contract frozen here, versioned from this task forward:

- **The axes and the floor.** The seven identities, seven operation columns, and two
  visibilities named in the Goal are the frozen minimum. The harness computes its cell
  count from an enumerated axis manifest (`matrix.ts` exports the three axis lists) and
  asserts `count >= 98`; removing an identity, operation column, or sub-probe from the
  manifest is a red run, not a quiet shrink. Later tasks may append axis values
  (E2-T11 will add rate-limited variants); each addition regenerates the golden through
  the derivation path with the diff reviewed in that task's evidence.
- **Decision-line grammar.** The canonical line format above, one line per sub-probe,
  lines sorted by `cell-id` (a deterministic slug `E2M-<identity>-<operation>-<sub-probe>-<visibility>`),
  LF-terminated, UTF-8. The canonicalizer scrubs *only* the enumerated volatile fields
  (host, port, date headers, offsets in success bodies, token material); status, class,
  and reason are never scrubbed. The grammar is documented beside the golden and any
  change to it invalidates the golden.
- **Golden provenance.** `decisions.golden.txt` is generated by
  `pnpm --filter @eforest/platform authz-matrix:derive` — the derivation reads the
  fixture logs through E2-T01's reducer and applies E2-T07's frozen table (plus T03's
  401 rows, T08's registry policy, T09's fencing rows); it never contacts a server.
  Committing a golden produced any other way (e.g. piping the live sweep's output into
  the file) is a spec violation the adversarial section attacks directly.
- **Fixture identity log.** One org, seven subjects (one per identity axis value,
  `anonymous` needing none), one public and one private repo, branch write grants for
  `token-holder`/`member`/`org-admin`, one `grant.revoke` at a cited offset for
  `revoked-grant` — all in E2-T01/T05/T06 frozen event shapes, replayed into a fresh
  server data dir at the start of every run. No fixture state lives outside the logs.
- **Standing-gate registration.** `verify-E2-authz` appears in the Makefile verify
  section per the E0-T02 target contract, is invoked by `verify-E2-T10` (the
  task-numbered alias), is included in the verify-all aggregate, and is listed in the
  golden-sweep standing-verification inventory. Deregistering it later requires a task
  that says so.

Non-goals: rate limits and cross-tenant quota probes (E2-T11 extends this matrix, it
does not fork it), the browser-driven capstone demo (E2-T12), timing-channel analysis
of the private-invisible path (T07's documented non-goal stands), performance of the
sweep (it must be deterministic, not fast), and any new server behavior — this task
ships **zero policy changes**; if building the matrix reveals a policy bug, that is a
queue-jumping bug task against the owning dependency, not a silent fix here. Per
AGENTS.md this task has no browser-reaching surface: Replay browser evidence is
declared N/A with the matrix transcript, neutrality digests, and sensitivity
transcripts as the stream-layer evidence currency.

## Deliverables

- `packages/platform/src/authz-matrix/matrix.ts` — the axis manifest: the three frozen
  axis lists with per-cell sub-probe definitions, the cell-id slug function, and the
  `count >= 98` assertion, exported so tests and the sweep share one enumeration.
- `packages/platform/src/authz-matrix/derive.ts` — the independent expectation
  deriver: fixture logs → E2-T01 reduced view → frozen decision tables → sorted
  decision lines. Pure, no I/O beyond reading the fixture files, no HTTP. Exposed as
  `pnpm --filter @eforest/platform authz-matrix:derive`.
- `packages/platform/src/authz-matrix/sweep.ts` — the live executor: cold-start the
  E2-T02 emulator (pinned clock, committed seed) and the auth-enabled server against
  a fresh data dir, replay the fixture logs, mint each identity's token (including the
  expired one via clock pinning), execute every sub-probe over real HTTP, record
  head-offset + `ef replay --digest` digest before/after every deny, canonicalize, and
  emit the transcript. Exposed as `pnpm --filter @eforest/platform authz-matrix:sweep`.
- `packages/platform/fixtures/authz-matrix/` — `identity.jsonl`, `namespace.jsonl`
  (frozen event shapes only), `decisions.golden.txt`, `README.md` documenting the
  decision-line grammar, the derivation command, and the golden-regeneration rule.
- `packages/platform/test/authz-matrix.test.ts` — asserts: manifest cell count;
  derived lines equal golden bytes; sweep lines equal golden bytes; derivation and
  sweep agree line-by-line; every deny's digest pair byte-identical; layer-ordering
  spot rows literal-asserted (expired-token → 401 on all seven columns; non-member +
  private + stale fence → 404 not 409; revoked-grant → 403/404 with token still
  authenticating, never 401).
- Sensitivity machinery inside the target (not a separate manual step):
  `tools/verify/authz_matrix_sensitivity.sh` — in scratch copies/worktrees,
  (a) flip one membership event in `identity.jsonl` and assert the sweep goes red on
  exactly the derivation-predicted cell set (the deriver, run over the flipped log,
  names the expected blast radius; the sweep's red cells must equal it), (b) weaken
  one authorization check in a scratch worktree — the frozen mandatory minimum is
  making the private-read branch of E2-T07's decide path allow — committing per
  sabotage an expected-red-cell list derived from the frozen E2-T07 decision table
  (the cells whose golden decision routes through the weakened check) and asserting
  set equality against the observed red set, (c) corrupt one golden line and
  assert red. Transcripts land in `evidence/`.
- `Makefile`: `verify-E2-authz` (fixture replay, derive, sweep, byte-diff, neutrality
  assertions, sensitivity script) and `verify-E2-T10` as its alias; registration in
  the verify-all aggregate and the golden-sweep standing-verification inventory, per
  however E0-T02 froze that inventory's format.
- `evidence/` — the full 98-line (or larger) matrix transcript
  (`e2-t10-matrix.txt`), the derivation-vs-sweep agreement proof
  (`e2-t10-two-source.txt`), deny-neutrality digest pairs
  (`e2-t10-neutrality.txt`), the fork-column evidence (`e2-t10-fork.txt` — per fork
  sub-probe, both stream ids with landed offsets for allow cells and before/after
  digest pairs for both streams for deny cells; offsets live here, not in the
  canonical decision lines), sensitivity transcripts with predicted-vs-observed red
  cell sets (`e2-t10-sensitivity.md`), and the cold-clone run log
  (`e2-t10-cold-clone.txt`).

## Acceptance criteria

- [ ] `make verify-E2-authz` exits 0 from a cold clone via
      `tools/verify/cold_clone.sh` with scrubbed env, output containing zero
      `SKIPPED:` lines; run log committed to `evidence/e2-t10-cold-clone.txt`.
- [ ] Matrix completeness: the axis manifest enumerates exactly the seven identities,
      seven operation columns (with the sub-probes named in the Goal), and two
      visibilities; the harness asserts cell count ≥ 98 and the committed transcript
      `evidence/e2-t10-matrix.txt` contains one decision line per sub-probe, sorted by
      cell-id, with no cell absent.
- [ ] Golden byte-equality, two sources: the deriver's output and the live sweep's
      output are each byte-identical to `decisions.golden.txt` (`diff` exit 0 on raw
      bytes, both directions), proving the golden states policy derived from the
      fixture identity log — not a laundered server snapshot; proof committed to
      `evidence/e2-t10-two-source.txt`.
- [ ] Deny neutrality, universally: for every deny sub-probe in the matrix, the
      target stream's head offset and `ef replay --digest` dump digest are recorded
      immediately before and after and asserted byte-identical; pairs committed to
      `evidence/e2-t10-neutrality.txt`. Any deny that moved any log fails this
      criterion.
- [ ] Layer-ordering rows hold with literal assertions in the transcript:
      `expired-token` receives E2-T03's exact frozen 401 on all seven operation
      columns; `revoked-grant` receives 403/404 (per T07's table) with its token
      still authenticating — a 401 in any revoked-grant cell fails; non-member fenced
      append to the private repo is 404 `authz/not-found`, never a T09 409; the
      stale-own-fence sub-probe for a granted writer is T09's byte-frozen 409;
      `anonymous` read of the public repo is allowed on every read/tail sub-probe.
- [ ] Fork is decided on every touched stream: the fork column's allow cells cite the
      landed offsets on both the source-derived and newly minted branch streams, and
      its deny cells prove by digest that neither stream moved — a fork refused on
      the addressed stream but leaking a minted branch stream fails. This evidence
      lives in `evidence/e2-t10-fork.txt` — per fork sub-probe, both stream ids with
      their landed offsets (allow cells) or before/after digest pairs for BOTH
      streams (deny cells) — never in the canonical decision lines; the frozen
      grammar's ban on offsets in the transcript is unaffected.
- [ ] Sensitivity, event flip: flipping one membership event in the fixture identity
      log turns the sweep red on exactly the cell set the deriver predicts from the
      flipped log — the red set equals the predicted set, element for element; a red
      set that is smaller (missed cells) or larger (ununderstood blast radius) fails;
      transcript in `evidence/e2-t10-sensitivity.md`.
- [ ] Sensitivity, sabotage: with one authorization check weakened in a scratch
      worktree (script-driven inside `verify-E2-authz`), the sweep goes red at
      exactly the affected cells — where "affected" is mechanical, not judged: the
      script commits, per sabotage, an expected-red-cell list derived from the
      frozen E2-T07 decision table (the cells whose golden decision routes through
      the weakened check) and asserts set equality between that predicted set and
      the observed red set, element for element — the same predicted-vs-observed
      shape as the event-flip criterion. One sabotage is frozen as the mandatory
      minimum: the private-read branch of E2-T07's decide path made allow;
      additional sabotages are welcome but do not substitute for it. A matrix that
      stays green under sabotage refutes the apparatus and fails the target itself;
      transcript with both sets in `evidence/e2-t10-sensitivity.md`.
- [ ] Standing-gate registration: `verify-E2-authz` is invoked by the verify-all
      aggregate and listed in the golden-sweep standing-verification inventory;
      `verify-E2-T10` aliases it; both facts checkable by running the aggregate and
      grepping the inventory.
- [ ] Determinism: two consecutive `verify-E2-authz` runs from the same clone produce
      byte-identical transcripts, and the matrix executed with cell order shuffled
      (harness flag, seed printed) still produces the identical sorted transcript —
      cells are independent, not order-coupled.
- [ ] Zero policy changes: `git diff` for this task adds or modifies files only
      under `packages/platform/src/authz-matrix/`,
      `packages/platform/fixtures/authz-matrix/`, `packages/platform/test/`,
      `tools/verify/`, `evidence/`, and the Makefile verify recipes; any hunk
      elsewhere fails — in particular there is no diff under the server decision
      surfaces angle 8 audits (`authz/decide.ts`, the fencing module, the registry
      filter module, the bearer-verification module). `verify-E2-T03`, `verify-E2-T05`, `verify-E2-T07`, `verify-E2-T08`, and
      `verify-E2-T09` re-run green against this tree, and all root gates pass
      (`pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`).
- [ ] Replay (browser layer): N/A — no browser-reaching surface; declared explicitly
      per AGENTS.md, with the matrix transcript, two-source proof, neutrality digests,
      and sensitivity transcripts as the stream-layer evidence currency.

## Adversarial verification

The claim under attack: "every identity × operation × visibility cell is enumerated,
executed against a live server, and pinned to a golden derived from policy — and the
apparatus detects both a flipped identity event and a weakened check at exactly the
affected cells." This task ships an instrument, so the instrument is the primary
target: a conformance matrix that cannot go red is worse than no matrix. Use your own
flips, sabotages, and seeds throughout; invent at least one more angle.

1. **Audit the enumeration, not the count.** `count >= 98` can be satisfied by
   padding. Derive the cell set yourself from the dependency readmes: every door
   E2-T07's route inventory classifies as guarded must appear under some column's
   sub-probes (diff the inventory in `evidence/e2-t07-doors.txt` against the axis
   manifest), both live-tail transports must be present, all three registry doors,
   the snapshot-bootstrap read, both fenced sub-probes. Any guarded door reachable
   over HTTP that no sub-probe exercises refutes matrix completeness — name the door
   and demonstrate a decision the matrix never checks by flipping that door's
   behavior in a worktree and watching the sweep stay green.
2. **Golden-laundering attack.** The contract says the golden comes from the deriver,
   never from the sweep. Test it: delete `decisions.golden.txt`, regenerate via
   `authz-matrix:derive` with no server running, and byte-diff against the committed
   version — any difference means the committed golden was laundered from live output
   and the two-source proof is circular. Then attack the deriver itself: change one
   row of its embedded decision table in a worktree and confirm derive-vs-sweep
   disagreement turns the target red; if the harness "helpfully" regenerates the
   golden on mismatch, the entire gate is decorative — refuted.
3. **Canonicalizer over-scrubbing.** The scrubber is where drift goes to hide. Feed
   it adversarial material: run the sweep against a worktree where one deny's status
   is changed 404→403, another's `error.reason` is reworded, and a third returns the
   right status with a different body shape — each must surface as a byte diff. Then
   sabotage the scrubber to also scrub `status` and confirm the harness's own tests
   catch it (a scrub-list test must exist and fail). A canonicalizer that can eat a
   status change refutes every green run this target will ever produce.
4. **Blast-radius exactness, your own flips.** The builder proves one membership
   flip. Run your own campaign: flip the `grant.revoke` event's target grant, delete
   the org-admin role event, change the private repo's visibility event, retarget a
   branch grant to the sibling branch — for each, compute the expected red set with
   the deriver over your mutated log, run the sweep, and demand set equality. A sweep
   that goes red on *more* cells than predicted means nobody understands the policy
   join; *fewer* means cells are not actually re-decided per run. Either refutes.
5. **Identity forgery across the axes.** The matrix trusts its token minting. Cross
   the wires yourself: present the `revoked-grant` subject's token on the `member`
   cells' requests (the sweep should be structured so this is detectable — if cell
   execution takes a token parameter, misbind it in a worktree and the transcript
   must change), replay the `expired-token` cells with the emulator clock un-pinned
   so the token is fresh — the affected 401 rows must flip and the diff must go red.
   If the sweep passes with wrong tokens bound to cells, the identity axis is
   theater.
6. **Neutrality under the matrix's own load.** The sweep executes ~98+ probes against
   shared fixture streams. Verify deny neutrality end-to-end rather than per-probe:
   dump and replay every fixture-derived stream after a full sweep and assert the
   final digests equal the digests of the allow-cells' effects alone (reconstruct
   from the transcript's allow rows). Any deny that contributed a byte — even one the
   per-probe before/after pair missed due to interleaving — refutes neutrality and
   the pairing methodology both.
7. **Standing-gate reality check.** The title says "standing". Prove it can actually
   stand: run `verify-E2-authz` from a cold clone twice in a row (byte-identical
   transcripts), with the cell-order shuffle flag under three of your own seeds, and
   through the golden-sweep entry point rather than the Makefile directly. Then
   simulate the future regression it exists for: in a worktree, make a one-line
   router change that unguards a single read door and run only the *aggregate*
   (verify-all / the sweep inventory path) — if the aggregate stays green because the
   target was registered but not actually wired in, the registration criterion is
   refuted exactly where it matters.
8. **Zero-policy-change audit.** Diff this task's commits against the dependency
   packages' decision code (`authz/decide.ts`, fencing, registry filters, bearer
   verification). Any behavioral change smuggled in — even a "harmless" refusal-body
   tweak to make the golden stable — refutes the non-goal and taints the dependency
   tasks' verified statuses; the correct shape was a bug task against the owner.

Refutation currency: a guarded door absent from the axis manifest with a green sweep
over its flipped behavior, a byte index where derive and sweep (or golden and either)
differ without red, a scrubbed-away status change, a predicted-vs-observed red-set
mismatch with both sets listed, a deny cell whose digest pair differs, or an aggregate
run that stays green while a named cell is demonstrably wrong. "The sweep is slow" is
not a finding. No refutation → promote your nastiest flip campaign (angle 4) and your
misbound-token probe (angle 5) into the committed sensitivity script; the matrix is
now the floor every later epic re-earns.

## Verification log
