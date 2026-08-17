# E4-T11 browser evidence

Replay recording: https://app.replay.io/recording/d344ae81-29a4-4454-b585-24e1b04d6d40

The recorded Replay-Chromium session navigated the authenticated history view for the
seeded conflict branch and exercised the `sync/conflict` row. Replay MCP interrogation:

- `RecordingOverview`: 6.2s session at `/maple/reading-room/history/feature`; no console
  errors or warnings.
- `ConsoleMessages(summary)`: 0 messages.
- `UncaughtException`: none.
- `SearchSources("sync/conflict")`: the loaded route bundle executed the known-event
  branch and the humanized summary `preserved local conflict for docs/readme.md as
  docs/readme.md.conflict-...`.
- The five failed network requests are the expected aborted long-poll/history refresh
  requests already accounted for by the browser transcript (`expected-route-aborts=5`);
  no application exception was recorded.

The session was produced by the Replay Chromium history proof with the conflict event
seeded by the real stream-backed fixture, and the visible assertion required the
humanized conflict summary before the session completed.
