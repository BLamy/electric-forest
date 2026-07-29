# E2-T02 Replay interrogation — round 4

- Recording: https://app.replay.io/recording/15401f79-460e-458b-818a-3e6067cacb7a
- Same-session video: `recordings/e2-t02-final.mp4` (665,716 bytes, verified
  `video/mp4`, ffmpeg-transcoded from the lifecycle-captured WebM)
- Replay duration: 392.8 seconds

The uploaded recording was interrogated through Replay MCP after upload; no browser
rerun stands in for this evidence:

- `RecordingOverview`: 51 loopback requests, zero failed, zero slow, and zero console
  errors or warnings. `ConsoleMessages(summary)` reports zero messages and
  `UncaughtException` reports none.
- `UserInteractions(summary)`: 181 trusted interactions — 31 pointer clicks and 150
  real keypresses spanning wrong-password, blocked-user, successful login,
  expired-device, real denial, and successful device approval paths.
- Wrong-password refusal: real keys enter the wrong password and the browser visibly
  reaches `Sign in failed` / `Wrong email or password.` at the linked submit point:
  https://app.replay.io/recording/15401f79-460e-458b-818a-3e6067cacb7a?point=20769187434180061677623818930094541&time=56370
- Blocked-user refusal: a separate real-key submission visibly reaches
  `Sign in failed` / `user is blocked`:
  https://app.replay.io/recording/15401f79-460e-458b-818a-3e6067cacb7a?point=39915782100072269365956958373282759&time=114936
- Successful authorization: the next real-key submission redirects to the callback
  with an authorization code and the byte-identical hostile state. The linked point is
  the successful submit; the browser-owned proof page subsequently fetches discovery,
  JWKS, and exchanges the code through `POST /oauth/token` 200:
  https://app.replay.io/recording/15401f79-460e-458b-818a-3e6067cacb7a?point=60035932426939654624625655868818854&time=157824
- The browser then creates an isolated zero-TTL device grant and, after real keyboard
  input, visibly reaches `Expired device code`. It separately creates a denial grant,
  opens the real upstream activation form, and clicks its `Deny` button; the form
  visibly reaches `Request denied` / `The device was not authorized` here:
  https://app.replay.io/recording/15401f79-460e-458b-818a-3e6067cacb7a?point=105468529939226243374706938292996540&time=268161.6386554622
- The next browser click polls that exact denied grant. Replay network detail for
  `GET /denied-poll?device_code=auth0_device_pliCVL3rQ0k6UUH2HB72nGUZnwJdYkxd`
  records the response body
  `{"status":403,"text":"{\"error\":\"access_denied\",\"error_description\":\"The user denied this device request.\"}"}`.
  The DOM simultaneously displays
  `DENIED_DEVICE_TOKEN_REFUSAL { "status": 403, "error": "access_denied", ... }`:
  https://app.replay.io/recording/15401f79-460e-458b-818a-3e6067cacb7a?point=110011789690459622886815679270357546&time=291328.39338654507
- Finally, a distinct browser-created device grant is probed with bad credentials,
  approved through the real form with real keys, and exchanged by browser-owned
  `POST /oauth/token` 200. The terminal DOM is
  `E2_T02_FINAL_PASS { "status": 200, "accessTokenSegments": 3,
  "idTokenSegments": 3, "tokenType": "Bearer" }`:
  https://app.replay.io/recording/15401f79-460e-458b-818a-3e6067cacb7a?point=142139126502718542411280006179196168&time=374988.08726415096

The denied poll deliberately crosses a same-origin service-worker endpoint so Replay's
browser network index retains the exact upstream refusal result without emitting a
console error for the expected HTTP 403. The endpoint does not translate the result:
its recorded response body preserves the upstream status and byte-for-byte error body.
The committed Playwright trace independently listens at the browser context boundary and
asserts that the underlying emulator `POST /oauth/token` response itself is HTTP 403.
