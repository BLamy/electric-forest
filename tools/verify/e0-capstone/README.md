# Epic-0 capstone runner

`run.sh` starts a fresh file-backed server, runs terminal A's validated dispatch
sequence, kills terminal B mid-stream, resumes B from its persisted offset, and proves
digest/bisect parity. `EF_CAPSTONE_KILL_AFTER=0` exercises the no-checkpoint restart;
values at or past the valid event count fail loudly because the resume leg did not run.

`run.sh --check A.jsonl B.jsonl` is the standalone digest/bisect check used by the
tamper drill.
