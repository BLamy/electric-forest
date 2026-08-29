# E4-T08 sensitivity transcript

- downlink writer filter removed: EXPECTED-FAIL OK
- uplink apply-journal consultation removed: EXPECTED-FAIL OK
- suppressed sync-journal disposition dropped: EXPECTED-FAIL OK
- one echo per idle minute: EXPECTED-FAIL OK

The live apparatus is the real Durable Streams integration test: an idle window of at
least 10 seconds compares the branch head before and after the window and counts
uploaded sync-journal lines. Replay: N/A (CLI daemon only) + stream-layer mitigation:
the committed convergence, quiescence, journal-audit, lifecycle, and sabotage artifacts.
