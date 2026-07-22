#!/usr/bin/env node
// E2-T08 restart-proof worker: runs the full platform stack (official store on
// a data dir + identity + namespace dispatcher + registry projector + gateway)
// until killed. With --seed it first builds the golden lifecycle tree through
// the real dispatch door. Prints one E2_T08_READY line with its URLs.
import { buildLifecycleTree, startPlatformFixture } from "./e2_t08_lib.mjs";

const [dataDir, keyFile, ...flags] = process.argv.slice(2);
if (!dataDir || !keyFile) {
  process.stderr.write("usage: e2_t08_server_worker.mjs <data-dir> <key-file> [--seed]\n");
  process.exit(2);
}
const fixture = await startPlatformFixture({ dataDir, keyFile });
if (flags.includes("--seed")) await buildLifecycleTree(fixture);
process.stdout.write(
  `E2_T08_READY ${JSON.stringify({ url: fixture.baseUrl, officialUrl: fixture.officialUrl, pid: process.pid })}\n`,
);
// Hold the store open until the parent kills this process.
await new Promise(() => {});
