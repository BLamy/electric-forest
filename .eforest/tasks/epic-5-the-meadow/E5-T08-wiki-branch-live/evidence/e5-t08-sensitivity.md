# E5-T08 causal sensitivity transcripts

Each case ran against a scratch worktree or copied evidence. Exit zero would fail this verifier.

## mutation=forced-full-write expected=canonical patch chooser assertion

- command: `pnpm exec vitest run --maxWorkers=1 apps/web/src/wiki/useWiki.test.ts`
- exit: `1` (precisely expected: nonzero)
- observed assertion: `AssertionError: canonical-patch-chooser: expected 'fs.file.write' to be 'fs.file.patch' // Object.is equality`
- mutation=forced-full-write expected=canonical patch chooser assertion EXPECTED-FAIL OK

## mutation=optimistic-local-apply expected=no visible edited content before dispatch acknowledgement

- command: `/opt/homebrew/Cellar/node/23.11.0/bin/node --experimental-strip-types apps/web/test/wiki.pw.ts`
- exit: `1` (precisely expected: nonzero)
- observed assertion: `AssertionError [ERR_ASSERTION]: no-optimistic-visible-content-before-dispatch-ack`
- mutation=optimistic-local-apply expected=no visible edited content before dispatch acknowledgement EXPECTED-FAIL OK

## mutation=stripped-base expected=caller base revision assertion

- command: `pnpm exec vitest run --maxWorkers=1 apps/web/src/wiki/useWiki.test.ts`
- exit: `1` (precisely expected: nonzero)
- observed assertion: `AssertionError: caller-base-revision: expected 'BASE_NONE' to be '0000000000000000_0000000000000008' // Object.is equality`
- mutation=stripped-base expected=caller base revision assertion EXPECTED-FAIL OK

## mutation=unsanitized-renderer expected=hostile sanitizer assertion

- command: `pnpm exec vitest run --maxWorkers=1 apps/web/src/wiki/renderMarkdown.test.ts`
- exit: `1` (precisely expected: nonzero)
- observed assertion: `AssertionError: hostile-sanitizer-removes-active-markup: expected '# Safe heading\n\n<script>globalThis.…' not to match /<\/?(?…/?(?:script|iframe|object|svg)\b`
- mutation=unsanitized-renderer expected=hostile sanitizer assertion EXPECTED-FAIL OK

## mutation=corrupted-golden expected=independent replay matches committed golden

- command: `E5_T08_EVIDENCE_DIR=<corrupted-copy> node tools/verify/e5_t08_evidence.mjs`
- exit: `1` (precisely expected: nonzero)
- observed assertion: `AssertionError [ERR_ASSERTION]: independent replay matches committed golden`
- mutation=corrupted-golden expected=independent replay matches committed golden EXPECTED-FAIL OK

E5_T08_SENSITIVITY_OK cases=5
