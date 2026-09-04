---
title: Getting started
section: Start here
order: 2
summary: Install, build, run the platform, and log in through the emulated Auth0.
---

# Getting started

electric-forest is a pnpm monorepo. Everything below runs on your machine against the
published Durable Streams reference server and an **emulated Auth0** — no cloud account
required.

## Prerequisites

- Node.js 22 or newer
- pnpm 10 (`corepack enable` will pick the pinned version from `package.json`)
- Python 3 (only for `tools/build_queue.py`)

## Install and build

{% stepper %}
{% step %}
Clone the repository, including the pinned emulator submodule.

```sh
git clone --recurse-submodules git@github.com:BLamy/electric-forest.git
cd electric-forest
pnpm install --frozen-lockfile
```

{% endstep %}
{% step %}
Run the build gates in ascending cost. Every claim in this repository passes all four
before it is believed.

```sh
pnpm format:check && pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

{% endstep %}
{% step %}
Start a local Durable Streams server. The platform stores _everything_ here.

```sh
pnpm server:serve
```

{% endstep %}
{% step %}
Open the web app and press **Log in**. The button sends you to `/auth/login`, which
redirects to the Auth0 login page (emulated locally, real Auth0 in production). After
the callback, your session is an event on the identity stream and `/` becomes the
application.
{% endstep %}
{% endstepper %}

{% hint style="warning" %}
The public site — this documentation, the roadmap, and the home page — is served
without a session. Every application route (repositories, trees, pull requests,
issues, wiki) redirects to `/auth/login` until a replayed session exists.
{% endhint %}

## Two ways in

{% tabs %}
{% tab title="Web" %}
Browse to `/` after logging in. The registry lists repositories reduced from the
namespace streams; each repository page projects its branches, tree, files, pull
requests, issues, and wiki live from the log.
{% endtab %}
{% tab title="CLI" %}

```sh
pnpm ef login            # device flow; the grant is an identity event
pnpm ef init --org maple --repo reading-room
pnpm ef status --json
```

See the [ef CLI guide](/docs/guides/ef-cli) for the full command set.
{% endtab %}
{% endtabs %}

## Reproducing what you see

Every rendered region in the app carries three attributes: `data-ef-stream`,
`data-ef-offset`, and `data-ef-digest`. Dump the stream and replay it yourself:

```sh
pnpm ef replay dump.jsonl --digest
```

The digest printed by the CLI equals the digest on the DOM node, byte for byte. That is
the whole evidence story of this project, and it is available to you from the first
page load.
