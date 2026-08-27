# E5-T10 focused sensitivity evidence

`make verify-E5-T10` verifies immutable committed digests, then mutates temporary copies
only. It flips one decoded byte in the first `content.chunk` and requires both the replay
state digest and reducer-derived SHA-256 to disagree with the committed seal. It separately
changes one byte of reference metadata in the attachment golden and requires the attachment
state digest to change.

Expected markers:

```text
MUTATION fixture=e5-t10-content byte=0 digest-mismatch EXPECTED-FAIL OK
MUTATION fixture=e5-t10-attachments byte=reference-title digest-mismatch EXPECTED-FAIL OK
```

The verifier hashes every protected artifact before and after the run and fails if any
committed file changes.
