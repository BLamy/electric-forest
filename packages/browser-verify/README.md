# `@eforest/browser-verify`

This package is the frozen browser proof surface for Epic 3.

- `bootWorld()` starts a fresh file-backed Durable Streams process, deterministic Auth0
  emulator, authenticated platform, and built web bundle on ephemeral loopback ports. It
  returns out-of-band identity snapshot/dump handles and owns complete cleanup.
- `loginAs(page, subject)` drives the existing authorization-code+PKCE form with real
  pointer and keyboard input. It never injects a cookie or token.
- `bootWorld({ fixtureLogin: true })` plus `loginWithFixture(page)` exposes a
  credential-free one-click test identity. The browser still traverses the emulator's
  real S256 authorization-code and token-redemption flow, but no password input or
  password-bearing browser request exists. `bootWorld` rejects fixture mode before
  starting or seeding anything when `NODE_ENV=production`.
- `collectEfRegions(page)` rejects partial provenance triples and returns every complete
  `{ stream, offset, digest }` triple.

`bootWorld().openPage(browser)` installs the default-on browser tripwire before the first
navigation. `console.error`, uncaught page exceptions, failed same-origin requests, and
non-loopback browser requests accumulate as proof failures; `assertClean()` cannot be
silenced by a test.
