import { createHash } from "node:crypto";

const TASK_ID = /^E\d+-T\d+$/;
const COMMIT_OID = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export const SNAPSHOT_SCRIPT_PATH = "packages/identity/scripts/work-queue-snapshot.mjs";
export const SNAPSHOT_LIBRARY_PATH = "packages/identity/scripts/work-queue-snapshot-lib.mjs";
export const CONTROL_PATHS = [
  "AGENTS.md",
  ".eforest/loop.md",
  ".claude/workflows/implement-task.js",
  ".claude/workflows/work-queue.js",
  ".claude/workflows/verify-task.js",
  "tools/build_queue.py",
  SNAPSHOT_SCRIPT_PATH,
  SNAPSHOT_LIBRARY_PATH,
  "packages/identity/scripts/verify-work-queue-policy.mjs",
];

// A human-authorized recovery may need to repair the measuring apparatus before the
// stopped project can be reopened. That bridge is deliberately smaller than the full
// control root and is attested as an exact path set, never as a contains-all allowlist.
export const RECOVERY_CONTROL_PATHS = [
  ".claude/workflows/work-queue.js",
  ".eforest/loop.md",
  "AGENTS.md",
  SNAPSHOT_SCRIPT_PATH,
  SNAPSHOT_LIBRARY_PATH,
  "packages/identity/scripts/verify-work-queue-policy.mjs",
].sort();

const LEGACY_E2_T01_AUDIT_6_DIGEST =
  "4a8b62920fdd81c935162ac00fa5957ba058d82b43267b825fb44a01d509f49f";
const LEGACY_E2_T01_RECOVERY_10_13_DIGEST =
  "d9656c6b80daa522b84d6f66ff95c5c43e24631ef088012e12bbf8a5d12e39e1";

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function isSafeRepoPath(path) {
  return (
    typeof path === "string" &&
    /^[A-Za-z0-9_.\/-]+$/.test(path) &&
    !path.startsWith("/") &&
    path.split("/").every((segment) => segment.length > 0 && segment !== "..")
  );
}

export function addressableLineCount(text) {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function frontmatter(readme) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readme);
  if (!match) throw new Error("task readme has no frontmatter");
  return Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => /^([a-z_]+):\s*(.*)$/.exec(line))
      .filter(Boolean)
      .map((entry) => [entry[1], entry[2].replace(/^"|"$/g, "")]),
  );
}

export function currentGateFromQueue(queue) {
  const section = /^## Current gate\n\n([\s\S]*?)(?=\n## |$)/m.exec(queue)?.[1] ?? "";
  return /^\d+\. \*\*(E\d+-T\d+)\*\*/m.exec(section)?.[1] ?? null;
}

export function canonicalTaskPath(queue, taskId) {
  if (!TASK_ID.test(taskId)) throw new Error(`invalid task id ${JSON.stringify(taskId)}`);
  const epic = /^E(\d+)-/.exec(taskId)[1];
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const link = new RegExp(`\\[${escaped}\\]\\(([^)]+/readme\\.md)\\)`).exec(queue)?.[1];
  if (!link || link.startsWith("/") || link.includes("..")) {
    throw new Error(`queue has no canonical path for ${taskId}`);
  }
  const path = `.eforest/tasks/${link}`;
  if (
    !new RegExp(`^\\.eforest/tasks/epic-${epic}[^/]*/${escaped}(?:-[^/]+)?/readme\\.md$`).test(path)
  ) {
    throw new Error(`queue path does not match ${taskId}: ${path}`);
  }
  return path;
}

function visibleMarkdownLines(lines) {
  let fence = null;
  let inComment = false;
  return lines.map((line) => {
    let visible = "";
    let rest = line;
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf("-->");
        if (end === -1) return "";
        rest = rest.slice(end + 3);
        inComment = false;
        continue;
      }
      const start = rest.indexOf("<!--");
      if (start === -1) {
        visible += rest;
        break;
      }
      visible += rest.slice(0, start);
      rest = rest.slice(start + 4);
      inComment = true;
    }

    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(visible);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      return "";
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return "";
    }
    return visible;
  });
}

