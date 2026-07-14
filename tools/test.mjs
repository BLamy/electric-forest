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

if (existsSync("packages/streamfs/package.json")) {
  const streamFsBuild = spawnSync("pnpm", ["--filter", "@eforest/streamfs", "build"], {
    stdio: "inherit",
    shell: true,
  });
  if (streamFsBuild.status !== 0) process.exit(streamFsBuild.status ?? 1);

  const cliBuild = spawnSync("pnpm", ["--filter", "@eforest/cli", "build"], {
    stdio: "inherit",
    shell: true,
  });
  if (cliBuild.status !== 0) process.exit(cliBuild.status ?? 1);
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
  env: { ...process.env, EFOREST_TEST_PREBUILT: "1" },
});
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);

if (existsSync("packages/streamfs/package.json")) {
  const build = spawnSync("pnpm", ["build"], { stdio: "inherit", shell: true });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

process.exit(0);
