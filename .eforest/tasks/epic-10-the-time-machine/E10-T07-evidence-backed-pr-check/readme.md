---
id: E10-T07
epic: 10
title: "Evidence-backed PR check: require a current independent verdict for the exact candidate"
priority: 1007
status: pending
depends_on: [E10-T06]
estimate: M
capstone: false
---

## Goal

The platform's `evidence-backed-app-check` reports pass only when a current independent E10-T06 verdict resolves to the exact ticket, PR, fork, candidate build, manifest, and paired evidence being checked. An authorized evaluation appends a durable check event on the check-event stream whether it passes or fails; missing, stale, mismatched, unsupported, or refuted evidence produces a non-passing result while candidate PR, branch, and app-state heads stay unchanged. An unauthorized attempt is refused before any check event is appended. All writes remain authenticated and validated through the existing platform dispatch door.

## Context

This task connects the verified fork-run chain to the existing PR/check model. It consumes verdicts and evidence references; it does not rerun tests, treat a Replay recording as authoritative app state, create a verdict, or merge the PR. The check is a gate over exact candidate identity, not a mutable “green” field that can outlive the evidence it represents.

The whitepaper's vertical slice ends at an evidence-backed PR check. Deployments, incident workflows, model-training data pipelines, and broad application hosting are later roadmap work and are not required for this ticket. Existing PR authorization, branch-head, and mutation rules remain in force.

## Deliverables

- Versioned PR check event/schema and evaluator in `packages/platform` or the existing PR-check package, consuming the E10-T06 verdict and evidence digest.
- Exact candidate comparison for PR/ticket/fork/manifest/build/evidence identities, plus stable refusal reasons for absent, stale, mismatched, unsupported, and refuted inputs.
- Pass/refusal fixtures covering the candidate matrix, replayable check-event logs, and a named app journey if the check result is surfaced in the web UI.
- `make verify-E10-T07` with check events, before/after PR and branch heads, and evidence resolution ledger under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E10-T07` exits 0 from a cold clone; a valid current verdict for the exact PR candidate appends a passing check event whose references resolve to the E10-T06 verdict, ticket, fork, manifest/build digest, Replay/stream evidence, and candidate head in `evidence/e10-t07-check-ledger.jsonl`.
- [ ] Authorized missing, stale, mismatched, unsupported, and refuted verdict/evidence evaluations each append a named non-passing result to the check-event stream and never append a passing check; unauthorized attempts append no check event. `evidence/e10-t07-refusal-matrix.jsonl` contains all five authorized outcomes plus the unauthorized case.
- [ ] For every non-passing or unauthorized attempt, before/after candidate PR head, branch head, and app-state stream heads are identical. Authorized evaluations advance only the check-event stream by exactly one event; unauthorized attempts leave that stream unchanged. `evidence/e10-t07-unchanged-heads.jsonl` records all heads separately.
- [ ] A check result is invalidated when its candidate build, fork head, ticket criteria, or evidence digest changes; rechecking requires a new independent verdict bound to the changed candidate.
- [ ] Check events replay from a cold dump to the recorded digest and can be recomputed without trusting a cached boolean; one-byte mutation of the verdict/evidence reference makes verification non-passing.
- [ ] Browser evidence is `Replay: N/A (server-side PR gate only) + mitigation: cold-clone valid/refusal matrix, replayed check-event digests, and before/after head-equality transcript`, unless a result surface is added; if browser-visible, a configured Replay QA journey covers pass and refusal states with zero console errors.

## Adversarial verification

1. Submit a passing verdict from another PR, ticket, branch, fork, build, or project. Any green check refutes candidate binding.
2. Change one evidence offset or digest after the verdict and attempt the check again. A cached green boolean or a pass against stale evidence refutes freshness.
3. Use a refuted verdict, unsupported verdict version, absent evidence, expired Replay reference, and unknown stream reducer separately. Any pass refutes fail-closed behavior.
4. Attempt each invalid check as an unauthorized principal, then compare PR, branch, app-state, and check-event stream heads. Any event append by an unauthorized principal, candidate/app-state movement, or observable unauthorized reference leak refutes the stated boundary.
5. Plant a direct check-state write that bypasses validated dispatch or mutate a cached pass flag while preserving the old check event. If the independent replay/verifier still reports pass, the check gate is refuted.

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
