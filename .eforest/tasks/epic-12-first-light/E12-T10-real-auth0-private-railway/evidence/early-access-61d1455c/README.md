# Early-access release evidence

The fixture proofs in this directory exercise source revision
`61d1455cdc85a5cb10f9f746ea1fb3ab8acbbdb1`. They contain only synthetic test
identities and no production credentials. This evidence-only commit does not change
the application image.

## Gates

The immutable source candidate passed, in order, `pnpm format:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm test` (141 files, 1,159 tests), and `pnpm build`.
`node tools/verify/e12_t10_hosted.mjs` passed 82 HTTP checks and seven stream dumps;
`node tools/verify/e12_t10_browser.mjs` passed 36 browser scenes with zero console,
page, or request errors. The two proof manifests include the full check list, browser
network observations, and dump digests. The final synthetic identity logs are included
for independent digest replay.

| Artifact | SHA-256 |
| --- | --- |
| `hosted-proof.json` | `7f97979a97b807058d681ef3b5b8ed5e951b674e688ffa954f142ad42c1f83f1` |
| `browser-proof.json` | `afb129058ab446edb9f5f55b2bff3520c1e39fdeed894fcc6a71486c331defe1` |
| `hosted-identity-final.jsonl` | `51ef15139a79a7333de624b64f9bdb55f05b62e02024e5c2652104dd21ecbf33` |
| `browser-identity-final.jsonl` | `8393fc96611bd0235472d6429a312c4114d63e43a98c8feedcd57d626f66ecaf` |

The source candidate also served `/.well-known/replay-qa-security-nonce` with a
signed session belonging to a disallowed email: GET returned HTTP 200,
`text/plain; charset=utf-8`, no redirect, and the exact current nonce body (SHA-256
`3dea3f7f403a1fd95db85b624a88c054f8192d9419505d92a02007af322467a5`);
HEAD returned HTTP 200 with an empty body.

Replay: N/A (the configured `proj-electric-forest-ms8w0nv1` returned “Project not
found”) + mitigation: dedicated hosted and Playwright fixture proofs above, including
the network and console observations and deterministic identity logs. These fixtures
do not establish a live Auth0 callback or production Claude-agent execution. The
hosted runtime deliberately keeps agents and integrations disabled; no Claude token
was installed or used.
