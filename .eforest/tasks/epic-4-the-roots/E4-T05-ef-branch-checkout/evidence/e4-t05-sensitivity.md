# E4-T05 sensitivity

- The dirty-matrix integration test turns red when the E4-T04 status gate is bypassed.
- The post-fork deletion assertion turns red when clearWorktree/materialization leaves stale files behind.
- The stale-checkpoint fork assertion turns red when the provider fork uses the parent head instead of the saved workspace checkpoint.
- `tools/verify/e4_t05_sensitivity.mjs` applies each mutation in a disposable source copy and requires a non-zero focused test result.
