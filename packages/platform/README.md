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
