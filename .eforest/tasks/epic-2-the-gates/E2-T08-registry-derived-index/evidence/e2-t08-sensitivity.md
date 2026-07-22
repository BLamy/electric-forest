# E2-T08 sensitivity proof

Each sabotage runs in a detached disposable worktree, rebuilt from source so
the mutation reaches the compiled code every sensor executes. The
zero-mutation control must pass every sensor before any sabotage counts, and
each sabotage must fail its named sensor for the attributable reason quoted
below. Normal verification never modifies this evidence file.

## zero-mutation control

registry suite, visibility matrix, and destruction proof all green (exit 0) in the disposable worktree.

Result: CONTROL_GREEN

## (a) projector silently drops registry.repo-visibility-changed

Sensor: registry suite. Went red (nonzero exit): the golden tree never materializes its 11th derived event; every door/digest assertion downstream of the drop fails.

Result: DROP_VISIBILITY_SENSITIVITY_OK

## (b) ef registry rebuild reuses a stale cached materialization

Sensor: destruction proof. Went red (nonzero exit): the corrupt-leftover probe caught the rebuild consulting the planted cache copy instead of replaying the source logs.

Result: REBUILD_CACHE_SENSITIVITY_OK

## (c) filterForIdentity returns the unfiltered state

Sensor: visibility matrix (snapshot half). Went red (nonzero exit) on the literal snapshot entry-set assertions — private entries leaked into anonymous/non-member listings.

Result: UNFILTERED_SENSITIVITY_OK

## (d) live frames only unfiltered (snapshots left correctly filtered)

Sensor: visibility matrix, LIVE half specifically. Went red on the held-open anonymous/non-member tail zero-frame assertion — the snapshot half passed (it runs first), so the catch is attributable to the live matrix alone.

Result: UNFILTERED_LIVE_SENSITIVITY_OK

## (e) hidden SSE frames delivered 500ms late (inside the frozen 2000ms live budget)

Sensor: visibility matrix, held suppression window. Went red on the >=2000ms-past-dispatch-accept re-assertion of the anonymous/non-member zero-frame logs — an assertion pinned only to the authorized frame's arrival instant (~tens of ms) would have stayed green on this within-budget skew.

Result: DELAYED_LEAK_SENSITIVITY_OK

## (f) long-poll CATCH-UP call site unfiltered (snapshots and the follow loop stay filtered)

Sensor: visibility matrix, anonymous/non-member long-poll catch-up over pre-existing hidden events (early after, waitMs=0). Went red on the literal visible-frame assertion — private frames surfaced in the catch-up response while every snapshot and follow-loop sensor stayed green.

Result: CATCHUP_UNFILTER_SENSITIVITY_OK

Any sabotage the sensors stay green on fails verify-E2-T08.
