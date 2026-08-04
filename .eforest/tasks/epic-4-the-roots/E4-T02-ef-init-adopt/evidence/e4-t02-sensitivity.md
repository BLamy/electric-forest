# E4-T02 sensitivity

- Flipping one byte of `e4-t02-init-golden.jsonl` changed the replay worktree digest and failed the byte-equality assertion.
- The committed init integration test exercises the shared E4-T01 walker, `.ef/` exclusion, workspace checkpoint, exact namespace offsets and before/after digests, same-project second-repo project-create skip, registry repo-prefix projection with derived offsets, real gateway `/registry/me` visibility and revoked-token 401, verify-before-commit mismatch refusal, same-project and fresh-project `ns/name-taken` collisions, tokenless and revoked log-neutrality, zero-request already-initialized refusal with byte-preserved workspace, and root `.ef` regular-file conflict refusal before any remote mutation.
- Tokenless init returned exit `10` before contacting the closed server; the integration fixture also proves unchanged namespace and registry heads/digests.
