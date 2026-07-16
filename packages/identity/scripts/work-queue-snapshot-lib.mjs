import { createHash } from "node:crypto";

const TASK_ID = /^E\d+-T\d+$/;
const COMMIT_OID = /^[0-9a-f]{40}$/;

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function frontmatter(readme) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readme);
  if (!match) throw new Error("task readme has no frontmatter");
  const fields = Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => /^([a-z_]+):\s*(.*)$/.exec(line))
      .filter(Boolean)
      .map((entry) => [entry[1], entry[2].replace(/^"|"$/g, "")]),
  );
  return fields;
}

export function currentGateFromQueue(queue) {
  const section = /^## Current gate\n\n([\s\S]*?)(?=\n## |$)/m.exec(queue)?.[1] ?? "";
  const id = /^\d+\. \*\*(E\d+-T\d+)\*\*/m.exec(section)?.[1] ?? null;
  return id;
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

function markdownSections(readme) {
  const headings = [...readme.matchAll(/^### ([^\n]+)$/gm)];
  return headings.map((heading, index) => ({
    heading: heading[1],
    entry: readme.slice(heading.index, headings[index + 1]?.index ?? readme.length).trim(),
  }));
}

export function parseVerificationLedger(readme, auditStart = 3) {
  if (!Number.isInteger(auditStart) || auditStart < 3 || auditStart % 3 !== 0) {
    throw new Error(`invalid progress audit start ${auditStart}`);
  }
  const sections = markdownSections(readme);
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
    const findings = section.entry
      .split("\n")
      .filter((line) => line.startsWith("- **"))
      .map((line) => line.slice(2).trim());
    if (findings.length === 0) throw new Error(`official verdict run ${run} has no findings`);
    byRun.set(run, {
      run,
      verdict: verdict[2],
      findings,
      promoted: section.entry
        .split("\n")
        .filter((line) => /^- \*\*SUITE/.test(line))
        .map((line) => line.slice(2).trim()),
      report: section.entry,
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
    if (lastRun - firstRun !== 2 || lastRun % 3 !== 0 || lastRun > runs.length) {
      throw new Error(`invalid progress audit window ${firstRun}-${lastRun}`);
    }
    if (audits.some((entry) => entry.lastRun === lastRun)) {
      throw new Error(`duplicate progress audit ending at run ${lastRun}`);
    }
    audits.push({
      firstRun,
      lastRun,
      entry: section.entry,
      entryDigest: sha256(section.entry),
    });
  }
  audits.sort((a, b) => a.lastRun - b.lastRun);
  const progressAuditedThrough = audits.at(-1)?.lastRun ?? 0;
  for (let expected = auditStart; expected <= progressAuditedThrough; expected += 3) {
    if (!audits.some((entry) => entry.lastRun === expected)) {
      throw new Error(`progress audit history skips checkpoint ${expected}`);
    }
  }

  return {
    audits,
    progressAuditedThrough,
    runCount: runs.length,
    runs,
  };
}

export function buildWorkQueueSnapshot({
  projectText,
  queueText,
  readmeText,
  sourceCommit,
  requestedTaskId,
}) {
  if (!COMMIT_OID.test(sourceCommit)) throw new Error("source commit must be a full lowercase OID");
  const currentGateTaskId = currentGateFromQueue(queueText);
  const taskId = requestedTaskId ?? currentGateTaskId;
  if (!taskId) {
    return {
      schemaVersion: 1,
      sourceCommit,
      projectDigest: sha256(projectText),
      queueDigest: sha256(queueText),
      projectStatus: JSON.parse(projectText).status,
      currentGateTaskId: null,
      taskId: null,
    };
  }
  const taskPath = canonicalTaskPath(queueText, taskId);
  const fields = frontmatter(readmeText);
  if (fields.id !== taskId)
    throw new Error(`task frontmatter id ${fields.id} does not match ${taskId}`);
  const auditStart =
    fields.progress_audit_start === undefined ? 3 : Number(fields.progress_audit_start);
  const ledger = parseVerificationLedger(readmeText, auditStart);
  return {
    schemaVersion: 1,
    sourceCommit,
    projectDigest: sha256(projectText),
    queueDigest: sha256(queueText),
    taskDigest: sha256(readmeText),
    projectStatus: JSON.parse(projectText).status,
    currentGateTaskId,
    taskId,
    taskPath,
    status: fields.status,
    auditStart,
    auditEnds: ledger.audits.map((audit) => audit.lastRun),
    progressAuditedThrough: ledger.progressAuditedThrough,
    runCount: ledger.runCount,
    runs: ledger.runs.slice(-3),
    latestAudit: ledger.audits.at(-1) ?? null,
  };
}
