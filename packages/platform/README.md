# `@eforest/platform`

The platform package owns electric-forest's authenticated application boundary. A
`BearerVerifier` validates RS256 access tokens against the configured issuer, audience,
expiry, subject, and cached JWKS. Signature failure or an unknown key ID forces one JWKS
refresh, which makes same-`kid` key rotation replace rather than extend trust.

`PlatformGateway` exposes the web-standard `POST /api/dispatch` request handler. It
authenticates before parsing a dispatch body or touching the stream adapter, rejects any
client-supplied `actor`, injects the verified `sub`, and delegates the accepted append to
`OfficialStreamAdapter`. That adapter composes `@eforest/client`; this package does not
implement or wrap Durable Streams transport behavior.

## Web login configuration

The production entrypoint is `eforest-platform` (or `pnpm --filter @eforest/platform
start` after building). It constructs the OIDC client, transaction manager, identity
stream store, web application, and HTTP server from environment alone.

| Variable             | Required | Meaning                                                                                          |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `EF_OIDC_ISSUER`     | yes      | Absolute HTTP(S) OIDC issuer URL. Discovery is fetched from `/.well-known/openid-configuration`. |
| `EF_OIDC_CLIENT_ID`  | yes      | Public authorization-code client ID used as the ID-token audience.                               |
| `EF_SESSION_SECRET`  | yes      | HMAC secret for the session cookie; it must be at least 32 bytes.                                |
| `EF_SESSION_TTL`     | yes      | Positive whole number of seconds for a web session.                                              |
| `EFOREST_SERVER_URL` | yes      | Existing electric-forest convention for the official Durable Streams server base URL.            |
| `PORT`               | no       | Platform HTTP port; defaults to `4322`.                                                          |

`EF_SESSION_TTL` is measured from the `ts` of the corresponding
`identity.session.started` event. Expiry is derived while replaying the identity stream:
it does not append an expiry event and does not create a platform-local session record.
Consequently, restarting the platform preserves a still-live session as long as the
official stream remains available.

## Cookie and logout contract

The browser receives one cookie named `ef_session`. It is `HttpOnly`, `SameSite=Lax`,
scoped to `/`, and contains only the opaque session ID plus its HMAC signature. It never
contains an access token, ID token, email address, subject, or other claim. Session
validity comes exclusively from the reduced identity stream and the configured TTL.

`POST /auth/logout` appends one `identity.session.ended` event for an active session and
clears the cookie. Logout is idempotent: repeating it for the same ended session clears
the cookie again without attempting another identity-stream append. An expired, forged,
tampered, missing, or already-ended session is treated as logged out without changing the
stream.

## Authentication refusals

Authentication failures use `{ "error": { "class": "auth-refused", "reason": ... } }`.
The mapping is frozen:

| Reason          | HTTP status |
| --------------- | ----------: |
| `bad-state`     |         400 |
| `bad-verifier`  |         400 |
| `reused-code`   |         400 |
| `bad-nonce`     |         400 |
| `bad-token`     |         401 |
| `expired-token` |         401 |

Every refusal is log-neutral: it appends no user or session event.

## Auth0 and local issuer parity

The application has no emulator import, hostname check, port check, or local-only auth
branch. Local verification points `EF_OIDC_ISSUER` and `EF_OIDC_CLIENT_ID` at the pinned
OIDC service. To use a real Auth0 tenant, register the platform's
`/auth/callback` URL as an allowed callback and change only those same two variables to
the Auth0 issuer and public client ID. The session secret, TTL, stream URL, cookie,
routes, event shapes, and verification behavior are unchanged. The authorization-code
client is public and uses PKCE S256; no client secret is read by the platform.
