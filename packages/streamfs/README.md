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
leaving the source stream unchanged. Snapshots are append-only application checkpoints; physical
retention remains Electric's responsibility.

## Verification

Run `make _v-official-streamfs`. The target starts Electric's published reference server and
proves CRUD, deterministic reduction, snapshots, live watch delivery, native branches,
fast-forward merge, refusal behavior, and concurrent writer fencing.