function verificationSections(readme) {
  const lines = readme.split("\n");
  const visible = visibleMarkdownLines(lines);
  const logStarts = visible
    .map((line, index) => (line === "## Verification log" ? index : -1))
    .filter((index) => index !== -1);
  if (logStarts.length !== 1) throw new Error("task readme must have exactly one Verification log");
  const start = logStarts[0] + 1;
  let end = lines.length;
  for (let index = start; index < visible.length; index += 1) {
    if (/^## (?!#)/.test(visible[index])) {
      end = index;
      break;
    }
  }
  const headings = [];
  for (let index = start; index < end; index += 1) {
    const heading = /^### ([^\n]+)$/.exec(visible[index]);
    if (heading) headings.push({ index, heading: heading[1] });
  }
  return headings.map((heading, index) => ({
    heading: heading.heading,
    entry: lines
      .slice(heading.index, headings[index + 1]?.index ?? end)
      .join("\n")
      .trim(),
    visibleEntry: visible
      .slice(heading.index, headings[index + 1]?.index ?? end)
      .join("\n")
      .trim(),
  }));
}

function topLevelBullets(entry) {
  const bullets = [];
  for (const line of entry.split("\n")) {
    const bullet = /^- (\S.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1].trim());
      continue;
    }
    const continuation = /^ {2,}(\S.*)$/.exec(line);
    if (continuation && bullets.length > 0) {
      bullets[bullets.length - 1] += ` ${continuation[1].trim()}`;
    }
  }
  return bullets;
}

function parseAuditBullets(bullets, expectedAssessment) {
  const rationale = [];
  const evidence = [];
  const nextFocus = [];
  const assessments = [];
  let recognized = 0;
  for (const bullet of bullets) {
    const rationaleMatch = /^Rationale: (\S.*)$/.exec(bullet);
    if (rationaleMatch) {
      rationale.push(rationaleMatch[1]);
      recognized += 1;
      continue;
    }
    const evidenceMatch =
      /^Evidence \((report|diff|commit|test|fixture|digest)\): (\S.*?) — (\S.*)$/.exec(bullet);
    if (evidenceMatch) {
      evidence.push({ kind: evidenceMatch[1], ref: evidenceMatch[2], supports: evidenceMatch[3] });
      recognized += 1;
      continue;
    }
    const focusMatch = /^Next focus: (\S.*)$/.exec(bullet);
    if (focusMatch) {
      nextFocus.push(focusMatch[1]);
      recognized += 1;
      continue;
    }
    const assessmentMatch = /^Assessment: (\S.*)$/.exec(bullet);
    if (assessmentMatch) {
      assessments.push(assessmentMatch[1]);
      recognized += 1;
    }
  }
  const complete =
    recognized === bullets.length &&
    rationale.length === 1 &&
    evidence.length > 0 &&
    nextFocus.length > 0 &&
    assessments.length === 1 &&
    assessments[0] === expectedAssessment;
  return {
    assessment: assessments[0] ?? null,
    complete,
    evidence,
    nextFocus,
    rationale: rationale[0] ?? null,
  };
}

function auditStartForTask(taskId, fields) {
  if (taskId === "E2-T01") {
    if (fields.progress_audit_start !== "6") {
      throw new Error("E2-T01 historical progress audit start must be exactly 6");
    }
    return 6;
  }
  if (fields.progress_audit_start !== undefined) {
    throw new Error(`progress_audit_start is not permitted for ${taskId}`);
  }
  return 3;
}

export function runCeilingForTask(fields) {
  if (fields.verification_run_ceiling === undefined) return 10;
  if (!/^\d+$/.test(fields.verification_run_ceiling)) {
    throw new Error("verification_run_ceiling must be an integer");
  }
  const ceiling = Number(fields.verification_run_ceiling);
  if (ceiling < 10 || ceiling > 100) {
    throw new Error("verification_run_ceiling must be between 10 and 100");
  }
  return ceiling;
}

export function recoveryEntry(readme, taskId, ceiling, baseRun = ceiling - 3) {
  if (ceiling === 10) return null;
  const firstRun = baseRun + 1;
  const pattern = new RegExp(
    `^(\\d{4}-\\d{2}-\\d{2}) — human resume — RUNS ${firstRun}-${ceiling} authorized$`,
  );
  const matches = verificationSections(readme).filter((section) => pattern.test(section.heading));
  if (matches.length !== 1) {
    throw new Error(`run ceiling ${ceiling} requires exactly one visible human-resume entry`);
  }
  const section = matches[0];
  const date = pattern.exec(section.heading)[1];
  const approvalBullets = topLevelBullets(section.visibleEntry);
  const entryDigest = sha256(section.entry);
  const pinnedLegacyEntry =
    taskId === "E2-T01" &&
    baseRun === 10 &&
    ceiling === 13 &&
    entryDigest === LEGACY_E2_T01_RECOVERY_10_13_DIGEST;
  const expectedBullets = [
    "Authorization: APPROVED",
    `Task: ${taskId}`,
    `Stopped after run: ${baseRun}`,
    `Authorized runs: ${firstRun}-${ceiling}`,
    `Scope: control-plane recovery transition and ${taskId} verification only`,
  ];
  if (!pinnedLegacyEntry && JSON.stringify(approvalBullets) !== JSON.stringify(expectedBullets)) {
    throw new Error(`human-resume entry for ${taskId} does not record explicit bounded approval`);
  }
  return {
    baseRun,
    date,
    entryDigest,
    firstRun,
    lastRun: ceiling,
  };
}

