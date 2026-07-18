# E2-T02 Replay interrogation — round 2

- Recording: https://app.replay.io/recording/4373ce08-3243-4c16-917f-fb66c957e8e5
- Same-session video: `recordings/e2-t02-final.mp4` (486,981 bytes, verified
  `video/mp4`, H.264 1280x720 at 30fps, ffmpeg transcode from the lifecycle-captured WebM)
- Replay duration: 85.9 seconds

The uploaded recording was interrogated through Replay MCP after upload; no browser
rerun stands in for the cited timeline:

- `RecordingOverview`: 0 console errors/warnings; 29 requests, 0 failed, 0 slow.
- `ConsoleMessages(summary)`: 0 total messages. `UncaughtException`: none.
- `NetworkRequest(requests)`: every request is loopback-only on `127.0.0.1:45460`
  or `127.0.0.1:45461`; the browser itself issues discovery, JWKS, two
  `/oauth/device/code` requests, two `/oauth/token` requests, and both visible refusal
  probes.
- `UserInteractions(summary)`: 69 real interactions — 13 pointer clicks and 56
  sequential keypresses across the login and device-approval forms.
- At the redirect proof point, Replay evaluation observes the callback URL's code and
  byte-identical hostile state plus DOM proof captured from the actual browser response:
  `status=302`, `code=true`, `state=e2-t02 Replay state &=%`, `PASS=true`.
  https://app.replay.io/recording/4373ce08-3243-4c16-917f-fb66c957e8e5?point=11682667931712071333239416862802279&time=49063
- Authorization-code exchange request index 9 is a browser-owned `POST /oauth/token`
  200 whose request contains the exact PKCE verifier and whose JSON response contains
  RS256 access and ID tokens:
  https://app.replay.io/recording/4373ce08-3243-4c16-917f-fb66c957e8e5?point=15252372021956752964528075293327777&time=51138
- The first device grant visibly exercises unknown-code and bad-credential refusal
  pages, then the real deny control. A second browser-owned `POST /oauth/device/code`
  creates the grant that is approved with real keyboard input:
  https://app.replay.io/recording/4373ce08-3243-4c16-917f-fb66c957e8e5?point=31802818258546154454247545583436631&time=61961.0008125
- Device exchange request index 28 is a browser-owned `POST /oauth/token` 200 carrying
  the second device code and returning RS256 access and ID tokens:
  https://app.replay.io/recording/4373ce08-3243-4c16-917f-fb66c957e8e5?point=44459041851230699756894217442428085&time=68261.00082352941
- The post-response final point evaluates to `E2_T02_FINAL_PASS`, status 200, three JWT
  segments for both tokens, and `tokenType: Bearer`:
  https://app.replay.io/recording/4373ce08-3243-4c16-917f-fb66c957e8e5?point=44459041851231058315482085747326989&time=68290.1561461794

Replay represents the form-navigation hop itself as the followed GET document, so the
walkthrough captures the raw POST response with Playwright's browser response event and
surfaces its exact 302 Location fields in the DOM at the cited Replay point. The
committed byte-exact golden independently pins the same response header and state.
