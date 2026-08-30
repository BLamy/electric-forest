---
id: E9-T02
epic: 9
title: "Complete task: binary evidence, nested paths, and a --- in the body"
priority: 902
status: implemented
depends_on: [E9-T01, E8]
estimate: L
capstone: true
---

## Goal

Text with a horizontal rule below.

---

And another `---` inline, plus a fence hiding headings:

```md
## Goal
## Context
---
```

## Context

~~~
## Deliverables
~~~

```
   ## Not a section (indented heading look-alike inside a fence)
```

## Deliverables

- `evidence/nested/deep/blob.bin` — binary with NUL bytes
- `evidence/.ef/state.json`

## Acceptance criteria

- [ ] `make verify-E9-T02` exits 0
- [ ] digests match: `sha256`

## Adversarial verification

1. Flip a byte in `evidence/nested/deep/blob.bin`; the manifest must change.
2. Section-like text: "## Goal" in prose is not a heading.

## Verification log

### 2026-08-30 — builder — implemented

- `Replay: N/A (fixture)` + mitigation: byte round trip.