export function recoveryRequest(readme, { taskId } = {}) {
  if (!TASK_ID.test(taskId)) throw new Error("task id is required to parse recovery authorization");
  const fields = frontmatter(readme);
  const ceiling = runCeilingForTask(fields);
  if (ceiling === 10) {
    if (
      fields.verification_resume_commit !== undefined ||
      fields.verification_invalid_loop_commit !== undefined ||
      fields.verification_recovery_control_commit !== undefined ||
      fields.verification_recovery_base_run !== undefined
    ) {
      throw new Error("run ceiling 10 cannot carry recovery commit references");
    }
    return null;
  }
  const baseRunText = fields.verification_recovery_base_run;
  const baseRun = baseRunText === undefined ? ceiling - 3 : Number(baseRunText);
  if (!Number.isInteger(baseRun) || baseRun < 1 || baseRun >= ceiling || ceiling - baseRun > 3) {
    throw new Error("recovery window must authorize one to three runs after its stopped run");
  }
  if (!COMMIT_OID.test(fields.verification_invalid_loop_commit ?? "")) {
    throw new Error("extended run ceiling requires a full verification_invalid_loop_commit");
  }
  const controlCommit = fields.verification_recovery_control_commit ?? null;
  const resumeCommit = fields.verification_resume_commit ?? null;
  if (controlCommit === null) {
    if (!COMMIT_OID.test(resumeCommit ?? "")) {
      throw new Error("legacy recovery requires a full verification_resume_commit");
    }
  } else {
    if (!COMMIT_OID.test(controlCommit)) {
      throw new Error("recovery control commit must be a full commit OID");
    }
    if (resumeCommit !== null && !COMMIT_OID.test(resumeCommit)) {
      throw new Error("verification_resume_commit must be omitted or a full commit OID");
    }
  }
  return {
    authorizedCeiling: ceiling,
    baseRun,
    controlCommit,
    invalidLoopCommit: fields.verification_invalid_loop_commit,
    resumeCommit,
    ...recoveryEntry(readme, taskId, ceiling, baseRun),
  };
}

