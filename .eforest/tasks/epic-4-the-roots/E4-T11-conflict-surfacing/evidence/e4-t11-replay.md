# E4-T11 browser evidence

Replay recording: https://app.replay.io/recording/a1fb4942-83ee-4ec1-8ddb-c95046c7ef1b

The recorded Replay-Chromium session navigated the authenticated history view for the
  seeded conflict branch and exercised the `sync/conflict` row for `base.txt` at the
  winning offset `0000000000000000_0000000000000002`. Replay MCP interrogation:

- `RecordingOverview`: 6.2s session at `/maple/reading-room/history/feature`; no console
  errors or warnings.
- `ConsoleMessages(summary)`: 0 messages.
- `UncaughtException`: none.
- `SearchSources("sync/conflict|preserved local conflict|base.txt.conflict")`: the loaded
  route bundle has an executed hit at `route-pages-BzDjLokQ.js:2026-2027`, including the
  `sync/conflict` branch and the humanized summary
  `preserved local conflict for base.txt as base.txt.conflict-0000000000000000_0000000000000002`.
- The browser assertion reached the rendered row after the conflict event; the recorded
  route's event-offset marker was at or past the winning offset.
- `NetworkRequest(summary)` reports 48 requests, 0 HTTP failures, and 7 requests without a
  response (the expected aborted long-poll/history refresh requests); no application
  exception was recorded.

The session was produced by the Replay Chromium history proof with the conflict event
seeded by the real stream-backed fixture, and the visible assertion required the
humanized conflict summary before the session completed.
