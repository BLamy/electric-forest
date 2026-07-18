# E2-T02 verifier sensitivity

Base commit: `e9a0420822dead9f5f1de95d8a4f424b742efaf7`

Both attacks ran from fresh detached worktrees with the pinned `vendor/emulate`
submodule initialized. The authoritative commands were allowed to bind loopback because
the repository's existing integration tests and the E2-T02 browser proof both require
local HTTP servers.

## Signing-key corruption

- Mutation: changed the first character of the private RSA JWK `d` member from `B` to
  `C` in
  `vendor/emulate/packages/@emulators/auth0/fixtures/test-keypair.private.jwk.json`.
- Command: `CI=true make verify-E2-T02`
- Result: exit 2 at `_v-e2-t02-auth0`, after 249/249 parent tests, the complete 17-package
  emulator build, and 54/54 upstream Auth0 tests passed.
- Detection: the harness rejected the private-key fingerprint:
  expected `7ff64a83d9696aac4704c14dde2437c3da912f684919868d408d383a69b3537c`,
  observed `e5ca1e740749cc08fdc4d08eb965b33b9486f70a0fa75f1cc3a755db7c0867c1`.

## PKCE enforcement removal

- Mutation: replaced the authorization-code exchange verifier check in
  `vendor/emulate/packages/@emulators/auth0/src/routes/oauth.ts` with `if (false)`.
- Command: `CI=true make verify-E2-T02`
- Result: exit 2 at `_v-e2-t02-auth0`, after 249/249 parent tests and the complete
  17-package emulator build passed.
- Detection: upstream Auth0 test `rejects a wrong verifier and redirect URI without
  consuming the code` observed HTTP 200 for `wrong-verifier` where HTTP 400 was required;
  53 tests passed and the sabotaged test failed.

These failures demonstrate that the target measures both the frozen signing material and
the mandatory PKCE boundary instead of merely exercising a happy path.
