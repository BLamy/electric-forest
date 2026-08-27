# Meadow contracts

<!-- frozen:E5-T08:branch-provisioning -->

Every repository's wiki is the ordinary stream-fs branch named `wiki`. Its metadata
stream id is `fs:<org>/<repo>:wiki:meta`, derived with the E1-T08 stream-fs branch-id
helper from E2-T06's `fs:<org>/<repo>` repo prefix. `ensureWikiBranch(org, repo)` is
bound to an injected authenticated door: it inspects through the existing authorized
read surface and creates the missing branch only by sending the standard
`fs.branch.genesis { v: 1, branch: "wiki" }` action through `/api/dispatch`. The branch
starts with an empty reduced tree at its own offset zero. It is parentless and is never
forked from `main`. A valid existing wiki branch is returned unchanged; a second call
appends nothing and returns the same stream id. Meadow owns no transport, route,
reducer, persistence, cache, or alternate write path.
<!-- /frozen:E5-T08:branch-provisioning -->

<!-- frozen:E5-T08:slug-path -->

A wiki page is one UTF-8 markdown file named `{slug}.md` at the wiki branch root.
Slugs match `[a-z0-9][a-z0-9-]*` exactly. There is no normalization. Uppercase,
leading hyphens, empty slugs, separators, and nested directories are refused by
Meadow's slug/path helper; the frozen grammar permits a trailing hyphen. The server has
no wiki-specific path rule:
foreign stream-fs tools may write any valid tree, while wiki consumers select only
root-level files matching this convention.
<!-- /frozen:E5-T08:slug-path -->

<!-- frozen:E5-T08:routes -->

The wiki index route is `/orgs/:org/repos/:repo/wiki`. The page route is
`/orgs/:org/repos/:repo/wiki/:slug`. The editor route is
`/orgs/:org/repos/:repo/wiki/:slug/edit`. These are consumer contracts only;
`@eforest/meadow` adds no server route.
<!-- /frozen:E5-T08:routes -->
