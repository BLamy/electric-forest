# `@eforest/browser-verify`

This package is the frozen browser proof surface for Epic 3.

- `bootWorld()` starts a fresh file-backed Durable Streams process, deterministic Auth0
  emulator, authenticated platform, and built web bundle on ephemeral loopback ports. It
  returns out-of-band identity snapshot/dump handles and owns complete cleanup.
- `loginAs(page, subject)` drives the existing authorization-code+PKCE form with real
  pointer and keyboard input. It never injects a cookie or token.
- `collectEfRegions(page)` rejects partial provenance triples and returns every complete
  `{ stream, offset, digest }` triple.

`bootWorld().openPage(browser)` installs the default-on browser tripwire before the first
navigation. `console.error`, uncaught page exceptions, failed same-origin requests, and
non-loopback browser requests accumulate as proof failures; `assertClean()` cannot be
silenced by a test.
