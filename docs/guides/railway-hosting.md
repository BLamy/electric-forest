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