export function parseVerificationLedger(readme, { taskId, auditStart } = {}) {
  if (!TASK_ID.test(taskId)) throw new Error("task id is required to parse verification history");
  const expectedAuditStart = taskId === "E2-T01" ? 6 : 3;
  if (auditStart !== expectedAuditStart) {
    throw new Error(`progress audit start for ${taskId} must be ${expectedAuditStart}`);
  }
  const sections = verificationSections(readme);
  const byRun = new Map();
  for (const section of sections) {
    const verdict =
      /^\d{4}-\d{2}-\d{2} — judge(?: round (\d+))? — VERDICT: (verified|refuted|needs-evidence)$/.exec(
        section.heading,
      );
    if (!verdict) continue;
    const run = verdict[1] === undefined ? 1 : Number(verdict[1]);
    if (!Number.isInteger(run) || run < 1 || byRun.has(run)) {
      throw new Error(`duplicate or invalid official verdict run ${run}`);
    }
    const findings = topLevelBullets(section.visibleEntry);
    if (findings.length === 0)
      throw new Error(`official verdict run ${run} has no evidence bullet`);
    byRun.set(run, {
      run,
      verdict: verdict[2],
      findings,
      promoted: findings.filter((line) => /^\*\*SUITE\b/.test(line) || /^SUITE\b/.test(line)),
      report: section.entry,
      visibleReport: section.visibleEntry,
      logEntry: section.entry,
      entryDigest: sha256(section.entry),
    });
  }

  const runs = [...byRun.values()].sort((a, b) => a.run - b.run);
  runs.forEach((run, index) => {
    if (run.run !== index + 1) throw new Error(`official verdict history skips run ${index + 1}`);
    if (run.verdict === "verified" && index !== runs.length - 1) {
      throw new Error(`official history continues after verified run ${run.run}`);
    }
  });

  const audits = [];
  for (const section of sections) {
    const audit =
      /^\d{4}-\d{2}-\d{2} — progress critic — RUNS (\d+)-(\d+): (progressing|death-spiral|insufficient-evidence)$/.exec(
        section.heading,
      );
    if (!audit) continue;
    const firstRun = Number(audit[1]);
    const lastRun = Number(audit[2]);
    if (
      lastRun - firstRun !== 2 ||
      lastRun % 3 !== 0 ||
      lastRun < auditStart ||
      lastRun > runs.length
    ) {
      throw new Error(`invalid progress audit window ${firstRun}-${lastRun}`);
    }
    if (audits.some((entry) => entry.lastRun === lastRun)) {
      throw new Error(`duplicate progress audit ending at run ${lastRun}`);
    }
    const bullets = topLevelBullets(section.visibleEntry);
    const assessment = audit[3];
    const parsed = parseAuditBullets(bullets, assessment);
    const entryDigest = sha256(section.entry);
    const pinnedLegacyAudit =
      taskId === "E2-T01" &&
      firstRun === 4 &&
      lastRun === 6 &&
      entryDigest === LEGACY_E2_T01_AUDIT_6_DIGEST;
    if (!parsed.complete && !pinnedLegacyAudit) {
      throw new Error(`progress audit ${firstRun}-${lastRun} is incomplete`);
    }
    audits.push({
      firstRun,
      lastRun,
      assessment,
      evidence: parsed.evidence,
      nextFocus: parsed.nextFocus,
      rationale: parsed.rationale,
      entry: section.entry,
      visibleEntry: section.visibleEntry,
      entryDigest,
    });
  }
  audits.sort((a, b) => a.lastRun - b.lastRun);
  const progressAuditedThrough = audits.at(-1)?.lastRun ?? 0;
  for (let expected = auditStart; expected <= progressAuditedThrough; expected += 3) {
    if (!audits.some((entry) => entry.lastRun === expected)) {
      throw new Error(`progress audit history skips checkpoint ${expected}`);
    }
  }

  const runEntryDigests = runs.map((run) => run.entryDigest);
  const auditEntryDigests = audits.map((audit) => audit.entryDigest);
  const ledgerDigest = sha256(
    JSON.stringify({
      runs: runs.map((run) => [run.run, run.verdict, run.entryDigest]),
      audits: audits.map((audit) => [audit.firstRun, audit.lastRun, audit.entryDigest]),
    }),
  );
  return {
    audits,
    auditEntryDigests,
    ledgerDigest,
    progressAuditedThrough,
    runCount: runs.length,
    runEntryDigests,
    runs,
  };
}

function evidenceCatalog({ taskPath, ledger, resolvePath, commitExists }) {
  const catalog = [];
  const add = (kind, ref, verifier, target) => {
    if (!catalog.some((item) => item.kind === kind && item.ref === ref))
      catalog.push({ kind, ref, verifier, target });
  };
  for (const run of ledger.runs.slice(-3)) {
    const reportRef = `${taskPath}#judge-run-${run.run}`;
    add("report", reportRef, "ledger-entry", run.entryDigest);
    for (const value of run.visibleReport.match(/\b[0-9a-f]{40}(?:\.\.[0-9a-f]{40})?\b/g) ?? []) {
      const commits = value.split("..");
      if (commits.every((commit) => commitExists?.(commit))) {
        add(commits.length === 2 ? "diff" : "commit", value, "git-commit", value);
      }
    }
    for (const match of run.visibleReport.matchAll(/`([^`\n]+)`/g)) {
      const ref = match[1];
      if (/^[A-Za-z0-9_.\/-]+(?::\d+(?:-\d+)?)?$/.test(ref) && resolvePath?.(ref)) {
        add(
          /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.test\./.test(ref) ? "test" : "fixture",
          ref,
          "git-path",
          ref,
        );
      }
    }
    add("digest", run.entryDigest, "ledger-entry-digest", reportRef);
  }
  return catalog.sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`));
}

