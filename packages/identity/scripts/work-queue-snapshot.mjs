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

function changedPathsFor(oid) {
  return git("diff-tree", "--no-commit-id", "--name-only", "-r", oid)
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

function exactPaths(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify([...expected].sort());
}

function digestList(values) {
  return snapshotModule.sha256(JSON.stringify(values));
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
  const invalidLoopCommit = commit(request.invalidLoopCommit);
  const controlCommit = request.controlCommit === null ? null : commit(request.controlCommit);
  // The lifecycle commit cannot contain its own Git OID. On that one transition the
  // trusted pre-write attester treats the inspected source as the resume commit; every
  // descendant must persist the resulting OID explicitly.
  const resumeCommit = request.resumeCommit === null ? sourceCommit : commit(request.resumeCommit);
  if (
    resumeCommit !== (request.resumeCommit ?? sourceCommit) ||
    invalidLoopCommit !== request.invalidLoopCommit ||
    controlCommit !== request.controlCommit
  ) {
    throw new Error("recovery commit references must resolve exactly");
  }

  if (controlCommit === null) {
    if (
      directParents(resumeCommit).length !== 1 ||
      directParents(resumeCommit)[0] !== invalidLoopCommit
    ) {
      throw new Error("legacy recovery commit must directly follow its invalid-loop stop");
    }
  } else {
    if (
      directParents(controlCommit).length !== 1 ||
      directParents(controlCommit)[0] !== invalidLoopCommit
    ) {
      throw new Error("recovery control commit must directly follow its invalid-loop stop");
    }
    if (
      directParents(resumeCommit).length !== 1 ||
      directParents(resumeCommit)[0] !== controlCommit
    ) {
      throw new Error("recovery lifecycle commit must directly follow its control bridge");
    }
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
  if (priorLedger.runCount !== request.baseRun) {
    throw new Error("recovery stop does not end at the explicitly authorized base run");
  }
  if (request.baseRun === 0 && priorLedger.runCount !== 0) {
    throw new Error("the exact E2-T06 pre-run recovery requires an empty verdict ledger");
  }
  const recoveryGeneration = request.generation ?? 1;
  const exactE2T06SecondRecovery =
    taskId === "E2-T06" &&
    request.baseRun === 0 &&
    request.authorizedCeiling === 3 &&
    recoveryGeneration === 2 &&
    invalidLoopCommit === "441e8372e12aad69a68540cfb0e83be3fdfec114";
  if (
    invalidReadme.includes(`verification_run_ceiling: ${request.authorizedCeiling}\n`) &&
    !exactE2T06SecondRecovery
  ) {
    throw new Error("recovery ceiling was already present before human authorization");
  }
  if (exactE2T06SecondRecovery) {
    const inherited = snapshotModule.recoveryRequest(invalidReadme, { taskId });
    if (
      inherited?.generation !== 1 ||
      inherited.baseRun !== 0 ||
      inherited.authorizedCeiling !== 3 ||
      priorLedger.runCount !== 0
    ) {
      throw new Error("second E2-T06 recovery did not inherit the exact empty-ledger window");
    }
  }

  if (controlCommit !== null) {
    // A control bridge may recognize a frozen historical ledger only by pinning its
    // existing entry digests. The stopped task/project bytes and exact bridge path set
    // remain immutable below.
    const controlProject = JSON.parse(git("show", `${controlCommit}:.eforest/project.json`));
    const controlReadme = git("show", `${controlCommit}:${taskPath}`);
    const controlLedger = snapshotModule.parseVerificationLedger(controlReadme, {
      taskId,
      auditStart: taskId === "E2-T01" ? 6 : 3,
    });
    if (
      controlProject.status !== "invalid_loop" ||
      controlReadme !== invalidReadme ||
      controlLedger.ledgerDigest !== priorLedger.ledgerDigest ||
      !exactPaths(changedPathsFor(controlCommit), snapshotModule.RECOVERY_CONTROL_PATHS)
    ) {
      throw new Error(
        "recovery control bridge changed stopped state or escaped its exact path set",
      );
    }
  }

  const resumeReadme = git("show", `${resumeCommit}:${taskPath}`);
  if (!resumeReadme.includes(`verification_run_ceiling: ${request.authorizedCeiling}\n`)) {
    throw new Error("recovery commit did not persist the authorized ceiling");
  }
  const resumeEntry = snapshotModule.recoveryEntry(
    resumeReadme,
    taskId,
    request.authorizedCeiling,
    request.baseRun,
    recoveryGeneration,
  );
  if (resumeEntry.entryDigest !== request.entryDigest) {
    throw new Error("current human-resume entry differs from its authorizing commit");
  }
  const resumeProject = JSON.parse(git("show", `${resumeCommit}:.eforest/project.json`));
  const reason = resumeProject.statusReason;
  const expectedReason =
    controlCommit === null
      ? null
      : `Human authorized ${taskId} recovery${recoveryGeneration === 1 ? "" : ` ${recoveryGeneration}`} on ${request.date} after run ${request.baseRun}: control-plane transition and verification runs ${request.firstRun}-${request.lastRun} only`;
  if (
    resumeProject.status !== "building" ||
    typeof reason !== "string" ||
    (expectedReason === null
      ? !reason.includes("Human authorized") ||
        !reason.includes(taskId) ||
        !reason.includes(request.date) ||
        !reason.includes(`run ${request.authorizedCeiling}`)
      : reason !== expectedReason)
  ) {
    throw new Error("recovery commit lacks its matching project statusReason");
  }
  const expectedResumePaths =
    controlCommit === null
      ? [
          taskPath,
          ".eforest/project.json",
          ".eforest/tasks/QUEUE.md",
          "AGENTS.md",
          ".eforest/loop.md",
        ]
      : [taskPath, ".eforest/project.json", ".eforest/tasks/QUEUE.md"];
  const actualResumePaths = changedPathsFor(resumeCommit);
  const queueMayBeUnchanged = controlCommit !== null;
  const expectedResumePathsWithoutQueue = expectedResumePaths.filter(
    (path) => path !== ".eforest/tasks/QUEUE.md",
  );
  if (
    !exactPaths(actualResumePaths, expectedResumePaths) &&
    !(queueMayBeUnchanged && exactPaths(actualResumePaths, expectedResumePathsWithoutQueue))
  ) {
    throw new Error("recovery commit escaped its exact lifecycle path set");
  }
  const resumeQueue = git("show", `${resumeCommit}:.eforest/tasks/QUEUE.md`);
  if (
    snapshotModule.currentGateFromQueue(resumeQueue) !== taskId ||
    snapshotModule.canonicalTaskPath(resumeQueue, taskId) !== taskPath
  ) {
    throw new Error("recovery commit did not reopen the same queue gate");
  }
  const resumeLedger = snapshotModule.parseVerificationLedger(resumeReadme, {
    taskId,
    auditStart: taskId === "E2-T01" ? 6 : 3,
  });
  const priorAuditCount = priorLedger.auditEntryDigests.length;
  if (
    resumeLedger.runCount !== request.baseRun ||
    digestList(resumeLedger.runEntryDigests) !== digestList(priorLedger.runEntryDigests) ||
    digestList(resumeLedger.auditEntryDigests.slice(0, priorAuditCount)) !==
      digestList(priorLedger.auditEntryDigests)
  ) {
    throw new Error("recovery lifecycle commit rewrote the stopped verdict or audit prefix");
  }
  const checkpointRequired = request.baseRun > 0 && request.baseRun % 3 === 0;
  const priorCheckpointAudit = priorLedger.audits.find(
    (audit) => audit.lastRun === request.baseRun,
  );
  const checkpointAudit = resumeLedger.audits.find((audit) => audit.lastRun === request.baseRun);
  const checkpointAuditInherited = checkpointRequired && priorCheckpointAudit !== undefined;
  if (
    checkpointAuditInherited &&
    (resumeLedger.auditEntryDigests.length !== priorAuditCount ||
      checkpointAudit?.entryDigest !== priorCheckpointAudit.entryDigest)
  ) {
    throw new Error("recovery rewrote its completed progress checkpoint");
  }
  if (
    checkpointRequired &&
    !checkpointAuditInherited &&
    (resumeLedger.auditEntryDigests.length !== priorAuditCount + 1 ||
      !checkpointAudit ||
      !["death-spiral", "insufficient-evidence"].includes(checkpointAudit.assessment))
  ) {
    throw new Error("human recovery after a failed checkpoint must record its stop assessment");
  }
  if (!checkpointRequired && resumeLedger.auditEntryDigests.length !== priorAuditCount) {
    throw new Error("recovery added an unexpected progress checkpoint");
  }
  return {
    ...request,
    resumeCommit,
    approvalPathsVerified: true,
    ceilingIntroducedVerified: true,
    checkpointAuditInherited,
    checkpointAssessment: checkpointAudit?.assessment ?? null,
    checkpointOverrideVerified: !checkpointRequired || checkpointAudit !== undefined,
    controlParentVerified: controlCommit === null ? null : true,
    historyPrefixVerified: true,
    invalidLoopStatusVerified: true,
    priorRunCount: priorLedger.runCount,
    priorAuditCount,
    priorAuditEntryDigestsDigest: digestList(priorLedger.auditEntryDigests),
    priorLedgerDigest: priorLedger.ledgerDigest,
    priorRunEntryDigestsDigest: digestList(priorLedger.runEntryDigests),
    resumeAuditCount: resumeLedger.auditEntryDigests.length,
    resumeAuditEntryDigestsDigest: digestList(resumeLedger.auditEntryDigests),
    resumeAncestorVerified: true,
    resumeParentVerified: true,
    resumeRunCount: resumeLedger.runCount,
    resumeRunEntryDigestsDigest: digestList(resumeLedger.runEntryDigests),
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
