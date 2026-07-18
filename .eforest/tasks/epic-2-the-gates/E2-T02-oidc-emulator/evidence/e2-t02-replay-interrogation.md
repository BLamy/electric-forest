# E2-T02 Replay interrogation — round 3

- Recording: https://app.replay.io/recording/9a1580de-dae8-4f28-a165-82f1957c306d
- Same-session video: `recordings/e2-t02-final.mp4` (542,425 bytes, verified
  `video/mp4`, H.264 1280x720 at 30fps, ffmpeg transcode from the lifecycle-captured WebM)
- Replay duration: 327.1 seconds

The uploaded recording was interrogated through Replay MCP after upload; no browser
rerun stands in for the cited timeline:

- `RecordingOverview`: zero console errors/warnings; 35 requests, zero failed, zero
  slow. `ConsoleMessages(summary)`: zero messages. `UncaughtException` and
  `ReactException`: none.
- `NetworkRequest(requests)`: every request is loopback-only on `127.0.0.1:45460`,
  `:45461`, or the isolated zero-TTL refusal emulator on `:45462`. The browser itself
  issues discovery, JWKS, both `/oauth/device/code` requests, both `/oauth/token`
  exchanges, and all visible refusal probes.
- `UserInteractions(summary)`: 143 trusted interactions — 23 pointer clicks and 120
  real keypresses across blocked, successful-login, expired-device, and successful-device
  forms.
- Blocked-user refusal: network request 4 returns HTTP 200 with no `Location` and a
  `Sign in failed` HTML body containing `user is blocked`. The submit interaction is
  point-linked here; the response completes at 86098ms:
  https://app.replay.io/recording/9a1580de-dae8-4f28-a165-82f1957c306d?point=20120150326863230129566094419034592&time=86017
- Exact redirect/state: at the next proof-page interaction, Replay evaluation reads
  `location.href` containing the authorization code and byte-identical hostile state
  `e2-t02 Replay state &=%`:
  https://app.replay.io/recording/9a1580de-dae8-4f28-a165-82f1957c306d?point=43810004743981425950241940343620627&time=165380.96623222748
- Authorization-code exchange request 15 is a browser-owned `POST /oauth/token` 200.
  Its body contains the exact callback, authorization code, and PKCE verifier; its
  response contains RS256 access and ID tokens:
  https://app.replay.io/recording/9a1580de-dae8-4f28-a165-82f1957c306d?point=47055190280570708426618540333728858&time=168211
- Expired-device refusal: browser-owned request 17 creates a grant with `expires_in: 0`:
  https://app.replay.io/recording/9a1580de-dae8-4f28-a165-82f1957c306d?point=54519117014724584688601832760542450&time=174104
  After real keyboard input, request 21 returns HTTP 200 with no `Location` and an
  `Expired device code` HTML body. Its submit interaction is point-linked here; the
  response completes at 209286ms:
  https://app.replay.io/recording/9a1580de-dae8-4f28-a165-82f1957c306d?point=76586378663541648323018442141599432&time=209197
- Successful device grant: browser-owned request 25 creates the real grant:
  https://app.replay.io/recording/9a1580de-dae8-4f28-a165-82f1957c306d?point=81129638414774069757356854829123385&time=237995.00086363635
  Request 26 visibly proves the adjacent wrong-credential refusal stays HTTP 200 without
  approving the grant. The real approval is then entered with keyboard events.
- Final device exchange request 34 is a browser-owned `POST /oauth/token` 200 carrying
  that device code and returning RS256 access and ID tokens plus `Bearer`:
  https://app.replay.io/recording/9a1580de-dae8-4f28-a165-82f1957c306d?point=110660826797754513185719230876617149&time=309368.5772889417

Replay represents form-navigation POST responses as their followed document request in
the network table. The response detail still exposes the exact status, headers, and HTML
body, while the committed Playwright trace independently records the response event. The
byte-exact golden separately pins the successful 302 `Location` and hostile state.
