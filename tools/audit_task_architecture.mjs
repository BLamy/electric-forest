import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = process.cwd();
const tasksRoot = resolve(process.env.EFOREST_TASKS_ROOT ?? join(root, ".eforest", "tasks"));
const activeStatuses = new Set(["pending", "in-progress", "implemented", "refuted"]);

const retiredContracts = [
  ["retired custom server package", /packages\/stream-server/g],
  ["retired protocol-conformance package", /packages\/conformance/g],
  ["retired server reducer hook", /useServerReducer/g],
  ["retired repo-local OIDC package", /@eforest\/oidc-emulator/g],
  ["retired stream dispatch endpoint", /POST \/streams\/(?:\{id\}|:id)\/dispatch/g],
  ["retired stream state endpoint", /GET \/streams\/(?:\{id\}|:id)\/state/g],
  ["retired events endpoint", /GET \/events/g],
  ["retired generic state endpoint", /`\/state`/g],
  ["retired generic events endpoint", /`\/events`/g],
  ["retired generic dispatch endpoint", /(?<!api)\/dispatch/g],
  ["retired custom persistence task", /file-backed durable-stream server/gi],
  ["retired stub transport", /stub Durable Streams service/gi],
];

function taskReadmes() {
  const paths = [];
  for (const epic of readdirSync(tasksRoot, { withFileTypes: true })) {
    if (!epic.isDirectory() || !epic.name.startsWith("epic-")) continue;
    const epicPath = join(tasksRoot, epic.name);
    for (const task of readdirSync(epicPath, { withFileTypes: true })) {
      if (!task.isDirectory() || !/^E[0-9.]+-T[0-9]+[ab]?-/.test(task.name)) continue;
      const readme = join(epicPath, task.name, "readme.md");
      if (existsSync(readme)) paths.push(readme);
    }
  }
  return paths;
}

function frontmatterValue(source, key) {
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!frontmatter) return undefined;
  return frontmatter[1]
    .split("\n")
    .find((line) => line.startsWith(`${key}:`))
    ?.slice(key.length + 1)
    .trim();
}

const findings = [];

for (const path of taskReadmes()) {
  const source = readFileSync(path, "utf8");
  const status = frontmatterValue(source, "status");
  const contractSource = source.split("\n## Verification log", 1)[0];
  if (!status || !activeStatuses.has(status)) continue;

  for (const [label, pattern] of retiredContracts) {
    for (const match of contractSource.matchAll(pattern)) {
      const line = contractSource.slice(0, match.index).split("\n").length;
      findings.push(`${relative(root, path)}:${line}: ${label}: ${match[0]}`);
    }
  }
}

if (findings.length > 0) {
  console.error("task architecture audit failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("task architecture audit: active tickets use the official substrate");
