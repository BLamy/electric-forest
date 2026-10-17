# E12-T10 immutable candidate root gate audit

Result: **PASSED** (root gates only).

- Source: `9a5861e82ec99ab2f275181a527aab5c2bfb0622`; direct parent: `b19e7bce1cdcb06b2d11ba21d16de299402675f6`.
- Branch: `codex/railway-hosting`.
- Runtime: Node `v24.20.0`, pnpm `10.15.0`.
- Lockfile SHA-256: `ffd8b299ca115cfd2d0be9c8ba2833c2de791a071e77e90616c364b7afd9c54a`.
- Freeze SHA-256: `42a8a214ba962ce73aa38fb4455a3915045e046e3bd740171d17c737a1e45f7c`; 4 direct and 29 cumulative before/after path entries match committed blobs and worktree, including deletions. All three prior freezes and all 27 runtime/app/tooling/Docker source files match their frozen byte hashes.
- Source integrity: HEAD, branch, root tracked content, semantic index, physical index and all initialized submodule content/index snapshots match before and after every gate. Final comparison unchanged: `true`.
- Environment inherited unchanged; no environment values or credentials captured.

| Gate | Exact command | Exit | Seconds | Result |
| --- | --- | ---: | ---: | --- |
| 1 | `pnpm format:check && pnpm lint` | 0 | 12.833 | passed |
| 2 | `pnpm typecheck` | 0 | 9.212 | passed |
| 3 | `pnpm test` | 0 | 676.877 | passed |
| 4 | `pnpm build` | 0 | 19.016 | passed |

Captured test summary: Test Files  124 passed (124); Tests  972 passed (972); Start at  16:50:48; Duration  654.39s (transform 3.56s, setup 0ms, import 19.89s, tests 619.67s, environment 9ms).

Commands ran exactly once in order and stopped on the first failure. Every command has full stdout, stderr, merged raw bytes, timestamped output-event chunks, UTC start/end times, exit code, duration and before/after snapshots in `report.json`. Raw output order is read-ready chunk order; per-stream bytes are exact.

The capture validator read the logs afresh, reconstructed every merged raw chunk from per-stream offsets and checked complete coverage and all SHA-256 digests. Every root/submodule physical index is retained per snapshot; committed semantic source indexes and observed indexes are retained separately.

No product, lifecycle or index write was made by the auditor. Nothing staged or committed. Gate commands may produce their normal ignored artifacts. No Docker, Make task verifier, cold clone or browser session was run. This report assigns no task status or critic verdict.

Replay: N/A (read-only root command gate audit) + mitigation: complete logs, committed source manifests, per-gate root/submodule tracked/index snapshots and the artifact SHA-256 index.
