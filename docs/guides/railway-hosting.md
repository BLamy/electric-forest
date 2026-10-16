# Railway preview and production rollout

The first deployment is an explicitly **public, disposable preview** of the real web
app and platform gateway. Fixture sign-in requires no Auth0 API keys. Repository,
issue and collaboration actions use the normal gateway, reducers and a private
published Durable Streams reference server; the fixture identity is not production auth.

## Deployment binding

| Setting            | Preview value                                                                     |
| ------------------ | --------------------------------------------------------------------------------- |
| Project            | `e0864588-a320-4ba3-96df-95ad0a07ee81`                                            |
| Environment        | `c1cbbfc7-b8f7-4e3e-a4ee-a6260bea7448` (`production` in Railway)                  |
| Service            | `electric-forest-preview` / `160db4ed-ee0c-4d40-941c-65015a2071bf`                |
| HTTPS origin       | <https://electric-forest-preview-production.up.railway.app>                       |
| Data               | `forest-preview-data`, mounted at `/data`; runtime data in `/data/forest-preview` |
| Region / replicas  | `us-west2` / one                                                                  |
| Port / readiness   | `8080` / `/readyz`                                                                |
| Runtime entrypoint | `node packages/platform/dist/src/preview-bin.js`                                  |

The Railway environment's name is independent of the application's mode. This service
runs `preview`, displays that mode, and cannot satisfy the public production launch
criteria. Existing Postgres, Electric and cache starter services remain separate.

## Build and run locally

From a committed checkout:

```sh
docker build --platform linux/amd64 \
  --build-arg EF_BUILD_REVISION="$(git rev-parse HEAD)" \
  -t electric-forest-preview:local .
docker run --rm --name electric-forest-preview \
  -p 8080:8080 -v forest-preview-data:/data \
  -e PORT=8080 -e EF_PUBLIC_ORIGIN=http://localhost:8080 \
  electric-forest-preview:local
```

The Docker recipe pins Node and pnpm, installs from the frozen lockfile, executes
Linux LMDB/esbuild checks, builds workspace packages and web assets, and bakes the full
source revision into the image. It excludes local dependency trees, credentials,
workshops and test evidence. The preview runtime derives an artifact manifest from its
built files; `/api/deployment` identifies mode, revision and artifact.

## Runtime configuration

| Variable                     | Purpose                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `EF_DEPLOYMENT_MODE=preview` | Explicit preview opt-in                                            |
| `EF_PREVIEW_AUTH=fixture`    | Explicit synthetic identity opt-in                                 |
| `EF_PUBLIC_ORIGIN`           | Canonical HTTPS origin; HTTP loopback is supported for local tests |
| `EF_BUILD_REVISION`          | Optional if baked into the Docker image; when set, it must match   |
| `EF_PREVIEW_DATA_DIR`        | Dedicated persistent directory; default `/data/forest-preview`     |
| `EF_WEB_ROOT`                | Built assets; Railway uses `/app/apps/web/dist`                    |
| `EF_AGENT_RESPONDER=off`     | Agent subprocess execution stays disabled                          |
| `PORT`                       | Ingress listener on all container interfaces                       |

Preview startup refuses real OIDC/provider configuration, developer model credentials,
agent harness activation and real outbound integration credentials. It creates a local
cryptographic session secret and seed marker in the dedicated volume. Accepted preview
writes survive restart; an incomplete first bootstrap stops explicitly rather than
silently replacing data. Use separate directories/volumes for independent previews.

Use only synthetic content. Everyone who enters this preview can interact with its
dedicated fixture environment; the notice is part of the sign-in flow. Production
tenant-isolation acceptance remains a later E12 gate.

## Checks and evidence

Run `make verify-E12-T00` for the focused preview verification. The task's evidence
records real HTTP/configuration/persistence cases, two-browser interaction, independent
event replay, sensitivity checks and the actual Railway deployment identity.

The configured Replay QA project is `proj-electric-forest-ms8w0nv1`. Current access
requires authentication unavailable to this agent session; the exact diagnostic is
recorded in the task's `evidence/replay-availability.json`. The explicit fallback uses
Playwright with console/network inspection and independently replayed stream evidence.
It does not claim that a managed QA journey ran.

## Next usable deployment: real login, then local CLI

E12-T10 deploys a separate authenticated service with a fresh private volume, followed
by E12-T11 for local CLI setup and selected private-project mirroring. The human selected
our pinned patched Durable Streams provider, privately co-located on Railway; a managed
stream account is not required. T01-T09 retain full public qualification, load and
recovery acceptance. Public configuration already supplied:

- Auth0 issuer `https://dev-8qqftel4x1s5wed3.us.auth0.com/` and public SPA client ID
  `H9LGwHMzwWHgamCot9KTAmOFJCmDIlOk`. Register the exact new HTTPS `/auth/callback`,
  logout and origin values only when the candidate origin is known. No client secret
  is needed for public authorization-code/S256 PKCE.
- A dedicated private persistent provider volume; the starter's Postgres/Shape URL is
  a different API. Do not copy public preview state into it.
- A stable private session-signing secret generated/stored securely by the new runtime,
  never committed or shown in logs. The implemented task will document its exact binding.

First CLI setup uses the existing revocable web-minted token with secure local input,
an origin-bound profile and a reproducible local launcher. Do not paste a token into
chat or shell arguments. Gateway-only initial import and one-way updates must pass
dedicated fixture proof before the human selects the first real project. The complete
content-addressed changeset model remains E14; this first hosted path uses full files.

