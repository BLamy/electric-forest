Refusal transcripts are captured by the issue dispatch integration harness.
Each refusal must retain the before/after head offset and digest; refusal is
log-neutral by contract.

`issue-boundary-cases.txt` is the compact live-HTTP garbage corpus. Large bodies
are pinned by exact byte/code-unit counts and SHA-256 rather than embedding a 10 MiB
request in git. It includes the critic's literal `v:1.0`, exact 10,485,760-character
body, combined decoded NUL/astral payload, and independently varied NUL and astral
attacks for every issue payload string-field shape. The evidence verifier requires
the focused run to emit every committed line with exact 422 body and neutral head/digest.
The limits record distinguishes the 1,048,576-code-unit payload-string ceiling from
the 10,485,760-byte raw-request ceiling used by the exact large-body attack.
Three additional compact records freeze dispatch precedence: unknown action before
schema inspection, schema rejection before state validation, and validator rejection
after a valid schema. All three also pin log-neutral head and digest snapshots.
Scanner records cover escaped `v` keys, duplicate-key last-token behavior, and nested
or textual decoys in accepted/refused pairs. The recovery record proves a valid
operation-id append cannot turn a later raw `v:1.0` request into a recovered 202.
