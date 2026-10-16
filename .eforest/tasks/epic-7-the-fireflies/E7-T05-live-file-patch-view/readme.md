---
id: E7-T05
epic: 7
title: "Live version view: immutable saved files and transient change highlights"
priority: 705
status: pending
depends_on: [E7-T02]
estimate: M
capstone: false
---

## Goal

The existing file viewer follows E7-T02's accepted E14 file versions without reload.
It fetches verified complete content objects, derives transient change highlights from
adjacent versions, and exposes `{ changesetId, fileVersionId, contentDigest, branchOffset,
sessionStream, sessionSeq }` atomically in the DOM. Users can pin a historical version
or return to live; viewing a comparison never persists textual patch bodies.

## Context

E3's verified patch-era reader remains legacy compatibility. New saves use immutable
versions and changesets. Intermediate source offsets remain in the activity trail even
when React batches paint work. Objects are immutable but every fetch remains authorized;
a hash is not an access token. Renames follow logical identity and deletes show a tombstone.

## Deliverables

- `apps/web/src/files/LiveFileView.tsx` and typed follow/pin hooks over E14 version refs.
- Memory-only comparison/highlight scheduling with reduced-motion support and keyboard
  announcements; no durable diff cache or comparison attachment.
- Playwright cases for 20 saved versions, binary, rename/delete/recreate, branch/account
  change, missing/corrupt objects, pin/unpin, reconnect and zero console errors.
- `make verify-E7-T05`, named Replay QA journey, complete content objects, source manifests
  and sampled DOM/version/digest evidence.

## Acceptance criteria

- [ ] The verify target exits 0 cold with zero skips and ordered root gates green.
- [ ] Across at least 20 saved versions, every activity reference resolves to its exact
      immutable object. For each version rendered, text/bytes, digest and DOM identities
      equal independent source replay and SHA-256 of the full bytes.
- [ ] Pinning an interior version keeps bytes and identities unchanged while at least
      five saves land; return-to-live reaches the current head atomically without reload.
- [ ] Reconnect resumes from the source cursor without skipped activity or a whole
      application bootstrap refetch. Fetching missing immutable full content objects is
      allowed and verified; it is not a whole-state reload workaround.
- [ ] Rename/delete/recreate, branch/account change and revoked access never show stale
      bytes from a different identity/scope. Missing or corrupt objects produce a typed
      failure rather than falling back to unrelated contents.
- [ ] Binary files use their binary presentation. Reduced-motion disables animation but
      preserves visible change indication and identical provenance/digest behavior.
- [ ] The configured Replay QA journey/test run covers edits, pin/unpin, reconnect,
      deletion/refusal and keyboard use with zero console errors. Recorded DOM tuples
      equal committed independent stream/object evidence; fallback follows AGENTS.md.
- [ ] Durable output inspection finds no newly stored patch bodies outside redacted
      agent logs, including review caches and evidence attachments.

## Adversarial verification

1. Delay and reorder object fetches while advancing branch/account. Any mixed
   changeset/content/offset tuple or cross-scope bytes refute atomic rendering.
2. Pin random interior versions during live saves, then revoke access. A pinned advance
   or unauthorized fetch refutes mode/auth isolation.
3. Rename, delete and recreate the same path with a new identity. Following stale bytes
   by path alone refutes identity tracking.
4. Corrupt one content byte, drop one version and freeze the DOM digest in separate
   scratch candidates. Each mutation must fail independent replay/hash checks.
5. Inspect the cited QA run against every changed browser behavior; missing error,
   binary or reconnect scenes require evidence, not a different critic rerun.

## Roadmap alignment — 2026-10-16

This task runs after the hosted loop and E14 source transition. Accepted source changes are
complete immutable versions linked to changesets; fine-grained edit/patch text belongs only in
redacted agent logs. Activity and historical views reference actual changeset, version and
source-offset identities; transient highlights are computed from full versions. No new
branch/content/projection/evidence artifact may persist textual patch bodies. Legacy verified
streams/evidence remain unchanged.

Browser claims use named Replay QA journeys in `proj-electric-forest-ms8w0nv1` through the
configured managed tunnel; an epic capstone also requires the integrated exploration. Earlier
recording references mean recordings attached to those runs, never a direct local browser
recording substituted as final proof. Cite project/journey/test-run/exploration IDs and paired
stream/object digests. Any fallback follows AGENTS.md and cannot waive a stricter task
requirement.

Generated comparison scenes follow E14-T05's recording masks; do not persist derived
patch text in QA or Playwright evidence outside agent logs.

## Verification log
