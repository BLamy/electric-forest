import { execFileSync } from "node:child_process";

const SCRIPT_PATH = "packages/identity/scripts/work-queue-snapshot.mjs";
const LIBRARY_PATH = "packages/identity/scripts/work-queue-snapshot-lib.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`);
  return process.argv[index + 1];
}

function commit(ref) {
  return git("rev-parse", "--verify", `${ref}^{commit}`).trim();
}

const requestedTaskId = argument("--task", undefined);
const attesterSourceCommit = commit(argument("--attester", "HEAD"));
const sourceCommit = commit(argument("--source", "HEAD"));
const transitionBaseRef = argument("--base", undefined);
const transitionBaseCommit = transitionBaseRef === undefined ? null : commit(transitionBaseRef);

// The workflow pipes this CLI from `git show <trusted-commit>:<SCRIPT_PATH>`. Its only
// dependency is loaded from that same attester commit, never from the warm worktree or
// the newly-written source commit being inspected.
const cliSource = git("show", `${attesterSourceCommit}:${SCRIPT_PATH}`);
const librarySource = git("show", `${attesterSourceCommit}:${LIBRARY_PATH}`);
const snapshotModule = await import(
  `data:text/javascript;base64,${Buffer.from(librarySource).toString("base64")}`
);

const controlFiles = snapshotModule.CONTROL_PATHS.map((path) => [
  path,
  snapshotModule.sha256(git("show", `${sourceCommit}:${path}`)),
]);
const controlDigest = snapshotModule.sha256(JSON.stringify(controlFiles));
const attesterDigest = snapshotModule.sha256(
  JSON.stringify([
    [SCRIPT_PATH, snapshotModule.sha256(cliSource)],
    [LIBRARY_PATH, snapshotModule.sha256(librarySource)],
  ]),
);
const changedPaths =
  transitionBaseCommit === null
    ? []
    : git("diff", "--name-only", transitionBaseCommit, sourceCommit, "--")
        .trim()
        .split("\n")
        .filter(Boolean);

const queueText = git("show", `${sourceCommit}:.eforest/tasks/QUEUE.md`);
const projectText = git("show", `${sourceCommit}:.eforest/project.json`);
const taskId = requestedTaskId ?? snapshotModule.currentGateFromQueue(queueText);
const taskPath = taskId ? snapshotModule.canonicalTaskPath(queueText, taskId) : null;
const readmeText = taskPath ? git("show", `${sourceCommit}:${taskPath}`) : "";

function resolvePath(ref) {
  const match = /^([A-Za-z0-9_.\/-]+)(?::(\d+)(?:-(\d+))?)?$/.exec(ref);
  if (!match || !snapshotModule.isSafeRepoPath(match[1])) return false;
  try {
    const text = git("show", `${sourceCommit}:${match[1]}`);
    if (match[2] === undefined) return true;
    const start = Number(match[2]);
    const end = match[3] === undefined ? start : Number(match[3]);
    const lineCount = snapshotModule.addressableLineCount(text);
    return start >= 1 && end >= start && end <= lineCount;
  } catch {
    return false;
  }
}

function commitExists(oid) {
  try {
    git("cat-file", "-e", `${oid}^{commit}`);
    git("merge-base", "--is-ancestor", oid, sourceCommit);
    return true;
  } catch {
    return false;
  }
}

process.stdout.write(
  `${JSON.stringify(
    snapshotModule.buildWorkQueueSnapshot({
      projectText,
      queueText,
      readmeText,
      sourceCommit,
      requestedTaskId,
      attesterSourceCommit,
      attesterDigest,
      controlDigest,
      transitionBaseCommit,
      changedPaths,
      resolvePath,
      commitExists,
    }),
  )}\n`,
);
