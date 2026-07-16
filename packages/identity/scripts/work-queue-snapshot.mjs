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

function directParents(oid) {
  return git("rev-list", "--parents", "-n", "1", oid).trim().split(" ").slice(1);
}

const sourceParents = transitionBaseCommit === null ? [] : directParents(sourceCommit);
const transitionBaseIsDirectParent =
  transitionBaseCommit === null
    ? null
    : sourceParents.length === 1 && sourceParents[0] === transitionBaseCommit;

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

function attestRecovery() {
  if (!taskId || !taskPath) return null;
  const request = snapshotModule.recoveryRequest(readmeText, { taskId });
  if (request === null) return null;
  const resumeCommit = commit(request.resumeCommit);
  const invalidLoopCommit = commit(request.invalidLoopCommit);
  if (resumeCommit !== request.resumeCommit || invalidLoopCommit !== request.invalidLoopCommit) {
    throw new Error("recovery commit references must resolve exactly");
  }
  if (
    directParents(resumeCommit).length !== 1 ||
    directParents(resumeCommit)[0] !== invalidLoopCommit
  ) {
    throw new Error("recovery commit must directly follow its invalid-loop stop");
  }
  git("merge-base", "--is-ancestor", resumeCommit, sourceCommit);

  const invalidProject = JSON.parse(git("show", `${invalidLoopCommit}:.eforest/project.json`));
  if (invalidProject.status !== "invalid_loop") {
    throw new Error("recovery parent did not durably record invalid_loop");
  }
  const invalidReadme = git("show", `${invalidLoopCommit}:${taskPath}`);
  const priorLedger = snapshotModule.parseVerificationLedger(invalidReadme, {
    taskId,
    auditStart: taskId === "E2-T01" ? 6 : 3,
  });
  if (priorLedger.runCount !== request.authorizedCeiling - 3) {
    throw new Error("recovery parent does not end at the prior authorized ceiling");
  }
  if (invalidReadme.includes(`verification_run_ceiling: ${request.authorizedCeiling}\n`)) {
    throw new Error("recovery ceiling was already present before human authorization");
  }

  const resumeReadme = git("show", `${resumeCommit}:${taskPath}`);
  if (!resumeReadme.includes(`verification_run_ceiling: ${request.authorizedCeiling}\n`)) {
    throw new Error("recovery commit did not persist the authorized ceiling");
  }
  const resumeEntry = snapshotModule.recoveryEntry(resumeReadme, taskId, request.authorizedCeiling);
  if (resumeEntry.entryDigest !== request.entryDigest) {
    throw new Error("current human-resume entry differs from its authorizing commit");
  }
  const resumeProject = JSON.parse(git("show", `${resumeCommit}:.eforest/project.json`));
  const reason = resumeProject.statusReason;
  if (
    resumeProject.status !== "building" ||
    typeof reason !== "string" ||
    !reason.includes("Human authorized") ||
    !reason.includes(taskId) ||
    !reason.includes(request.date) ||
    !reason.includes(`run ${request.authorizedCeiling}`)
  ) {
    throw new Error("recovery commit lacks its matching project statusReason");
  }
  const resumeChanged = git("diff-tree", "--no-commit-id", "--name-only", "-r", resumeCommit)
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const required of [taskPath, ".eforest/project.json", ".eforest/tasks/QUEUE.md"]) {
    if (!resumeChanged.includes(required)) {
      throw new Error(`recovery commit did not persist ${required}`);
    }
  }
  const resumeQueue = git("show", `${resumeCommit}:.eforest/tasks/QUEUE.md`);
  if (
    snapshotModule.currentGateFromQueue(resumeQueue) !== taskId ||
    snapshotModule.canonicalTaskPath(resumeQueue, taskId) !== taskPath
  ) {
    throw new Error("recovery commit did not reopen the same queue gate");
  }
  return {
    ...request,
    approvalPathsVerified: true,
    ceilingIntroducedVerified: true,
    invalidLoopStatusVerified: true,
    priorRunCount: priorLedger.runCount,
    resumeAncestorVerified: true,
    resumeParentVerified: true,
    sameGateVerified: true,
    statusReasonDigest: snapshotModule.sha256(reason),
    statusReasonVerified: true,
  };
}

const recoveryAuthorization = attestRecovery();

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
      transitionBaseIsDirectParent,
      changedPaths,
      recoveryAuthorization,
      resolvePath,
      commitExists,
    }),
  )}\n`,
);
