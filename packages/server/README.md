# `@eforest/server`

This package exposes Electric's upstream `@durable-streams/server` test server for local
development and end-to-end tests. The workspace pins the latest published server and
applies a minimal checked-in provider patch for snapshot compaction and retained-prefix
reads until upstream exposes that capability.

Product behavior belongs above this boundary. Production points at Electric Cloud; local runs
use the upstream Durable Streams implementation, including the pinned retention patch, through
`createDurableStreamTestServer`.
