# E4-T05 sensitivity

BASELINE focused integration suite green OK
MUTATION status-gate red EXPECTED-FAIL OK exit=1
TRANSCRIPT status-gate Test Files 1 failed (1) | Tests 1 failed | 5 passed (6) | dirty checkout refusal assertion failed
MUTATION materializer-deletions red EXPECTED-FAIL OK exit=1
TRANSCRIPT materializer-deletions Test Files 1 failed (1) | Tests 2 failed | 4 passed (6) | fresh checkout and post-fork materialization assertions failed
MUTATION fork-at-head red EXPECTED-FAIL OK exit=1
TRANSCRIPT fork-at-head Test Files 1 failed (1) | Tests 1 failed | 5 passed (6) | fresh checkout retained the post-checkpoint file
Each sabotage runs in a disposable source copy against the official-server integration suite; every mutation exits non-zero.
