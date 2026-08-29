# E4-T11 sensitivity

The committed scratch-worktree mutation harness runs each mutation against focused
behavioral tests. Every mutated implementation went red:

- conflict-file write disabled: EXPECTED-FAIL OK
- write ordering inverted: EXPECTED-FAIL OK
- sync/conflict dispatch disabled: EXPECTED-FAIL OK
- conflictFileName offset mangled: EXPECTED-FAIL OK
- echo discrimination disabled: EXPECTED-FAIL OK
- sync/conflict reducer made tree-mutating: EXPECTED-FAIL OK
