# E0-T05 curl transcript

This machine-readable transcript is replayed against a fresh in-memory server by
`tools/verify/replay_transcript.sh`. The stream id is fixed so every offset, header, and
body is deterministic. The transcript intentionally includes successful, conflict,
malformed, offset, and missing-stream paths.

```json
[
  {
    "name": "create",
    "request": { "method": "PUT", "path": "/streams/transcript", "headers": { "content-type": "application/json" }, "body": { "name": "transcript", "version": 1 } },
    "expect": { "status": 201, "headers": { "content-type": "application/json; charset=utf-8" }, "body": "{\"created\":true,\"head\":\"-1\",\"stream\":\"transcript\",\"streamSeq\":-1}" }
  },
  {
    "name": "idempotent",
    "request": { "method": "PUT", "path": "/streams/transcript", "headers": { "content-type": "application/json" }, "body": { "name": "transcript", "version": 1 } },
    "expect": { "status": 200, "headers": { "content-type": "application/json; charset=utf-8" }, "body": "{\"created\":false,\"head\":\"-1\",\"stream\":\"transcript\",\"streamSeq\":-1}" }
  },
  {
    "name": "create-conflict",
    "request": { "method": "PUT", "path": "/streams/transcript", "headers": { "content-type": "application/json" }, "body": { "name": "transcript", "version": 2 } },
    "expect": { "status": 409, "headers": { "content-type": "application/json; charset=utf-8" }, "body": "{\"error\":\"stream_config_conflict\",\"message\":\"stream transcript already exists with a different configuration\"}" }
  },
  {
    "name": "append",
    "request": { "method": "POST", "path": "/streams/transcript", "headers": { "content-type": "application/json", "stream-seq": "0" }, "body": { "events": [ { "type": "set", "payload": 2, "ts": 1 }, { "type": "push", "payload": "first", "ts": 2 } ] } },
    "expect": { "status": 201, "headers": { "content-type": "application/json; charset=utf-8", "stream-seq": "0" }, "body": "{\"events\":[{\"offset\":\"0000000000000000_0000000000000000\",\"type\":\"set\",\"payload\":2,\"ts\":1},{\"offset\":\"0000000000000000_0000000000000001\",\"type\":\"push\",\"payload\":\"first\",\"ts\":2}],\"head\":\"0000000000000000_0000000000000001\",\"streamSeq\":0}" }
  },
  {
    "name": "sequence-replay",
    "request": { "method": "POST", "path": "/streams/transcript", "headers": { "content-type": "application/json", "stream-seq": "0" }, "body": { "events": [ { "type": "set", "payload": 2, "ts": 1 } ] } },
    "expect": { "status": 409, "headers": { "content-type": "application/json; charset=utf-8", "stream-seq": "0" }, "body": "{\"error\":\"stream_sequence_conflict\",\"message\":\"stream sequence 0 is current\"}" }
  },
  {
    "name": "read-all",
    "request": { "method": "GET", "path": "/streams/transcript?offset=-1" },
    "expect": { "status": 200, "headers": { "content-type": "application/json; charset=utf-8", "stream-next-offset": "0000000000000000_0000000000000001" }, "body": "[{\"offset\":\"0000000000000000_0000000000000000\",\"type\":\"set\",\"payload\":2,\"ts\":1},{\"offset\":\"0000000000000000_0000000000000001\",\"type\":\"push\",\"payload\":\"first\",\"ts\":2}]" }
  },
  {
    "name": "read-mid",
    "request": { "method": "GET", "path": "/streams/transcript?offset=0000000000000000_0000000000000000" },
    "expect": { "status": 200, "headers": { "content-type": "application/json; charset=utf-8", "stream-next-offset": "0000000000000000_0000000000000001" }, "body": "[{\"offset\":\"0000000000000000_0000000000000001\",\"type\":\"push\",\"payload\":\"first\",\"ts\":2}]" }
  },
  {
    "name": "read-prefix",
    "request": { "method": "GET", "path": "/streams/transcript?offset=0000000000000000_000000000000000" },
    "expect": { "status": 200, "headers": { "content-type": "application/json; charset=utf-8", "stream-next-offset": "0000000000000000_0000000000000001" }, "body": "[{\"offset\":\"0000000000000000_0000000000000000\",\"type\":\"set\",\"payload\":2,\"ts\":1},{\"offset\":\"0000000000000000_0000000000000001\",\"type\":\"push\",\"payload\":\"first\",\"ts\":2}]" }
  },
  {
    "name": "read-past-head",
    "request": { "method": "GET", "path": "/streams/transcript?offset=9999999999999999_9999999999999999" },
    "expect": { "status": 200, "headers": { "content-type": "application/json; charset=utf-8", "stream-next-offset": "0000000000000000_0000000000000001" }, "body": "[]" }
  },
  {
    "name": "read-malformed",
    "request": { "method": "GET", "path": "/streams/transcript?offset=-2" },
    "expect": { "status": 400, "headers": { "content-type": "application/json; charset=utf-8" }, "body": "{\"error\":\"invalid_request\",\"message\":\"offset must be -1 or an opaque numeric position\"}" }
  },
  {
    "name": "read-empty-offset",
    "request": { "method": "GET", "path": "/streams/transcript?offset=" },
    "expect": { "status": 400, "headers": { "content-type": "application/json; charset=utf-8" }, "body": "{\"error\":\"invalid_request\",\"message\":\"offset must be -1 or an opaque numeric position\"}" }
  },
  {
    "name": "missing",
    "request": { "method": "GET", "path": "/streams/missing?offset=-1" },
    "expect": { "status": 404, "headers": { "content-type": "application/json; charset=utf-8" }, "body": "{\"error\":\"stream_not_found\",\"message\":\"stream missing does not exist\"}" }
  },
  {
    "name": "malformed-body",
    "request": { "method": "POST", "path": "/streams/transcript", "headers": { "content-type": "application/json", "stream-seq": "1" }, "body": { "events": [ { "type": "accepted", "payload": true, "ts": 3 }, { "type": "broken" } ] } },
    "expect": { "status": 400, "headers": { "content-type": "application/json; charset=utf-8" }, "body": "{\"error\":\"invalid_event\",\"message\":\"event 1 is not a valid protocol envelope\"}" }
  },
  {
    "name": "wrong-content-type",
    "request": { "method": "POST", "path": "/streams/transcript", "headers": { "content-type": "text/plain", "stream-seq": "1" }, "body": "{\"events\":[{\"type\":\"set\",\"payload\":2,\"ts\":1}]}" },
    "expect": { "status": 400, "headers": { "content-type": "application/json; charset=utf-8" }, "body": "{\"error\":\"invalid_request\",\"message\":\"content type must be application/json\"}" }
  },
  {
    "name": "dump",
    "request": { "method": "GET", "path": "/streams/transcript/dump" },
    "expect": { "status": 200, "headers": { "content-type": "application/x-ndjson; charset=utf-8", "stream-next-offset": "0000000000000000_0000000000000001" }, "body": "{\"offset\":\"0000000000000000_0000000000000000\",\"payload\":2,\"ts\":1,\"type\":\"set\"}\n{\"offset\":\"0000000000000000_0000000000000001\",\"payload\":\"first\",\"ts\":2,\"type\":\"push\"}\n" }
  }
]
```
