---
id: E2-T09
epic: 2
title: "Writer-scoped application fencing above global Stream-Seq ordering"
priority: 209
status: pending
depends_on: [E2-T07]
estimate: M
capstone: false
---

## Goal

Authenticated writers get independent application sequence lanes without changing
Electric's `Stream-Seq` semantics. Each dispatched event carries a server-stamped
writer subject and monotonically increasing writer sequence. The platform replays the
stream to validate that lane, then appends through the official client using the one
global lexicographic `Stream-Seq` required by Durable Streams.

Two users can therefore interleave valid writes without fencing each other out. A stale
sequence from the same user is refused before append. Concurrent races are resolved by
the official global append fence; a loser replays and retries only if its application
precondition still holds.

## Deliverables

- Versioned writer-lane fields in the application event envelope.
- A pure writer-lane reducer and typed stale-writer refusal.
- Dispatch coordination that combines application-lane validation with official
  `Stream-Seq` compare-and-append.
- Deterministic two-writer and same-writer race fixtures.
- Golden event logs proving per-writer monotonicity and global total order.

## Acceptance criteria

- [ ] Independent writers can interleave sequences `1, 1, 2, 2` while the transport
      receives one globally increasing `Stream-Seq`.
- [ ] Repeating or decreasing one writer's application sequence is refused and appends
      nothing.
- [ ] In a same-base concurrent race exactly one global append wins; retry cannot bypass
      StreamFS or reducer preconditions.
- [ ] Actor and writer sequence are stamped/validated by the platform, never trusted from
      an arbitrary payload.
- [ ] No code changes the published server, invents identity-scoped transport headers,
      or maintains a second stream store.
- [ ] `make verify-E2-T09` passes with seeded race schedules.

## Adversarial verification

1. Interleave three subjects with duplicate and out-of-order lane sequences.
2. Race two requests from one subject and two from different subjects at the same global
   head; classify every outcome by application and transport fence.
3. Forge another subject in the event body; any accepted actor mismatch refutes the task.
4. Search for per-identity state in the Durable Streams launcher/server boundary.

## Verification log

(appended by builder and critic)
