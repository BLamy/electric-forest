---
id: E10-T06
epic: 10
title: "Independent fork-run verdict: fresh critic binds acceptance findings to exact evidence"
priority: 1006
status: pending
depends_on: [E10-T05]
estimate: M
capstone: false
---

## Goal

`@eforest/application-fork` accepts a verdict only from a fresh critic session distinct from the builder and runner sessions, after the critic checks the ticket criteria, candidate manifest/build, paired Replay and stream evidence, evidence freshness, and changed-code coverage. It appends an immutable verdict event bound to the exact run/evidence digests; missing, mismatched, stale, or unexercised required behavior yields a non-passing verdict and cannot mark the ticket verified.

## Context

The whitepaper's “independent verdict” maps to Electric Forest's existing builder/critic proof doctrine. The verdict is not a model-generated label trusted by name: the server derives critic principal, session id, and role from authenticated request context, and records those identities alongside the evidence inspected, per-criterion findings, changed-code coverage dispositions, and digest of the exact run package. The submitted payload cannot choose or override those identities. Existing task status transitions remain controlled by the platform's task state machine; this task does not make the verdict session an alternate status writer.

Changed-code coverage is computed from the source revision/tree digest in the run manifest to the exact candidate revision/tree digest. Its canonical diff sorts file paths by UTF-8 bytes and records each path's old/new blob digest plus every unified-diff hunk's old/new start/count and content digest. Every behavior-changing range must map to a named acceptance journey step and evidence reference. A waiver is allowed only for documentation-only files, generated lockfile metadata with an unchanged resolved dependency graph, or comment/format-only source hunks whose normalized AST tokens are identical; each waiver needs a typed reason and proof artifact. Freshness uses a compare-at-append fence: the validated dispatch command re-resolves the candidate, ticket criteria, fork head, and evidence version vector and appends a passing verdict only if the fingerprint still equals the inspected snapshot. The critic can inspect and append a verdict but cannot mutate the candidate or rewrite builder evidence.

## Deliverables

- Versioned critic verdict event/schema and verifier in `packages/application-fork`, with server-derived critic principal/session/role, ticket/run/evidence digest, criterion outcomes, findings, canonical source diff coverage mapping, and compare-at-append freshness fence.
- Server-side identity and authorization checks proving the critic principal and session differ from the builder and runner, and rejecting caller-supplied identity fields.
- Positive and negative verdict fixtures for fulfilled criteria, missing criteria evidence, stale build/fork, role reuse, and unexercised changed code.
- `make verify-E10-T06` with verdict-stream dumps, exact evidence digest, and adversarial refusal transcript under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E10-T06` exits 0 from a cold clone; a fresh critic session records one verdict whose run id, ticket id, manifest/build digest, fork head, Replay recording reference, stream offsets/digests, and evidence digest independently resolve to E10-T05 records in `evidence/e10-t06-verdict-ledger.jsonl`.
- [ ] The verdict records principal/session/role from authenticated server context; caller-supplied identities are ignored or refused, and the resolved critic principal/session differ from both builder and runner identities in the run record.
- [ ] Every ticket criterion has exactly one explicit pass/fail finding with an evidence reference. The source diff names base and candidate revisions/tree digests and enumerates every changed file/blob/hunk; every behavior-changing hunk maps to an executed journey step and evidence reference. A waiver passes only for the three declared non-behavioral classes with a typed reason and proof artifact; any other unexercised hunk makes the verdict non-passing.
- [ ] Reusing the builder or runner session, using an unauthorized critic, or submitting against changed ticket criteria/build/fork/evidence is refused as an independent current verdict; a stale compare-at-append fingerprint returns `STALE_VERDICT_FENCE` and appends no passing verdict event.
- [ ] Tampering with one referenced event, Replay identity, reducer digest, freshness head, or verdict evidence digest makes verification fail at the named reference; `evidence/e10-t06-tamper-results.jsonl` records mismatch and observed verdict state.
- [ ] Verdict append is authorized through the existing validated mutation door, and the persisted event is replayable from a cold dump to the same verdict digest; no direct task-status mutation occurs in this package.
- [ ] Verification log declares Replay evidence as the cited E10-T05 recording interrogated by the critic, and lists the Replay QA project/test-run/recording plus the verdict and stream-ledger references.

## Adversarial verification

1. Have the builder session submit its own passing verdict, have the runner session submit it, forge principal/session/role fields in a fresh caller payload, and have an unauthorized principal submit it. Every attempt must be refused or bound only to the server-derived caller and cannot produce a passing verdict event.
2. Change ticket criteria, candidate build, fork head, or one referenced offset after review but before verdict append. If the dispatch validator fails to re-resolve the exact version vector at append time, or a passing verdict is appended on a stale fence, freshness enforcement is refuted.
3. Leave one behavior-changing diff hunk unexecuted while all stated acceptance criteria appear to pass, then attempt to waive it as documentation-only. The independent critic must mark the verdict non-passing; any accepted behavior waiver refutes coverage enforcement.
4. Replace the Replay recording with another run and separately alter a state digest while retaining the evidence digest. Any passing verdict refutes exact evidence binding.
5. Replay the verdict ledger from offset `-1`, then flip one byte in each linked evidence reference. If the original verdict digest still verifies, the apparatus is insensitive and the verdict claim is refuted.

## Roadmap alignment — 2026-10-16

This later application-history capability builds on the already-hosted Forest, E15 provider
decisions and E14 source model. Every fork/build/run/verdict/check manifest binds source
changeset ID and complete file-version/content-manifest hash alongside branch/offset, tree,
artifact and authoritative state boundaries. A changed changeset, file-version manifest or
blob identity invalidates dependent evidence. Persist endpoint manifests, hashes and
citations; textual comparisons remain transient except within redacted agent logs.

Browser claims use named Replay QA journeys in `proj-electric-forest-ms8w0nv1` through the
configured managed tunnel; an epic capstone also requires the integrated exploration. Earlier
recording references mean recordings attached to those runs, never a direct local browser
recording substituted as final proof. Cite project/journey/test-run/exploration IDs and paired
stream/object digests. Any fallback follows AGENTS.md and cannot waive a stricter task
requirement.

Generated comparison scenes follow E14-T05's recording masks; do not persist derived
patch text in QA or Playwright evidence outside agent logs.

## Verification log