The ordinary production runtime rejects preview flags. Switching to it also requires
the remaining E12 implementation and proof; adding API keys to this fixture entrypoint
does not silently enable production mode. Use a fresh production data boundary rather
than promoting publicly writable fixture identities and content into production state.

## Authenticated private runtime

Build `Dockerfile.production` with the exact full source revision as
`EF_BUILD_REVISION`. This separate image starts `hosted-bin.js`; it inherits no preview
mode, fixture credentials or seed. It checks `production-artifact.json` against every
emitted runtime/web byte before opening the private store or public listener. Runtime
configuration must use the following public values and a fresh dedicated volume:

For the dedicated `electric-forest` service, set **Railway Config File** to the absolute
repository path `/railway.production.toml`. This config selects `Dockerfile.production`
and `node packages/platform/dist/src/hosted-bin.js`, a single replica, `/readyz` with a
60-second timeout, three failure restarts, zero overlap and a 15-second drain. Keep the
root `railway.toml` and `Dockerfile` attached to the preview service. Railway's
[repository config overrides dashboard settings](https://docs.railway.com/config-as-code#using-a-custom-config-as-code-file);
`RAILWAY_DOCKERFILE_PATH` alone does not override the root config's explicit preview
Dockerfile selection. Confirm the selected config and Dockerfile in deployment details
before accepting the release.

Railway [deprecates Config as Code with a 2026-12-01 cutoff](https://docs.railway.com/infrastructure-as-code#migrating-from-config-as-code)
for existing services; new services cannot opt into it. This is the existing service's
immediate deployment repair. Broader hosting qualification must migrate its configuration
to Railway Infrastructure as Code before that cutoff.

```text
EF_DEPLOYMENT_MODE=production
EF_PUBLIC_ORIGIN=https://electric-forest-production.up.railway.app
EF_OIDC_ISSUER=https://dev-8qqftel4x1s5wed3.us.auth0.com/
EF_OIDC_CLIENT_ID=H9LGwHMzwWHgamCot9KTAmOFJCmDIlOk
EF_DATA_DIR=/data/forest-private
EF_WEB_ROOT=/app/apps/web/dist
EF_AGENT_RESPONDER=off
PORT=8080
```

The runtime generates one private session-signing key in `session.key` (0600) inside
its data directory (0700). A synced initialization journal is resumable only before the
first listener; the ready marker binds the key hash and issuer/client. A ready store
with a missing key or required authority stream stops. Never replace the key, remove
markers, or initialize production from the public preview volume. Do not set
`EF_SESSION_SECRET`, `EFOREST_SERVER_URL`, preview flags, model/harness credentials or
email integration keys on this service.

Register exactly the following public application values in Auth0:

- Callback: `https://electric-forest-production.up.railway.app/auth/callback`
- Allowed logout URL: `https://electric-forest-production.up.railway.app/`
- Allowed web origin: `https://electric-forest-production.up.railway.app`

Sign in through `/auth/login`, verify the Auth0/private-data build indicator, then use
**Add workspace** to create your own organization. **Account → CLI tokens** (also linked
in the hosted banner) reaches the existing token page. Mint a dedicated local credential
and supply it through T11's secure local setup; never put it in chat or shell arguments.
This milestone accepts opaque web-minted `ef_cli_` grants at the gateway and refuses
Auth0 ID/access JWTs as API credentials. Hosted device registration is disabled until
its API/native client audience is separately qualified. Token scopes must still match
the gateway's explicit authorization; T11 qualifies branch-scoped CLI write input.

The initial limits exposed by `/api/build` are: 8 MiB buffered request body, 30 seconds
from Node admitting a request through body buffering and finite response preparation,
10-minute browser-bound login transactions,
24-hour sessions (a shorter positive `EF_SESSION_TTL` is permitted), readiness within
60 seconds and drain within 15 seconds. Hosted long-poll holds are at most 10 seconds;
larger `waitMs` requests receive 400. Normal web follows use 1.5 seconds. Established
SSE responses leave the header deadline after headers and are cancelled when their socket
closes; shutdown closes listeners/connections and drains accepted handlers before closing
the private provider. Cookie mutations require the exact configured Origin. CLI bearer
dispatch has a separate policy and cannot fall back to a privileged cookie.

The HTTP phases have separate clocks. Node's parser owns the 30-second header and
request-receive deadlines, checked every second in production (the parser can report an
expiry on its next check). Its keepalive idle timeout is configured separately at five
seconds, with Node's normal socket buffer. Idle time never consumes a subsequently
admitted request's 30-second body/handler/finite-response budget. That budget includes
body buffering and ends when finite response headers are ready; established SSE is
cancelled by connection closure/drain instead. This does not claim a single global
first-byte-through-application-processing clock. No HTTP parsing or pipelining semantics
are replaced by an application header parser. Tightened fixture clocks retain the same
phase policy and expose their actual parser checking interval.

`make verify-E12-T10` builds its complete dependency closure, runs focused preserved
local/preview contracts, then drives an isolated dedicated issuer through the real hosted
gateway/provider over HTTP and browser flows. Fixture keys/data stay in that task's ignored
`work/` directory. Its synthetic proof does not establish the separate actual Auth0
operator-login requirement or complete the remaining public-launch qualification tasks.
