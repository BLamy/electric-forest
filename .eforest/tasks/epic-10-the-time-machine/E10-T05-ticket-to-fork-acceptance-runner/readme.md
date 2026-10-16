---
id: E10-T05
epic: 10
title: "Ticket-to-fork acceptance runner: record a declared app journey and its evidence"
priority: 1005
status: pending
depends_on: [E10-T04]
estimate: M
capstone: false
---

## Goal

`@eforest/application-fork` starts a declared acceptance journey from an authorized task ticket, resolves the ticket-bound application manifest, creates or selects its isolated fork, runs the declared browser journey under E10-T03 controls, and appends a traceable run record plus evidence references to the existing Electric Forest streams. The record binds the ticket, fork, manifest, build, Replay journey/recording, authoritative event offsets, and reducer digests without writing an authoritative side log.

## Context

E10-T01 through E10-T04 establish identity, isolation, controlled inputs, and paired evidence. This task makes that chain executable from a ticket so a developer can ask the platform to run the ticket's acceptance journey and receive one resolvable run artifact. A run record is a set of references to existing ticket, fork, browser, and app-state evidence; it does not assert that the acceptance criteria passed and cannot create a verdict.

The runner consumes a declared journey and its expected outcomes; it does not infer requirements from arbitrary ticket prose or broaden permissions. Ticket authorization, fork creation, app mutations, and evidence references use existing validated dispatch. Browser proof must use the configured Replay QA tunnel and named journey; stream evidence must independently replay to the recorded digests.

## Deliverables

- `ef app run <ticket-id> --idempotency-key <key>` as the single supported start command; `runId` is SHA-256 over the E10-T01 canonical JSON encoding of ticket id, ticket revision offset, manifest digest, journey digest, and idempotency key.
- A persisted run lifecycle with states `created`, `fork-ready`, `executing`, `evidence-recorded`, and terminal `completed`, `failed`, or `interrupted` states, plus exact restart behavior at each append boundary.
- A versioned run-record event/reference model joining ticket, fork, manifest/build, controlled effect ledger, paired Replay/rrweb evidence, and authoritative stream checkpoints.
- A named Replay QA journey for one representative ticket acceptance path and deterministic fixtures for success, missing journey, ticket mismatch, and interrupted run.
- `make verify-E10-T05` plus event-log dump, run-record references, and Replay QA/stream evidence under `evidence/`.

## Acceptance criteria

- [ ] `make verify-E10-T05` exits 0 from a cold clone; invoking the runner on the authorized fixture ticket produces one resolvable run record whose ticket, fork, manifest digest, build digest, Replay journey/recording, stream ids/offsets, and reducer digests match the independent source records in `evidence/e10-t05-run-record.jsonl`.
- [ ] The exact command `ef app run <ticket-id> --idempotency-key <key>` returns a `runId` matching the specified canonical SHA-256 derivation; repeating the same ticket revision, manifest, journey, and key returns the same run without creating another record, while a new key creates a distinct run.
- [ ] The named Replay QA journey completes through the configured managed tunnel, has zero console errors, and produces an attached recording URL; every authoritative state claim in its run record resolves to a fork event and replays to the cited digest.
- [ ] Missing ticket authorization, undeclared journey, stale manifest/build, or mismatched fork is rejected before any app-state append or successful run record; `evidence/e10-t05-refusals.jsonl` includes unchanged stream heads for each case.
- [ ] Fault injection at every persisted boundary has these exact outcomes: before `created`, retry creates one `created` record; after `created` or `fork-ready`, retry resumes the same run and does not create another fork; after `executing` but before `evidence-recorded`, restart records one terminal `interrupted` run and never reruns its side effects; after `evidence-recorded`, restart finalizes from the stored evidence without rerunning the journey; after a terminal state, retry returns that state. The boundary matrix records one run identity and exact event/head counts in `evidence/e10-t05-restart-matrix.jsonl`.
- [ ] A failed acceptance outcome is recorded with its evidence and failure status, not silently converted to a pass; no verdict or PR check is written by this task.
- [ ] Verification log cites Replay QA project, journey, test-run, and recording URL, plus the exact event-log paths/offsets/digests; local browser capture alone does not satisfy the claim.

## Adversarial verification

1. Start from a ticket whose manifest, journey, or authorization changes between resolution and execution. Any run that silently mixes revisions refutes ticket binding.
2. Submit duplicate start requests, kill the runner after each append boundary, and resume. Duplicate terminal run records, lost references, or a falsely successful partial run refutes lifecycle integrity.
3. Make the browser journey pass while the fork reducer digest is wrong, then make stream state pass while the browser journey is failed. The run record must preserve the distinct outcomes; any implicit conjunction or substitution refutes evidence pairing.
4. Give the caller read-only access or a ticket for another project and attempt a run. Any fork creation, app mutation, or successful record without validated authorization refutes the security boundary.
5. Change one run-record reference and independently resolve all joins from cold stream dumps. If the resolver still reports a complete successful run, cross-link validation is refuted.

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
