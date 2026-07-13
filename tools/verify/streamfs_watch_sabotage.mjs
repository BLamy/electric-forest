import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { relative, resolve, sep, join } from "node:path";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const evidenceRoot = join(
  repoRoot,
  ".eforest/tasks/epic-1-the-trunk/E1-T05-watch-chokidar/evidence",
);
const recordRun = process.argv.includes("--record");
const workRoot = mkdtempSync(join(tmpdir(), "eforest-e1-t05-sabotage-"));

function artifactPath(name) {
  return recordRun ? join(evidenceRoot, name) : join(workRoot, `generated-${name}`);
}

function writeArtifact(name, content) {
  const path = artifactPath(name);
  writeFileSync(path, content);
  if (recordRun) return;
  const committed = readFileSync(join(evidenceRoot, name));
  if (Buffer.compare(committed, Buffer.from(content)) !== 0) {
    throw new Error(`sabotage evidence differs from committed report: ${name}`);
  }
}

function copyRepo() {
  const scratch = mkdtempSync(join(workRoot, "repo-"));
  cpSync(repoRoot, scratch, {
    recursive: true,
    filter(source) {
      const relativePath = relative(repoRoot, source);
      if (relativePath.length === 0) return true;
      const parts = relativePath.split(sep);
      return !parts.includes(".git") && !parts.includes("node_modules") && !parts.includes("dist");
    },
  });
  return scratch;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal,
    timedOut: result.error?.code === "ETIMEDOUT",
    outputTail: output.slice(-2_000),
  };
}

function summarize(result) {
  const failure = result.timedOut
    ? "timeout"
    : result.outputTail
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("Error:") || line.startsWith("FAIL ")) ??
      (result.status === 0 ? "none" : "nonzero exit");
  return {
    command: result.command,
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    failure,
  };
}

function mutate(scratch, mutation) {
  const path = join(scratch, mutation.file);
  const source = readFileSync(path, "utf8");
  const occurrences = source.split(mutation.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`${mutation.name}: expected one mutation target, found ${occurrences}`);
  }
  writeFileSync(path, source.replace(mutation.find, mutation.replace));
}

const mutations = [
  {
    name: "patch-as-add",
    file: "packages/streamfs/src/watch.ts",
    find: 'events.push(watchRecord("change", fsEvent.payload.path, offset));',
    replace: 'events.push(watchRecord("add", fsEvent.payload.path, offset));',
    verify: ["node", "tools/verify/streamfs_watch.mjs"],
  },
  {
    name: "swap-rename-order",
    file: "packages/streamfs/src/watch.ts",
    find: "sort((left, right) => deepestFirst(left[0], right[0]) || lexical(left[1], right[1]));",
    replace: "sort((left, right) => lexical(left[0], right[0]) || lexical(left[1], right[1]));",
    verify: ["node", "tools/verify/streamfs_watch.mjs"],
  },
  {
    name: "resume-replays-prefix",
    file: "packages/streamfs/src/watch.ts",
    find: `const pending = mapped.events.filter(
          (record) => compareOffsets(record.offset, this.from.offset) > 0,
        );`,
    replace: "const pending = mapped.events;",
    verify: ["node", "tools/verify/streamfs_watch.mjs"],
  },
  {
    name: "root-filter-leak",
    file: "packages/streamfs/src/watch.ts",
    find: 'return root === "." || root.length === 0 || path === root || path.startsWith(`${root}/`);',
    replace: "return true;",
    verify: ["pnpm", "--silent", "exec", "vitest", "run", "packages/streamfs/test/watch.test.ts"],
  },
];

const report = [];
try {
  for (const mutation of mutations) {
    const scratch = copyRepo();
    try {
      mutate(scratch, mutation);
      const install = run("pnpm", ["install", "--offline", "--frozen-lockfile"], scratch);
      if (install.status !== 0) {
        throw new Error(`${mutation.name}: scratch install failed\n${install.outputTail}`);
      }
      const build = run("pnpm", ["build"], scratch);
      if (build.status !== 0) {
        throw new Error(`${mutation.name}: mutation did not compile\n${build.outputTail}`);
      }
      const verification = run(mutation.verify[0], mutation.verify.slice(1), scratch);
      const expectedRed = verification.status !== 0;
      if (!expectedRed) {
        throw new Error(`${mutation.name}: verifier stayed green under a real implementation mutation`);
      }
      report.push({
        name: mutation.name,
        file: mutation.file,
        install: { status: install.status },
        build: { status: build.status },
        verification: summarize(verification),
        expectedRed,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  writeArtifact("e1-t05-sabotage.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}
