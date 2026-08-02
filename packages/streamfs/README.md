# `@eforest/streamfs`

StreamFS is electric-forest's repository filesystem application layer. It stores canonical
filesystem events in JSON streams provided by Electric Durable Streams; it does not implement a
stream server or transport.

## Runtime boundary

- `@durable-streams/client` owns HTTP, opaque read cursors, live delivery, and writer coordination.
- `@durable-streams/server` supplies the local/CI reference process.
- Electric Cloud supplies the deployed process.
- StreamFS owns file and directory events, deterministic reduction, application offsets, content
  integrity, patches, snapshots, branches, merges, and watch-event mapping.

Application offsets are canonical fields inside each JSON item. They are independent from
Electric's opaque transport cursor and are also used as lexicographically ordered `Stream-Seq`
values for compare-and-append coordination.

## Usage

```ts
import { StreamFs } from "@eforest/streamfs";

const fs = new StreamFs({ baseUrl: "http://127.0.0.1:4321" });
const repo = await fs.createRepo("demo");

await repo.mkdir("src");
await repo.createFile("src/index.ts", new TextEncoder().encode("export {};\n"));
await repo.writeFile("src/index.ts", new TextEncoder().encode("export const n = 1;\n"));

console.log(await repo.list());
console.log(await repo.digest());
```

`repo.watch()` uses the official live-read modes. `repo.createBranch()` uses Electric's native
fork protocol at the current head. `mergeFastForward()` stores one application merge event while
leaving the source stream unchanged. `planThreeWayMerge()` reconstructs the fork base plus both
heads and deterministically composes disjoint text patches. `applyThreeWayMerge()` submits the
staged changes, explicit conflicts, and terminal `fs.branch.merge` in one official Durable Streams
request fenced at the first planned application offset. Overlaps, binary changes, full-write
edits, delete/edit, divergent renames, and add/add cases stay on the target as unresolved
`fs/merge-conflict` records until `resolveMergeConflict()` records the chosen current state.
Snapshots are append-only application checkpoints; physical retention remains Electric's
responsibility.

## Verification

Run `make _v-official-streamfs`. The target starts Electric's published reference server and
proves CRUD, deterministic reduction, snapshots, live watch delivery, native branches,
fast-forward and three-way merge, explicit conflict resolution, refusal behavior, and both
concurrent writer/merge schedules.

## Worktree digest (version 1)

`WORKTREE_DIGEST_VERSION = 1` freezes the local comparison recipe used by Epic 4:

```text
projection = { files: { path: { contentSha256, size } } }
worktreeDigest(state) = stateDigest(projection)
```

`contentSha256` is the lowercase hexadecimal SHA-256 of the exact file bytes and `size` is
the byte length. Object keys are encoded by the protocol's canonical JSON encoder. The
projection intentionally excludes exactly one StreamFS field, the session-scoped
`contentStreamId`; all other tree bookkeeping (`dirs`, tombstones, offsets, and merge
metadata) is excluded because a local worktree cannot reproduce it. A version bump and
regeneration of every Epic-4 golden is required if this recipe changes.

`ef tree-digest` walks sorted, slash-separated NFC paths and hashes bytes only. It ignores
only the worktree-root `.ef/` directory. A nested `sub/.ef/` is ordinary content and enters
the projection. Empty directories are not represented by the content projection, so adding
or removing an otherwise empty directory leaves the digest unchanged. Filesystem metadata
(mtime, mode, owner, inode, umask, locale, timezone, and readdir order) is a documented
carve-out and never affects the digest. On case-sensitive filesystems, case-distinct names
are distinct canonical paths; on a case-insensitive filesystem the host cannot construct
two such entries, so the one entry the filesystem exposes is measured. Symlinks, FIFOs,
sockets, devices, unreadable entries, and non-NFC names are typed refusals: the command
exits nonzero, prints no digest on stdout, and names the offending path on stderr.
