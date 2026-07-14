---
id: E7-T05
epic: 7
title: "Live file patch view: incremental AI edits rendered in the open file without reload"
priority: 705
status: pending
depends_on: [E7-T02]
estimate: M
capstone: false
---

## Goal

The existing web file viewer consumes E7-T02's incremental stream-fs patch events and
updates the open file after every patch, not only after tool completion. It preserves
the active scroll/selection when possible, marks changed line ranges with a transient
firefly highlight, and exposes `{ contentStream, contentOffset, contentDigest,
sessionStream, sessionSeq }` in the DOM atomically. A user can follow live or pin a
specific offset; pinned views never advance until explicitly returned to live.

## Context

E3 built patch-aware file rendering and `useStreamReducer`; this task specializes it for
high-frequency agent writes. Highlighting is presentation only—the rendered bytes and
digest come from replaying the content stream. The reducer must batch React paint work
without dropping intermediate offsets from the activity trail. Binary files keep the
existing binary viewer and show one whole-write activity, not fabricated text patches.

## Deliverables

- `packages/webapp/src/files/LiveFileView.tsx` and `useLiveFileContent` with follow/pin
  modes, atomic DOM provenance, stable selection, and accessible change announcements.
- A bounded highlight scheduler with `prefers-reduced-motion` support; motion never
  affects correctness or digest calculation.
- Playwright coverage for rapid inserts/deletes, unicode, rename/delete, branch switch,
  pin/unpin, reconnect, reduced motion, and zero console errors.
- `make verify-E7-T05`, Replay recording, content dumps, sampled DOM pairs, and final
  digest evidence.

## Acceptance criteria

- [ ] `make verify-E7-T05` exits 0 from a cold clone with zero skips and all workspace
      gates green.
- [ ] During at least 20 incremental patches, Playwright samples every distinct content
      offset in the activity trail; each rendered text/digest pair equals independent
      replay of the content log truncated at that offset.
- [ ] No document reload or application projection bootstrap re-fetch occurs after hydration during a recoverable
      live tail; sever/reconnect converges to head with no skipped patch.
- [ ] Pinning an interior offset keeps bytes, offset, and digest unchanged while at least
      five new patches land; returning live advances atomically to head and matches
      independent replay.
- [ ] Rename follows the file identity to its new path; delete renders the tombstone
      state. Neither path shows stale bytes from an unrelated file.
- [ ] Reduced-motion mode disables animated highlights but retains visible non-motion
      change indication and identical state/digest behavior.
- [ ] The final Replay recording contains the incremental edits, pin/unpin, and an error
      or deletion path with zero console errors; URL is cited or fallback is declared
      exactly per AGENTS.md.

## Adversarial verification

1. Dispatch your own rapid unicode patches and sample the DOM after each source offset.
   Any pair not equal to truncated replay refutes correctness.
2. Pin at random interior offsets while writes continue. Any pinned advance, mixed
   offset/digest pair, or wrong catch-up on unpin refutes mode isolation.
3. Rename, delete, and recreate the same path with a new file identity. Stale content or
   following the path instead of identity refutes file tracking.
4. Block application projection bootstrap after hydration and repeatedly sever SSE. Failure to recover from
   events alone, or any hidden reload/polling cheat, refutes live replay.
5. Sabotage the client to drop one patch, double-apply one patch, and freeze the digest.
   Each mutation must turn the verify target red at the precise source offset.
6. Inspect the recording for every claimed visual/error scene and evaluate the DOM
   provenance at those points. A screenshot-only claim without matching state refutes.

## Verification log
