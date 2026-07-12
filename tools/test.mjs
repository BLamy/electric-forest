import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = process.argv.slice(2);

if (existsSync("packages/client/package.json")) {
  const protocolBuild = spawnSync("pnpm", ["--filter", "@eforest/protocol", "build"], {
    stdio: "inherit",
    shell: true,
  });
  if (protocolBuild.status !== 0) process.exit(protocolBuild.status ?? 1);

  const clientBuild = spawnSync("pnpm", ["--filter", "@eforest/client", "build"], {
    stdio: "inherit",
    shell: true,
  });
  if (clientBuild.status !== 0) process.exit(clientBuild.status ?? 1);
}

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
