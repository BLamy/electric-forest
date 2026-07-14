# @eforest/protocol v1

This package freezes electric-forest's protocol evidence primitives at
`PROTOCOL_VERSION = 1`. Changing the event envelope, canonical encoding, offset
semantics, or digest recipe requires a protocol-version bump and regeneration of every
committed golden fixture.

Canonical JSON recursively sorts object keys by JavaScript UTF-16 code-unit order and
emits no whitespace. Strings use `JSON.stringify`, including deterministic escaped lone
surrogates. Finite numbers use ECMAScript `Number::toString`; safe integers have no
exponent, and `-0` becomes `0`. `undefined`, functions, symbols, bigint, non-finite
numbers, and cycles throw `CanonicalJsonError` wherever they occur.

Offsets are opaque branded strings. Non-sentinel offsets are compared only with plain
lexicographic string comparison; clients never parse or fabricate them. `-1` is the
reserved before-first sentinel and is ordered before every non-sentinel offset. The
authority-only `offset-allocation` subpath is for the stream server to allocate its own
monotone positions; it is not a client offset parser.
