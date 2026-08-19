# Issue event model

Issue streams use `issue:<org>/<repo>/<opaque-issue-id>`. Version 1 has seven
actions: `opened`, `commented`, `labeled`, `unlabeled`, `state-changed`, `closed`,
and `reopened`; every payload contains `v: 1`. The reducer state is the frozen
canonical shape `{v, issueId, title, body, state, labels, comments}`. The
`WORKFLOW_TRANSITIONS` export is the sole transition table and is consumed by
both the reducer-facing validator and callers.

The exhaustive matrix is:

| state       | opened | commented   | labeled     | unlabeled   | state-changed              | closed | reopened |
| ----------- | ------ | ----------- | ----------- | ----------- | -------------------------- | ------ | -------- |
| open        | refuse | open        | open        | open        | any other non-closed state | closed | refuse   |
| in-progress | refuse | in-progress | in-progress | in-progress | any other non-closed state | closed | refuse   |
| done        | refuse | done        | done        | done        | any other non-closed state | refuse | open     |
| closed      | refuse | closed      | closed      | closed      | refuse                     | refuse | open     |
| wont-do     | refuse | wont-do     | wont-do     | wont-do     | any other non-closed state | refuse | open     |

`state-changed` additionally refuses self-transitions and `to: closed`; label,
unlabel, and comment uniqueness are validator checks, not reducer side effects.

`issue-reducer.mjs` is the offline adapter:

```sh
ef replay <dump> --digest --reducer packages/platform/issues-reducer.mjs
```

Epic 6 may add event types only with an envelope version bump and regenerated
goldens. Browser evidence is intentionally not applicable to this server/library
module; the browser write path is E5-T04.
