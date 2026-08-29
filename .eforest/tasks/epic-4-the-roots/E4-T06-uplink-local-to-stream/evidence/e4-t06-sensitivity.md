# E4-T06 sensitivity transcript

transport=official @durable-streams/server 0.3.8; emulator=not used

- journal writes disabled: EXPECTED-FAIL OK
- base replaced with live-head fetch: EXPECTED-FAIL OK
- final rapid-burst write dropped: EXPECTED-FAIL OK
- `.ef/` exclusion removed: EXPECTED-FAIL OK
- ledger advanced before journal flush: EXPECTED-FAIL OK
