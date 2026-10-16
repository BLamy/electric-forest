---
id: E14-T02
epic: 14
title: "Store authenticated complete content objects once on official Durable Streams"
priority: 552
status: pending
depends_on: [E14-T01]
estimate: L
capstone: false
---

## Goal

`ContentObjectStore` in `@eforest/changesets` stores and retrieves complete byte-exact
`ContentObjectV1` values at repo-scoped content addresses on official Durable Streams.
One accepted immutable object record contains the full bytes and verified sealed
completion; repeated matching uploads resolve to that object, and incomplete or
mismatched objects can never be referenced as valid source versions. An authenticated
platform adapter enforces the existing namespace/capability boundary on writes and reads.

## Context

This is a storage/authorization module with real upstream-server integration fixtures.
E14-T03 mounts the new publication path in the product; this task does not change an
existing browser route. It must not add a direct client write path. Every product
object write will use the authenticated dispatch adapter, with trusted direct official
client calls restricted to library/reference-server tests.

Use the existing official `@durable-streams/client`/server substrate, canonical hashing
and namespace/auth helpers. The single-write object envelope's digest and size are
recomputed from full decoded bytes before its accepted completion; a transport success
alone is not a valid seal. A truncated request may leave no accepted object or an
unreferencable abandoned attempt, never apparently valid partial content. No second
transport, filesystem blob authority, database or external object store is introduced.
E5 evidence chunk/seal v1 histories stay frozen; share helpers where compatible rather
than changing the evidence schema to fit source objects.

Objects are immutable after acceptance, including administrative adapters. Equal bytes
within the same scope may reuse an object; cross-repo knowledge of a digest grants no
read, existence oracle, follow or write capability. No garbage collection or compaction
of source objects is added in this task.

The no-diff rule classifies artifact roles, not source byte patterns: an ordinary
full source file (including a `.patch` fixture) remains permitted. New generated patch
operations/comparison bodies are forbidden outside redacted agent logs. Recorded
comparison scenes mask generated text and derived payloads before any QA timeline,
screenshot, console/network body, Playwright trace/snapshot artifact or attached recording persists them. Keep immutable
endpoint IDs, comparison-result digests and UI state so the critic can independently
recompute expected comparisons. Qualify masking with a canary before upload; unsupported
masking is an evidence blocker or the literal AGENTS.md fallback, never a silent waiver.

## Deliverables

- `packages/changesets/src/objects.ts` with `putContentObject`,
  `readContentObject` and seal verification against the E14-T01 contract.
- Pure object reducer/validators and a platform dispatch/read authorization adapter
  under `packages/platform/src/changesets/`, prepared for E14-T03 registration.
- Real published-server tests for empty/text/binary objects, deduplication races,
  malformed envelopes, truncation, post-seal mutation and permission revocation.
- `tools/verify/content_objects.sh`, proposed `make verify-E14-T02`, and object dumps,
  request traces, scope refusals and independently computed byte hashes in `evidence/`.
- A no-side-storage/dependency audit and legacy evidence-format regression check.

## Acceptance criteria

- [ ] `make verify-E14-T02` exits 0 cold against the pinned published official server
      with a fresh data directory and zero skipped cases; `_v-official-streamfs`
      remains green. Server/client pins and executed commands are recorded in
      `evidence/object-server.json`.
- [ ] Empty, Unicode/CRLF, binary and boundary-sized objects round-trip byte-for-byte.
      An independent hash tool matches each canonical address, declared size and
      reducer-computed seal in `evidence/object-byte-parity.json` and the cited dumps.
- [ ] Repeating a matching upload, losing its success response, and racing two matching
      uploads produce one logical accepted object at the canonical address and the
      same returned reference. Changed bytes under that address, post-seal append,
      replacement and deletion attempts are refused; before/after dumps and hashes
      are identical in `evidence/object-idempotency.json`.
- [ ] Wrong hash/size/encoding, a truncated upload and a forged completion are refused
      or remain explicitly unsealed. `readContentObject` never returns them as complete,
      and publication validation rejects them; typed outcomes and unchanged accepted
      object state are in `evidence/incomplete-object-refusals.json`.
- [ ] The actual adapter token is checked for upload, read and follow. Anonymous,
      sibling-repo, revoked and expired capabilities cannot retrieve bytes or learn
      existence beyond the existing authorization response contract. Allowed/denied
      requests and log-neutral refusals are in `evidence/object-scope-matrix.json`.
- [ ] After deleting disposable caches and agent logs and restarting the platform
      adapter, existing sealed objects remain readable solely from official streams.
      Exact byte hashes match pre-restart values in `evidence/cold-object-read.json`;
      source object code adds no authoritative local/SQL/blob store.
- [ ] A digest-check bypass and a post-seal-write bypass each turn the verify target
      red in separate scratch variants. The claim declares `Replay: N/A (internal
      object-store and authorization adapter; product registration is E14-T03) +
      mitigation` with real-server dumps, scope refusals and cold byte-parity evidence.
      Any added product browser integration instead requires named Replay QA journeys
      and visible DOM object identity under AGENTS.md.

## Adversarial verification

1. Hash your own binary bytes, upload them, drop the response and retry. Duplicate
   accepted objects, changed bytes or a reference that resolves only from a warm cache
   refutes idempotency/independent readability.
2. Interrupt the request at multiple byte boundaries and forge a seal for its prefix.
   Any complete object or publishable reference with the intended full address refutes
   atomic object completion.
3. Send actual dispatches to append/overwrite/delete an accepted object, including an
   administrative capability. Any change in accepted bytes refutes immutability.
4. Guess an existing sibling-tenant digest and compare forbidden reads/follows with a
   nonexistent object. Extra bytes or an existence distinction forbidden by the E2
   response contract refutes scope enforcement.
5. Strip all local caches/logs and restart with only official streams. Missing content
   reveals side authority and refutes the storage model.
6. Disable hashing and seal validation separately, mutate one object byte and run the
   permanent target. Green acceptance refutes measurement sensitivity.

## Verification log
