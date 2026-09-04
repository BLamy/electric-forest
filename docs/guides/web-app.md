---
title: The web app
section: Guides
order: 1
summary: Routes, surfaces, and the evidence attributes on every region.
---

# The web app

The application at `/` (after login) is a single-page React app served by the platform
process. It renders reducers over live streams; it never carries bearer tokens and never
reads the session cookie.

## Routes

| Route                                           | Surface                                                 |
| ----------------------------------------------- | ------------------------------------------------------- |
| `/`                                             | registry — repositories reduced from namespace streams  |
| `/<org>/<repo>`                                 | repository home: branches, status, README               |
| `/<org>/<repo>/tree/<branch>/<path>`            | tree browser (Pierre Trees over the StreamFS reduction) |
| `/<org>/<repo>/blob/<branch>/<path>`            | file viewer                                             |
| `/<org>/<repo>/history/<branch>`                | the branch's event log, humanized                       |
| `/inspect/<org>/<repo>/<branch>`                | raw stream inspector                                    |
| `/orgs/<org>/repos/<repo>/pulls[/<id>[/<tab>]]` | pull requests — activity, commits, checks, changes      |
| `/orgs/<org>/repos/<repo>/issues[/<id>]`        | issue board and issue detail                            |
| `/orgs/<org>/repos/<repo>/wiki[/<slug>[/edit]]` | wiki pages on the `wiki` branch                         |
| `/orgs/<org>/repos/<repo>/labels`               | label management                                        |
| `/orgs/<org>/repos/<repo>/settings`             | repository settings                                     |
| `/settings/cli-tokens`                          | mint and revoke CLI tokens                              |

The public site — `/home`, `/roadmap`, `/docs` — is served without a session.

## Shared renderers

The product deliberately has one vocabulary per job:

{% tabs %}
{% tab title="Markdown" %}
Every Markdown surface — wiki pages, READMEs, issue bodies and comments, PR bodies and
reviews, evidence descriptions, these docs — renders through one Docstream adapter. The
adapter applies a hostile-input URL policy before rendering; the stream bytes are never
rewritten.
{% endtab %}
{% tab title="Diffs" %}
PR changes, commit changes, and review snippets use `@pierre/diffs`, in unified and
split modes.
{% endtab %}
{% tab title="Trees" %}
Repository roots, nested directories, and changed-file navigation use `@pierre/trees`,
backed only by the StreamFS reduction — no parallel cache.
{% endtab %}
{% tab title="Mobile" %}
At the mobile breakpoint the same routes compose `@brett_lamy/ui` primitives through one
shared adapter. There is no mobile-only data model.
{% endtab %}
{% endtabs %}

## Every region is evidence

Every DOM root that renders stream-derived state carries the complete triple:

- `data-ef-stream` — the authoritative stream name
- `data-ef-offset` — the exact opaque offset replayed for the rendered state
- `data-ef-digest` — the SHA-256 digest of the reduced state at that offset

A partial triple is always invalid. Regions may lag the server head, but the digest must
be internally consistent with the stated offset — and a critic _will_ compare it with
`ef replay --digest`.

{% hint style="info" %}
Open **Stream diagnostics** at the bottom of any page to see the identity stream, its
head offset, and its digest for your own session.
{% endhint %}
