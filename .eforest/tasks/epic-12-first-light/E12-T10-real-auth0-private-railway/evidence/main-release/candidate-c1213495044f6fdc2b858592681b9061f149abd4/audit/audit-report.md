Ordered root gate audit: passed

Candidate: `c1213495044f6fdc2b858592681b9061f149abd4`
Tree: `2d60f1ee091d33dcee4f7be33e19d47e4343da6d`
Sole parent: `1eda083c1ab66bb89125734610063e14cdd448e8`

Fresh auditor ran the following gates sequentially, once each, with NODE_OPTIONS, NODE_ENV and npm_config_* scrubbed. Node v24.20.0 and pnpm 10.15.0 matched the assigned runtime.

| Gate | Command | Exit | Duration | Source/index check |
| --- | --- | --- | --- | --- |
| 1 | `pnpm format:check && pnpm lint` | 0 | 15.221s | 0 |
| 2 | `pnpm typecheck` | 0 | 11.942s | 0 |
| 3 | `pnpm test` | 0 | 785.566s | 0 |
| 4 | `pnpm build` | 0 | 18.884s | 0 |

Vitest raw output summary:

- `Test Files  141 passed (141)`
- `Tests  1144 passed (1144)`
- `Start at  20:01:54`
- `Duration  762.89s (transform 4.21s, setup 0ms, import 31.91s, tests 714.01s, environment 9ms)`

Full source integrity: passed. Baseline and every post-gate/final snapshot bind all 3,015 root tracked entries and all 668 pinned vendor/emulate entries to full Git object IDs, direct byte SHA-256, and file/symlink modes. Semantic index records and physical index bytes in both repositories were compared against the baseline; the integrity result above reflects every check. The lockfile SHA-256 is `a977812903abfd8904af23424cb0ceb09e695986db4f252c5e1035ac1f6dc9da`.

Root physical index SHA-256: `5edbf1192e3e490061e9aa35c12e7e265bba7207e936b15804901bdd2e1646cf`.
Emulate physical index SHA-256: `e94218bde1a96425fd35b076e780ab052c74f604cbfc2551a1168e07aac3b277`.

Raw complete stdout and stderr, exact argv, UTC start/end timestamps, exit codes, durations, environment scrub names, and post-gate source checks are captured in `gate-*.json` and `gate-*.{stdout,stderr}.log`. Source inventories and raw index copies are stored in each snapshot directory. `artifact-index.json` hashes all receipts, source inventories and instrumentation; its own digest is in `artifact-index.sha256`.

Replay: N/A (ordered root gate audit does not exercise a browser session) + mitigation: complete raw gate outputs and per-gate committed-source, direct-byte/mode, lockfile, semantic-index and physical-index integrity checks.

Auditor edits were limited to audit receipts and instrumentation inside the assigned ignored audit directory. Executed gates may generate ignored build/test output. No task status, ledger, source or index edit was authorized; snapshot checks report tracked-source and index integrity independently.
The pre-existing nonignored critic-work/e7-t06-skeptic.test.ts was inventoried and left untouched; it is excluded from the assigned clean-tracked source constraint.
This audit does not include a cold clone, browser session, deployment validation, or a task verification decision. GitHub CI is a separate parent responsibility; this audit makes no CI claim.
