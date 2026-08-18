T12 sabotage probes mutate disposable watcher worktrees and require a named red convergence assertion.
byte-mutation: Error: convergence mismatch path=[{"path":"notes/todo.md","kind":"content"}] first-divergent-offset={"aOffset":"0000000000000000_0000000000000011","bOffset":null,"index":12,"kind":"prefix","lastCommonDigest":"cfa85159a3b357b996608d8c6f9acfbea74f0bc7d8d69cc41f536e40e7270021"} digestA=980abfc68b33f7c3aa3a128bab37ee52fdb723374240f17836583a874807aa26 digestB=6302da96e20e0f5d1f8191a59c87e432c5f7da15e551df876b80b312c610dbfd replay=6302da96e20e0f5d1f8191a59c87e432c5f7da15e551df876b80b312c610dbfd
EXPECTED-FAIL OK
post-quiescence-byte-flip-B: Error: convergence mismatch path=[{"path":"notes/todo.md","kind":"content"}] first-divergent-offset={"aOffset":"0000000000000000_0000000000000011","bOffset":null,"index":12,"kind":"prefix","lastCommonDigest":"cfa85159a3b357b996608d8c6f9acfbea74f0bc7d8d69cc41f536e40e7270021"} digestA=6302da96e20e0f5d1f8191a59c87e432c5f7da15e551df876b80b312c610dbfd digestB=980abfc68b33f7c3aa3a128bab37ee52fdb723374240f17836583a874807aa26 replay=6302da96e20e0f5d1f8191a59c87e432c5f7da15e551df876b80b312c610dbfd
EXPECTED-FAIL OK
delete-corruption: Error: convergence mismatch path=[{"path":"notes/todo.md","kind":"missing-left"}] first-divergent-offset={"aOffset":"0000000000000000_0000000000000011","bOffset":null,"index":12,"kind":"prefix","lastCommonDigest":"cfa85159a3b357b996608d8c6f9acfbea74f0bc7d8d69cc41f536e40e7270021"} digestA=7b202f661b1ea964110e682f847cc6daae70e6c205582e7798bf3caf7038380d digestB=6302da96e20e0f5d1f8191a59c87e432c5f7da15e551df876b80b312c610dbfd replay=6302da96e20e0f5d1f8191a59c87e432c5f7da15e551df876b80b312c610dbfd
EXPECTED-FAIL OK
stray-corruption: Error: convergence mismatch path=[{"path":"stray-e4-t09.txt","kind":"missing-right"}] first-divergent-offset=unavailable digestA=e72ee9d2ff15a57e7904c59da932dd024367ecf6b8bdc5aa227a6a1eb7a233df digestB=6302da96e20e0f5d1f8191a59c87e432c5f7da15e551df876b80b312c610dbfd replay=6302da96e20e0f5d1f8191a59c87e432c5f7da15e551df876b80b312c610dbfd
EXPECTED-FAIL OK
swap-corruption: Error: convergence mismatch path=[{"path":"docs/renamed.txt","kind":"content"},{"path":"notes/todo.md","kind":"content"}] first-divergent-offset={"aOffset":"0000000000000000_0000000000000019","bOffset":null,"index":20,"kind":"prefix","lastCommonDigest":"cfa85159a3b357b996608d8c6f9acfbea74f0bc7d8d69cc41f536e40e7270021"} digestA=76c6cc67ae63d3805aad932ce0c4e1a5e20943c4c0af3196ff9cb698374cea0d digestB=6302da96e20e0f5d1f8191a59c87e432c5f7da15e551df876b80b312c610dbfd replay=6302da96e20e0f5d1f8191a59c87e432c5f7da15e551df876b80b312c610dbfd
EXPECTED-FAIL OK
bound-zero: Error: convergence bound exceeded boundMs=0 observedMs=731
EXPECTED-FAIL OK
conflict-file write disabled: conflict-file write disabled: EXPECTED-FAIL OK
EXPECTED-FAIL OK
sync/conflict dispatch disabled: sync/conflict dispatch disabled: EXPECTED-FAIL OK
EXPECTED-FAIL OK
conflictFileName offset mangled: conflictFileName offset mangled: EXPECTED-FAIL OK
EXPECTED-FAIL OK
conflict-file-disabled: Error: scenario mixed conflict-file mismatch=[[],[]]
EXPECTED-FAIL OK
catchup-offset-zero: Error: journal bijection mismatch after catch-up offset=0: error: cli/watch-start-failed: watcher exited before becoming ready
EXPECTED-FAIL OK
