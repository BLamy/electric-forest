---
id: E7-T04
epic: 7
title: "Live session feed: tool, file, and task activity streaming into the project page"
priority: 704
status: pending
depends_on: [E7-T03]
estimate: M
capstone: false
---

## Goal

`@eforest/webapp` adds `/orgs/:org/repos/:repo/activity` and an embeddable
`LiveSessionFeed` on the project page. It hydrates and tails the branch activity stream
through `useStreamReducer`, groups items by agent session, and renders lifecycle,
tool-call status, file patch summaries, and task transitions. Each row exposes its
activity offset, source stream/offset, session sequence, and source digest in stable
DOM attributes; selecting a file row navigates to the live file view at that source
event. New rows appear without reload and connection loss resumes from the last cursor.

## Context

The feed is an evidence viewer over E7-T03 references, not an alternate transcript or
polling API. Payload detail is fetched from the authorized source stream; redacted tool
summaries remain redacted. The branch selector controls the activity stream being
tailed, and switching branches tears down the old tail before hydrating the new one.

## Deliverables

- `packages/webapp/src/activity/LiveSessionFeed.tsx`, row renderers, source resolver,
  and branch-aware `useActivityFeed` binding.
- Activity route and project-page panel with loading, live, reconnecting, ended, empty,
  denied-source, and malformed-reference states.
- `packages/webapp/test/activity-feed.spec.ts` using two browser contexts and a foreign
  writer, asserting DOM/source parity, navigation, reconnect, and zero console errors.
- `make verify-E7-T04` and Replay recording support with DOM snapshots and network logs
  committed under the task's evidence folder.

## Acceptance criteria

- [ ] `make verify-E7-T04` exits 0 from a cold clone with zero skips and all root gates
      green.
- [ ] A scripted session dispatches each frozen activity kind; the open feed renders
      one row per activity ref in offset order without reload, and every DOM source
      tuple resolves to the exact independently fetched event and digest.
- [ ] The feed's DOM activity offset/digest equals the activity stream head after
      quiescence and equals an independent `ef replay` of its dump.
- [ ] Hard-sever the SSE connection mid-session, append events, and reconnect: the feed
      resumes from its last cursor with no missing/duplicate rows and no full-page
      navigation; the network transcript proves no polling/reload substitute.
- [ ] Switching branches shows only the selected branch's items and leaves zero active
      requests for the previous branch after teardown.
- [ ] Denied source details remain a labeled redacted row without leaking payload,
      stream content, or digest beyond what the authorized activity response permits.
- [ ] Playwright and the cited Replay recording show zero console errors and include a
      tool start/finish, incremental file rows, task transition, disconnect, and resume;
      fallback is declared per AGENTS.md only if Replay preflight fails.

## Adversarial verification

1. Write your own interleaved two-session activity and compare DOM tuples to the raw
   activity log and each source log. Any reorder, duplicate, or invented row refutes.
2. Drop the tail at every event boundary and append while disconnected. Any final set
   difference or post-reconnect reload refutes live resume.
3. Change branch repeatedly while writers remain active. A late row from the old branch
   or leaked network request refutes isolation.
4. Revoke source authorization between ref arrival and detail fetch. Any protected
   payload rendered or cached after revocation refutes access control.
5. Freeze the DOM offset or render fixtures instead of the tail in a scratch worktree;
   `verify-E7-T04` must go red under both sabotages.
6. Interrogate the Replay recording's network and console timelines. A missing claimed
   scene, polling loop, console exception, or source tuple inconsistent with the point
   refutes browser evidence.

## Verification log
