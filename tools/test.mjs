import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const filterIndex = args.indexOf("--filter");
let testPath;
if (filterIndex >= 0) {
  const filter = args[filterIndex + 1];
  if (filter !== "@eforest/protocol") {
    throw new Error(`unsupported test filter: ${filter ?? "<missing>"}`);
  }
  args.splice(filterIndex, 2);
  testPath = "packages/protocol";
}

const result = spawnSync("vitest", ["run", ...(testPath ? [testPath] : []), ...args], {
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 1);
