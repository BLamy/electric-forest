# `@eforest/pr`

Pull-request streams are append-only lifecycle and review logs. `prReducer` keeps the
frozen E5-T02 v1 event shapes valid while reducer version 2 adds one review-only schema:

```json
{
  "type": "pr.review-comment",
  "payload": {
    "v": 2,
    "author": "reviewer",
    "body": "Please cover this branch.",
    "path": "src/example.ts",
    "line": 42
  }
}
```

`line` is optional, one-based, and requires `path`. A v1 review comment remains exact and
reduces to the same state bytes as before; v1 never accepts a `line` field.

`derivePrIndex` folds PR logs into the disposable repository index projection. The index
can be rebuilt from its cataloged source logs. `computeSinceForkDiff` is the sole canonical
tree differ and `prDiffDigest` hashes that result for DOM and verifier parity; UI renderers
such as `@pierre/diffs` are presentation-only.
