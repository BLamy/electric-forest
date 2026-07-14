---
id: E6-T06
epic: 6
title: "Live task board: queue, project state, task folders, findings, and evidence in the web app"
priority: 606
status: pending
depends_on: [E6-T03, E6-T04, E6-T05]
estimate: L
capstone: false
---

## Goal

`packages/webapp` renders the stream-derived `.eforest` product: a project task board
ordered by the E6 queue projection, a task detail page for readme sections and attempt
history, live project-state controls, refutation findings, and E5 evidence attachments.
Every surface tails live without reload and exposes its source head offset and canonical
digest in the DOM.

## Context

The task board is the first visible proof that `.eforest` is not server-local tooling.
It composes existing E3 live hooks and E5 evidence components; it does not invent a REST
cache or client-only status. All displayed statuses, blocked reasons, attempt counts, and
attachments name the reducer/derived stream they came from.

Human controls may pause/resume a project through E6-T03's dispatch door. Agent lifecycle
controls land later; this task renders placeholders only for run references already
present in task events. Accessibility and error/removal paths are browser-reaching and
therefore require one Replay walkthrough.

## Deliverables

- `packages/webapp/src/routes/TaskBoard.tsx`, `TaskDetail.tsx`, and project-state control
  integration in the project page.
- `packages/webapp/src/tasks/useTaskQueue.ts`, `useTask.ts`, and reusable task timeline /
  finding / folder-section components.
- DOM contracts `data-stream-offset`, `data-state-digest`, `data-task-status`, and
  `data-project-status` on the relevant live regions.
- Playwright two-session tests for creation, status/refutation/evidence updates, ordering,
  pause/resume, attachment removal, and error states.
- `Makefile` target `verify-E6-T06` plus Replay recording `e6-t06-final`.

## Acceptance criteria

- [ ] `make verify-E6-T06` exits 0 cold with zero skips, zero browser console errors, and
      all root gates green; the Verification log cites an uploaded Replay recording.
- [ ] Browser A holds the task board open while independent client B dispatches task
      creation, start, claim, refutation, rework, and evidence events; A renders each
      ordered change without reload/navigation and its DOM offset reaches the returned
      event/queue head within the committed liveness bound.
- [ ] At final quiescence the board's DOM queue digest and every open task detail's DOM
      digest byte-equal values recomputed by `ef replay` in a separate process.
- [ ] Blocked dependencies, the sole eligible task, in-flight state, attempt count, and
      refutation finding text/citation exactly match the E6-T04 projection and E6-T01
      task state; no browser code recomputes eligibility.
- [ ] Every E5 evidence kind (content-backed log/digest/rr trace and external Replay
      reference) renders on task detail with hash/type/owner, valid links resolve, and a
      removed reference disappears live without deleting shared content.
- [ ] Pause and human resume controls append E6-T03 events, update both sessions live,
      and surface frozen refusal copy when an unauthorized identity or stale offset acts;
      refused actions leave the DOM digest and server head unchanged.
- [ ] Keyboard-only navigation reaches board columns, task rows, project controls,
      findings, and evidence links with semantic roles/names; the automated accessibility
      scan reports zero serious/critical violations.

## Adversarial verification

1. Interrogate the Replay recording around each live update: look for document
   navigations, polling reloads, console errors, and DOM offsets that jump without a
   matching network/event tail. Any one refutes live rendering.
2. Reorder and delay task/queue responses. A transient impossible status, priority order
   computed from stale task state, or digest exposed for a different offset refutes
   hydration fencing.
3. Dispatch an attachment removal and project pause from a second identity while links
   are focused. Stale evidence, broken focus, or a control that still launches work
   refutes the UI contract.
4. Mutate one server-side task status while freezing the client digest/offset exposure.
   Playwright must fail exact parity; a green run refutes the second instrument.
5. Search bundles/source for hard-coded task fixtures, client eligibility reducers, and
   localStorage authority. Any displayed truth not sourced from streams refutes.

## Verification log
