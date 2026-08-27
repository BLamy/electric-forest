# E5-T08 causal sensitivity

- one-byte-event-digest sensor=wiki-digest-parity:server-replay EXPECTED-FAIL OK
- delayed-writer-tail sensor=no-optimistic-offset,no-optimistic-digest,no-optimistic-revision EXPECTED-FAIL OK
- stale-editor sensor=stale-fence-log-bytes,no-auto-retry EXPECTED-FAIL OK
- hostile-markdown sensor=window-sentinel,active-dom,dangerous-protocol EXPECTED-FAIL OK

E5_T08_SENSITIVITY_OK cases=4
