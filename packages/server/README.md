# `@eforest/server`

This package exposes Electric's published `@durable-streams/server` test server for local
development and end-to-end tests. It contains no stream protocol implementation of its own.

Product behavior belongs above this boundary. Production points at Electric Cloud; local runs
use the same published Durable Streams implementation through `createDurableStreamTestServer`.
