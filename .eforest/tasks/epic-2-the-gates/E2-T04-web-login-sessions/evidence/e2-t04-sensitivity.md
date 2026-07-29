# E2-T04 sensitivity record

The builder apparatus caught two real defects during the recorded implementation loop:

1. DOM offset sabotage equivalent: the page initially exposed the application event
   offset `0000000000000000_0000000000000001`; the independent Durable Streams HEAD was
   `0000000000000000_0000000000000353`. `login.pw.ts` failed literal equality. The store
   now sources `IdentitySnapshot.offset` from `headDurableJsonStream`; restoring the old
   event-offset line makes the browser target red.
2. Expected-refusal console sensitivity: navigating directly to the expired callback
   returned the correct 401 but Replay Chromium emitted a console resource error.
   `login.pw.ts` failed its zero-console assertion. The final run fills and submits the
   real issuer form, captures its fields, performs the exact callback through the guarded
   HTTP path, and renders a neutral browser page; deleting that interception makes the
   zero-console sensor red.

Permanent sensors:

- Changing either DOM attribute to a hard-coded value fails the independent HEAD/CLI
  digest comparisons in `packages/platform/test/login.pw.ts`.
- Mutating any byte in `e2-t04-two-logins.events.jsonl` changes or invalidates the CLI
  digest checked by `make verify-E2-T04`.
- Removing the deny-non-loopback route or guarded fetch allows the `auth0.com` canary and
  fails `e2-t04-network-guard.txt` verification.
- Weakening RS256 to accept `none` or HS256 makes the crypto-confusion matrix fail.
- Adding platform-local session state changes the SIGKILL runtime-directory snapshot and
  fails the restart test.
- Returning a separately fetched HEAD with an older event read fails the controlled
  append-between-read-and-HEAD regression; the bounded read offset must equal the
  confirming HEAD or the snapshot retries.
- Removing the process preload guard allows the `auth0.com/e2-t04-process-canary` fetch
  and fails before the task gate; the committed network log includes the refused attempt.
- Capturing video without its trace changes either SHA-256 in
  `e2-t04-browser-artifacts.json`, breaking the same-session artifact binding.
