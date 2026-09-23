---
title: No database
section: Concepts
order: 3
summary: Why there is no Postgres, and what replaces it.
---

# No database

{% hint style="danger" %}
There is no Postgres, no SQLite, no relational store, no side table anywhere in
electric-forest. The streams **are** the database. This is a hard rule enforced by a
verification target (`tools/verify/e2_t08_no_database.mjs`), not a preference.
{% endhint %}

## What replaces it

| A database would hold…  | electric-forest holds it as…                                        |
| ----------------------- | ------------------------------------------------------------------- |
| users, sessions, tokens | events on the identity stream, reduced to an authorization view     |
| orgs, repos, visibility | events on namespace streams (`ns:org:<org>`)                        |
| the repo list           | a registry derived stream, rebuildable with `ef registry rebuild`   |
| issues, comments        | one stream per issue; the board is a derived stream                 |
| pull requests           | one stream per PR; the catalog is a derived stream                  |
| file contents           | one content stream per file, digest-pinned from the metadata stream |
| evidence                | content streams or reference events attached to their entity        |

## Why

1. **One mechanism.** One dispatch door, one replay path, one subscription mechanism,
   one time-travel story — for source code and issues and PRs and the build loop alike.
2. **Nothing is stored twice.** A database next to the log would be a second source of
   truth that can drift. Here every list view is `reduce(tail(stream))`.
3. **Every bug is an offset.** If a view is wrong, the wrong event is in the log at a
   specific offset, and `ef bisect` will find it.

## What Auth0 does

Auth0 authenticates — it answers "who is this?" and nothing more. The resulting platform
user record, org memberships, sessions, and CLI grants are events on identity streams.
Locally the platform runs against a pinned Auth0 **emulator** so the full login flow —
PKCE, authorization code, callback, session cookie — is exercised without a network.

{% expandable title="How the session gate works" %}
The served web shell is gated by a signed `ef_session` cookie whose session id must
exist as an unrevoked event on the identity stream. The client never reads the cookie;
the server stamps a single `<meta name="ef-session">` marker into the shell so `/` can
render the application instead of the public landing page.
{% endexpandable %}
