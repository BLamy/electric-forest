# `@eforest/web`

The canopy shell is a static Vite/React bundle served by the authenticated platform
process. It never handles bearer tokens or reads the `ef_session` cookie.

## Frozen stream-region contract

Every DOM root that renders stream-derived state carries the complete triple:

- `data-ef-stream`: authoritative stream name.
- `data-ef-offset`: the exact opaque protocol offset replayed for the rendered state,
  copied byte-for-byte without parsing or fabrication.
- `data-ef-digest`: `stateDigest` of the reduced state at that exact offset.

A partial triple is always invalid. Regions may lag the server head, but the digest must
remain internally consistent with the stated offset.
