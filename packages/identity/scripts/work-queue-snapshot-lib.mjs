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

const LEGACY_E2_T01_AUDIT_6_DIGEST =
  "4a8b62920fdd81c935162ac00fa5957ba058d82b43267b825fb44a01d509f49f";

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
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

function parseAuditBullets(bullets) {
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
    assessments[0] === "progressing";
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
    const audit = /^\d{4}-\d{2}-\d{2} — progress critic — RUNS (\d+)-(\d+): progressing$/.exec(
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
    const parsed = parseAuditBullets(bullets);
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
      assessment: parsed.assessment,
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
  const ledger = parseVerificationLedger(readmeText, { taskId, auditStart });
  return {
    ...base,
    taskDigest: sha256(readmeText),
    currentGateTaskId,
    taskId,
    taskPath,
    status: fields.status,
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
