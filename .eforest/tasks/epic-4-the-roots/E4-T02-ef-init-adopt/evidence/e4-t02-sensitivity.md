# E4-T02 sensitivity

- Flipping one byte of `e4-t02-init-golden.jsonl` changed the replay worktree digest and failed the byte-equality assertion.
- The committed init integration test exercises the shared E4-T01 walker, `.ef/` exclusion, workspace checkpoint, same-project second-repo project-create skip, registry repo-prefix projection, real gateway `/registry/me` visibility and revoked-token 401, verify-before-commit mismatch refusal, same-project and fresh-project `ns/name-taken` collisions, 401 refusal, and zero-request already-initialized refusal.
- Tokenless init returned exit `10` before contacting the closed server.
