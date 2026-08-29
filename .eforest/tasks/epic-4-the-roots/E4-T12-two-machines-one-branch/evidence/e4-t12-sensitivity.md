T12 sabotage probes mutate disposable watcher worktrees and require a named red convergence assertion.
byte-mutation: Error: convergence mismatch path=[{"path":"notes/todo.md","kind":"content"}] first-divergent-offset={"aOffset":"0000000000000000_0000000000000011","bOffset":null,"index":12,"kind":"prefix","lastCommonDigest":"cfa85159a3b357b996608d8c6f9acfbea74f0bc7d8d69cc41f536e40e7270021"} digestA=ff07408ae0cd66c24efa34caafeb79c5057b81ad9a025bf79c67cdcd6656e945 digestB=8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02 replay=8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02
EXPECTED-FAIL OK
post-quiescence-byte-flip-B: Error: convergence mismatch path=[{"path":"notes/todo.md","kind":"content"}] first-divergent-offset={"aOffset":"0000000000000000_0000000000000011","bOffset":null,"index":12,"kind":"prefix","lastCommonDigest":"cfa85159a3b357b996608d8c6f9acfbea74f0bc7d8d69cc41f536e40e7270021"} digestA=8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02 digestB=ff07408ae0cd66c24efa34caafeb79c5057b81ad9a025bf79c67cdcd6656e945 replay=8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02
EXPECTED-FAIL OK
delete-corruption: Error: convergence mismatch path=[{"path":"notes/todo.md","kind":"missing-left"}] first-divergent-offset={"aOffset":"0000000000000000_0000000000000011","bOffset":null,"index":12,"kind":"prefix","lastCommonDigest":"cfa85159a3b357b996608d8c6f9acfbea74f0bc7d8d69cc41f536e40e7270021"} digestA=34ee9b3e6ded94eab653361da8de46e60cc90e0e66db013ebdf3037ce863d823 digestB=8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02 replay=8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02
EXPECTED-FAIL OK
stray-corruption: Error: convergence mismatch path=[{"path":"stray-e4-t09.txt","kind":"missing-right"}] first-divergent-offset=unavailable digestA=1ff7717669574f0ae6de039ba2af48ff5413a5f4d59b867f8538388360ee04ff digestB=8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02 replay=8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02
EXPECTED-FAIL OK
swap-corruption: Error: convergence mismatch path=[{"path":"docs/renamed.txt","kind":"content"},{"path":"notes/todo.md","kind":"content"}] first-divergent-offset={"aOffset":"0000000000000000_0000000000000017","bOffset":null,"index":18,"kind":"prefix","lastCommonDigest":"cfa85159a3b357b996608d8c6f9acfbea74f0bc7d8d69cc41f536e40e7270021"} digestA=66a435442d13514bccfd2f61a8374f9190c04d86c2165d711a4fce6a26933aca digestB=8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02 replay=8d3563ade441d82535beb1bbbbf075a14d972dd4f6e8f233187e2f700316dc02
EXPECTED-FAIL OK
bound-zero: Error: convergence bound exceeded boundMs=0 observedMs=737
EXPECTED-FAIL OK
conflict-file write disabled: conflict-file write disabled: Error: ENOENT: no such file or directory, open '/var/folders/xj/jvddkcmd6y9_f79xzk2z_rd00000gn/T/eforest-conflict-Reu9aW/src/data.bin.conflict-opaque%2F7': EXPECTED-FAIL OK
EXPECTED-FAIL OK
sync/conflict dispatch disabled: sync/conflict dispatch disabled: UplinkError: uplink/conflict-event-refused: base.txt: EXPECTED-FAIL OK
EXPECTED-FAIL OK
conflictFileName offset mangled: conflictFileName offset mangled: AssertionError: expected 'docs/readme.md.conflict-mangled' to be 'docs/readme.md.conflict-a%2Fb%20c%0A%…' // Object.is equality: EXPECTED-FAIL OK
EXPECTED-FAIL OK
conflict-dossier-bytes: Error: mixed capstone conflict bytes mismatch loser=c9259175689e91ea0195006479573e86c9507b16c0ed3020d48a5c44176ad473 conflict=cc85e1b79486bc75634f0e33699099b0eb32b7b1858dddaec46f4f6847cb65d8
EXPECTED-FAIL OK
catchup-offset-stale: Error: scenario mixed conflict-event count=0
EXPECTED-FAIL OK
