# Sync harness

`@eforest/sync-harness` expands a pinned `(seed, profile)` into a canonical
schedule of writes, appends, deletes, renames, watcher lifecycle operations, and
barriers. `lockstep` waits for checkpoint quiescence after each step and is the
transcript-golden mode; `free` omits intermediate waits and only requires final
convergence. Transcripts contain logical steps, offsets, and digests only: runtime
ports, process ids, temporary roots, and wall-clock values are excluded.

The E4-T09 default profile exercises the E4-T07/E4-T08 partition and restart
contracts. Offline edits while a watcher is stopped and same-path conflicts are
deliberately deferred to E4-T10 and E4-T11.
