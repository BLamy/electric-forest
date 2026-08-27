# E5-T13 focused sensitivity

- `CLOSE-OFFSET EXPECTED-FAIL OK`: replacing the opaque `via.prMergedOffset` with a
  non-existent offset makes the capstone composition verifier fail.
- `ATTACH-BYTE EXPECTED-FAIL OK`: changing the replayed attachment bytes without
  changing the seal makes the SHA-256 comparison fail.
- `NO-DATABASE EXPECTED-FAIL OK`: adding a `pg` dependency to a scratch package makes
  the repository audit report a database dependency.

Browser/DOM sabotage was not rerun in this builder pass.
