# E2-T02 Replay interrogation

- Recording: https://app.replay.io/recording/42c9cd06-092f-4186-a071-d267d3dd56de
- Same-session video: `recordings/e2-t02-final.mp4` (99,575 bytes, verified
  `video/mp4`, ffmpeg H.264 transcode from the lifecycle-captured WebM)
- Duration: 72.3 seconds

The uploaded recording was interrogated through Replay MCP after upload, rather than by
re-driving the browser:

- `RecordingOverview`: 0 console errors, 0 warnings; 13 requests, 0 failed, 0 slow.
- `ConsoleMessages(summary)`: 0 total messages.
- `UncaughtException`: none.
- `NetworkRequest(requests)`: all 13 requests were loopback-only on
  `127.0.0.1:45460` or `127.0.0.1:45461`, with no failed requests.
- `UserInteractions(interactions)`: three real clicks covered authorization submit,
  starting device authorization, and device approval.
- Authorization completion response: status 200 and body states
  `Authorization-code + PKCE complete`, byte-identical state echo, RS256 access and ID
  token issuance, and `kid: eforest-test-2026`.
- Device approval response: status 200 and title `Device approved | emulate`.
- Final response: status 200 and body states `Device authorization complete`, real
  Auth0-form approval, both RS256 token issuances, zero external services, and
  `E2-T02 final walkthrough: PASS`.
- Final-state evaluation and jump link:
  https://app.replay.io/recording/42c9cd06-092f-4186-a071-d267d3dd56de?point=24338891524438091834092751010398221&time=51226.53471552555
- Device-approval interaction jump link:
  https://app.replay.io/recording/42c9cd06-092f-4186-a071-d267d3dd56de?point=21093705987847082281302314388029864&time=38338
- Replay final screenshot timestamp: `51289ms`.

Replay's network table represents form-navigation redirects by their final GET document
entries. The response bodies and point evaluations above are the narrow checks for the
two completed exchanges; the committed golden/security transcripts independently pin
the literal POST routes and token statuses.