export function buildWorkQueueSnapshot({
  projectText,
  queueText,
  readmeText,
  sourceCommit,
  requestedTaskId,
  attesterSourceCommit,
  attesterDigest,
  controlDigest,
  transitionBaseCommit = null,
  changedPaths = [],
  transitionBaseIsDirectParent = null,
  recoveryAuthorization = null,
  resolvePath,
  commitExists,
}) {
  if (!COMMIT_OID.test(sourceCommit)) throw new Error("source commit must be a full lowercase OID");
  if (!COMMIT_OID.test(attesterSourceCommit))
    throw new Error("attester commit must be a full lowercase OID");
  if (!DIGEST.test(attesterDigest) || !DIGEST.test(controlDigest)) {
    throw new Error("attester/control digests must be lowercase SHA-256 values");
  }
  if (transitionBaseCommit !== null && !COMMIT_OID.test(transitionBaseCommit)) {
    throw new Error("transition base must be null or a full lowercase OID");
  }
  if (
    (transitionBaseCommit === null && transitionBaseIsDirectParent !== null) ||
    (transitionBaseCommit !== null && typeof transitionBaseIsDirectParent !== "boolean")
  ) {
    throw new Error("transition parent attestation must match the transition base");
  }
  if (!Array.isArray(changedPaths) || changedPaths.some((path) => typeof path !== "string")) {
    throw new Error("changed paths must be strings");
  }
  const base = {
    schemaVersion: 2,
    sourceCommit,
    attesterSourceCommit,
    attesterDigest,
    controlDigest,
    transitionBaseCommit,
    transitionBaseIsDirectParent,
    changedPaths: [...changedPaths].sort(),
    projectDigest: sha256(projectText),
    queueDigest: sha256(queueText),
    projectStatus: JSON.parse(projectText).status,
  };
  const currentGateTaskId = currentGateFromQueue(queueText);
  const taskId = requestedTaskId ?? currentGateTaskId;
  if (!taskId) return { ...base, currentGateTaskId: null, taskId: null };

  const taskPath = canonicalTaskPath(queueText, taskId);
  const fields = frontmatter(readmeText);
  if (fields.id !== taskId)
    throw new Error(`task frontmatter id ${fields.id} does not match ${taskId}`);
  const auditStart = auditStartForTask(taskId, fields);
  const runCeiling = runCeilingForTask(fields);
  const requestedRecovery = recoveryRequest(readmeText, { taskId });
  const ledger = parseVerificationLedger(readmeText, { taskId, auditStart });
  if (requestedRecovery === null) {
    if (recoveryAuthorization !== null) {
      throw new Error("default run ceiling cannot carry recovery authorization");
    }
  } else {
    const expectedResumeCommit = requestedRecovery.resumeCommit ?? sourceCommit;
    const priorRunPrefix = ledger.runEntryDigests.slice(0, recoveryAuthorization?.priorRunCount);
    const priorAuditPrefix = ledger.auditEntryDigests.slice(
      0,
      recoveryAuthorization?.priorAuditCount,
    );
    const resumeRunPrefix = ledger.runEntryDigests.slice(0, recoveryAuthorization?.resumeRunCount);
    const resumeAuditPrefix = ledger.auditEntryDigests.slice(
      0,
      recoveryAuthorization?.resumeAuditCount,
    );
    const priorLedgerPrefixDigest = sha256(
      JSON.stringify({
        runs: ledger.runs
          .slice(0, recoveryAuthorization?.priorRunCount)
          .map((run) => [run.run, run.verdict, run.entryDigest]),
        audits: ledger.audits
          .slice(0, recoveryAuthorization?.priorAuditCount)
          .map((audit) => [audit.firstRun, audit.lastRun, audit.entryDigest]),
      }),
    );
    const checkpointRequired = requestedRecovery.baseRun % 3 === 0;
    if (
      recoveryAuthorization?.authorizedCeiling !== requestedRecovery.authorizedCeiling ||
      recoveryAuthorization?.baseRun !== requestedRecovery.baseRun ||
      recoveryAuthorization?.controlCommit !== requestedRecovery.controlCommit ||
      recoveryAuthorization?.invalidLoopCommit !== requestedRecovery.invalidLoopCommit ||
      recoveryAuthorization?.resumeCommit !== expectedResumeCommit ||
      recoveryAuthorization?.date !== requestedRecovery.date ||
      recoveryAuthorization?.entryDigest !== requestedRecovery.entryDigest ||
      recoveryAuthorization?.firstRun !== requestedRecovery.firstRun ||
      recoveryAuthorization?.lastRun !== requestedRecovery.lastRun ||
      recoveryAuthorization?.priorRunCount !== requestedRecovery.baseRun ||
      recoveryAuthorization?.resumeRunCount !== requestedRecovery.baseRun ||
      !Number.isInteger(recoveryAuthorization?.priorAuditCount) ||
      !Number.isInteger(recoveryAuthorization?.resumeAuditCount) ||
      !DIGEST.test(recoveryAuthorization?.priorLedgerDigest ?? "") ||
      !DIGEST.test(recoveryAuthorization?.priorRunEntryDigestsDigest ?? "") ||
      !DIGEST.test(recoveryAuthorization?.priorAuditEntryDigestsDigest ?? "") ||
      !DIGEST.test(recoveryAuthorization?.resumeRunEntryDigestsDigest ?? "") ||
      !DIGEST.test(recoveryAuthorization?.resumeAuditEntryDigestsDigest ?? "") ||
      priorLedgerPrefixDigest !== recoveryAuthorization?.priorLedgerDigest ||
      sha256(JSON.stringify(priorRunPrefix)) !==
        recoveryAuthorization?.priorRunEntryDigestsDigest ||
      sha256(JSON.stringify(priorAuditPrefix)) !==
        recoveryAuthorization?.priorAuditEntryDigestsDigest ||
      sha256(JSON.stringify(resumeRunPrefix)) !==
        recoveryAuthorization?.resumeRunEntryDigestsDigest ||
      sha256(JSON.stringify(resumeAuditPrefix)) !==
        recoveryAuthorization?.resumeAuditEntryDigestsDigest ||
      !DIGEST.test(recoveryAuthorization?.statusReasonDigest ?? "") ||
      recoveryAuthorization?.resumeParentVerified !== true ||
      recoveryAuthorization?.resumeAncestorVerified !== true ||
      recoveryAuthorization?.invalidLoopStatusVerified !== true ||
      recoveryAuthorization?.ceilingIntroducedVerified !== true ||
      recoveryAuthorization?.statusReasonVerified !== true ||
      recoveryAuthorization?.approvalPathsVerified !== true ||
      recoveryAuthorization?.historyPrefixVerified !== true ||
      recoveryAuthorization?.sameGateVerified !== true ||
      (requestedRecovery.controlCommit !== null &&
        recoveryAuthorization?.controlParentVerified !== true) ||
      typeof recoveryAuthorization?.checkpointAuditInherited !== "boolean" ||
      (checkpointRequired &&
        (recoveryAuthorization?.checkpointOverrideVerified !== true ||
          !["progressing", "death-spiral", "insufficient-evidence"].includes(
            recoveryAuthorization?.checkpointAssessment,
          ) ||
          ledger.progressAuditedThrough < requestedRecovery.baseRun ||
          (recoveryAuthorization.checkpointAuditInherited
            ? recoveryAuthorization.resumeAuditCount !== recoveryAuthorization.priorAuditCount
            : recoveryAuthorization.resumeAuditCount !==
              recoveryAuthorization.priorAuditCount + 1) ||
          (!recoveryAuthorization.checkpointAuditInherited &&
            recoveryAuthorization.checkpointAssessment === "progressing"))) ||
      (!checkpointRequired &&
        (recoveryAuthorization.checkpointAuditInherited ||
          recoveryAuthorization.checkpointAssessment !== null ||
          recoveryAuthorization.resumeAuditCount !== recoveryAuthorization.priorAuditCount))
    ) {
      throw new Error(
        "extended run ceiling lacks its exact commit-attested recovery authorization",
      );
    }
    if (
      ledger.runCount < recoveryAuthorization.priorRunCount ||
      ledger.auditEntryDigests.length < recoveryAuthorization.resumeAuditCount
    ) {
      throw new Error("recovery history does not retain its stopped run and audit boundaries");
    }
  }
  if (ledger.runCount > runCeiling) {
    throw new Error(`official verdict history exceeds authorized run ceiling ${runCeiling}`);
  }
  return {
    ...base,
    taskDigest: sha256(readmeText),
    currentGateTaskId,
    taskId,
    taskPath,
    status: fields.status,
    runCeiling,
    recoveryAuthorization,
    auditStart,
    auditEnds: ledger.audits.map((audit) => audit.lastRun),
    auditEntryDigests: ledger.auditEntryDigests,
    progressAuditedThrough: ledger.progressAuditedThrough,
    runCount: ledger.runCount,
    runEntryDigests: ledger.runEntryDigests,
    ledgerDigest: ledger.ledgerDigest,
    runs: ledger.runs.slice(-3),
    latestAudit: ledger.audits.at(-1) ?? null,
    evidenceCatalog: evidenceCatalog({ taskPath, ledger, resolvePath, commitExists }),
  };
}
