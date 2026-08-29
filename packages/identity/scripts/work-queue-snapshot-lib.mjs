import { createHash } from "node:crypto";

// Recovery-control bridge 2026-07-28: E3-T02 runs 11-13; parser semantics unchanged.
// Recovery-control bridge 2 2026-07-28: E3-T02 runs 14-16; parser semantics unchanged.
const TASK_ID = /^E\d+-T\d+[a-z]*$/;
const COMMIT_OID = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export const SNAPSHOT_SCRIPT_PATH = "packages/identity/scripts/work-queue-snapshot.mjs";
export const SNAPSHOT_LIBRARY_PATH = "packages/identity/scripts/work-queue-snapshot-lib.mjs";
export const CONTROL_PATHS = [
  "AGENTS.md",
  ".eforest/loop.md",
  ".claude/workflows/decompose-task.js",
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
const LEGACY_E2_T05_AUDIT_1_3_DIGEST =
  "f00109596df05ccb7cde3b3eb2403ac805c75100d7471aa68a56e1aa0ee57b58";
const E2_T06_PRE_RUN_INVALID_LOOP_COMMIT = "f1f21df7ad71bb1978ef0dd12081ddc425368e3c";
const E3_T01_PRE_RUN_INVALID_LOOP_COMMIT = "cafff29593bdaf12e6eb3851fd2664ac661b661f";
const E2_T06_SECOND_RECOVERY_INVALID_LOOP_COMMIT = "441e8372e12aad69a68540cfb0e83be3fdfec114";
const E2_T06_THIRD_RECOVERY_INVALID_LOOP_COMMIT = "f1e72dd0f40089fc1a2d62bec715ca6405e36386";
const E2_T06_FOURTH_RECOVERY_INVALID_LOOP_COMMIT = "2b2ab56a8f8b7103eb9625d0e2c96967b5215649";
const LEGACY_E2_T04_VERDICT_DIGESTS = [
  "c28f3dd72e1c5b510e2b0190e80571ad8f09c46c49e814c755cbb8bc827e0bf6",
  "dcec21096b19b2b36c3562dcc1456babd26d3d83fa05a56796dd3c5a4099e3f3",
  "25570551e20b8e8546a7b8a4374addb071b2cfd8635bd07ff17420fd8f6dc0e8",
];
const LEGACY_E2_T05_VERDICTS = [
  {
    heading: "2026-07-18 — critics — VERDICT: refuted",
    digest: "a5f293f403b73061592c299f7ea49759e024257c5c8d03714c325b2f647d973d",
    run: 1,
    verdict: "refuted",
  },
  {
    heading: "2026-07-18 — critics — VERDICT: refuted (verification run 2)",
    digest: "d022cc9f9969add2b88c9c3901c4ff9a9bf195af217e4479e4cbf83a9225107a",
    run: 2,
    verdict: "refuted",
  },
  {
    heading: "2026-07-18 — critics — VERDICT: refuted (verification run 3)",
    digest: "dab4793690e8d9b72bf99915fcf694e8d2119cc20315b547bcd378167e207f04",
    run: 3,
    verdict: "refuted",
  },
  {
    heading: "2026-07-18 — critic — VERDICT: refuted",
    digest: "9cc18f79298a64bc0206a8196ed640760fd3542b6523161769e787cbe908157f",
    run: 4,
    verdict: "refuted",
  },
  {
    heading: "2026-07-18 — critic — VERDICT: refuted (verification run 5)",
    digest: "ed7c6de1a49e7a4cc46b7f304a9816d86e3f0f040904ac245432a3ed427d66c9",
    run: 5,
    verdict: "refuted",
  },
  {
    heading: "2026-07-18 — critics — VERDICT: refuted (verification run 6)",
    digest: "f38059b5cd927f5f7cd2dfaa89511a313eba681ddebb12eb536c8854aab1489f",
    run: 6,
    verdict: "refuted",
  },
  {
    heading: "2026-07-18 — critic — VERDICT: verified (verification run 7)",
    digest: "51d1ce950123b857a97de231afb054756d04469c75d39b894cccade2eafe4ad9",
    run: 7,
    verdict: "verified",
  },
];

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
  return /^\d+\. \*\*(E\d+-T\d+[a-z]*)\*\*/m.exec(section)?.[1] ?? null;
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
  if (ceiling < 2 || ceiling > 100) {
    throw new Error("verification_run_ceiling must be between 2 and 100");
  }
  return ceiling;
}

export function recoveryEntry(readme, taskId, ceiling, baseRun = ceiling - 3, generation = 1) {
  const exactE2T06FourthWindow =
    taskId === "E2-T06" && ceiling === 10 && baseRun === 6 && generation === 4;
  if (ceiling === 10 && !exactE2T06FourthWindow) return null;
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error("recovery generation must be a positive integer");
  }
  const firstRun = baseRun + 1;
  const generationLabel = generation === 1 ? "" : `RECOVERY ${generation} `;
  const pattern = new RegExp(
    `^(\\d{4}-\\d{2}-\\d{2}) — human resume — ${generationLabel}RUNS ${firstRun}-${ceiling} authorized$`,
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
    ...(generation === 1 ? [] : [`Recovery generation: ${generation}`]),
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
  const fourthE2T06Window =
    taskId === "E2-T06" &&
    fields.verification_recovery_base_run === "6" &&
    fields.verification_recovery_generation === "4" &&
    fields.verification_invalid_loop_commit === E2_T06_FOURTH_RECOVERY_INVALID_LOOP_COMMIT;
  if (ceiling === 10 && !fourthE2T06Window) {
    if (
      fields.verification_resume_commit !== undefined ||
      fields.verification_invalid_loop_commit !== undefined ||
      fields.verification_recovery_control_commit !== undefined ||
      fields.verification_recovery_base_run !== undefined ||
      fields.verification_recovery_generation !== undefined
    ) {
      throw new Error("run ceiling 10 cannot carry recovery commit references");
    }
    return null;
  }
  const baseRunText = fields.verification_recovery_base_run;
  const baseRun = baseRunText === undefined ? ceiling - 3 : Number(baseRunText);
  const generation = Number(fields.verification_recovery_generation ?? 1);
  const exactE2T06PreRunRecovery =
    taskId === "E2-T06" &&
    baseRun === 0 &&
    ceiling === 3 &&
    generation === 1 &&
    fields.verification_invalid_loop_commit === E2_T06_PRE_RUN_INVALID_LOOP_COMMIT;
  const exactE3T01PreRunRecovery =
    taskId === "E3-T01" &&
    baseRun === 0 &&
    ceiling === 3 &&
    generation === 1 &&
    fields.verification_invalid_loop_commit === E3_T01_PRE_RUN_INVALID_LOOP_COMMIT;
  const exactE2T06SecondRecovery =
    taskId === "E2-T06" &&
    baseRun === 0 &&
    ceiling === 3 &&
    generation === 2 &&
    fields.verification_invalid_loop_commit === E2_T06_SECOND_RECOVERY_INVALID_LOOP_COMMIT;
  const thirdE2T06Window =
    taskId === "E2-T06" && baseRun === 3 && ceiling === 6 && generation === 3;
  const exactE2T06ThirdRecovery =
    thirdE2T06Window &&
    fields.verification_invalid_loop_commit === E2_T06_THIRD_RECOVERY_INVALID_LOOP_COMMIT;
  const exactE2T06FourthRecovery =
    fourthE2T06Window && baseRun === 6 && ceiling === 10 && generation === 4;
  if (
    !Number.isInteger(baseRun) ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    (!exactE2T06PreRunRecovery &&
      !exactE3T01PreRunRecovery &&
      !exactE2T06SecondRecovery &&
      baseRun < 1) ||
    (thirdE2T06Window && !exactE2T06ThirdRecovery) ||
    baseRun >= ceiling ||
    (ceiling - baseRun > 3 && !exactE2T06FourthRecovery)
  ) {
    throw new Error("recovery window exceeds its explicitly authorized stopped-run bound");
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
    generation,
    controlCommit,
    invalidLoopCommit: fields.verification_invalid_loop_commit,
    resumeCommit,
    ...recoveryEntry(readme, taskId, ceiling, baseRun, generation),
  };
}

export function parseVerificationLedger(readme, { taskId, auditStart } = {}) {
  if (!TASK_ID.test(taskId)) throw new Error("task id is required to parse verification history");
  const expectedAuditStart = taskId === "E2-T01" ? 6 : 3;
  if (auditStart !== expectedAuditStart) {
    throw new Error(`progress audit start for ${taskId} must be ${expectedAuditStart}`);
  }
  const sections = verificationSections(readme);
  const legacyE2T04Sections = sections.filter((section) =>
    /^2026-07-18 — critic — VERDICT: (refuted|needs-evidence)$/.test(section.heading),
  );
  const legacyE2T04Digests = legacyE2T04Sections.map((section) => sha256(section.entry));
  const usesPinnedE2T04History =
    taskId === "E2-T04" &&
    JSON.stringify(legacyE2T04Digests) === JSON.stringify(LEGACY_E2_T04_VERDICT_DIGESTS);
  if (taskId === "E2-T04" && legacyE2T04Sections.length > 0 && !usesPinnedE2T04History) {
    throw new Error("legacy E2-T04 verdict history differs from its pinned stopped ledger");
  }
  const legacyE2T05Sections = sections.filter((section) =>
    /^\d{4}-\d{2}-\d{2} — critics? — VERDICT:/.test(section.heading),
  );
  const usesPinnedE2T05History =
    taskId === "E2-T05" &&
    legacyE2T05Sections.length === LEGACY_E2_T05_VERDICTS.length &&
    legacyE2T05Sections.every(
      (section, index) =>
        section.heading === LEGACY_E2_T05_VERDICTS[index].heading &&
        sha256(section.entry) === LEGACY_E2_T05_VERDICTS[index].digest,
    );
  if (taskId === "E2-T05" && legacyE2T05Sections.length > 0 && !usesPinnedE2T05History) {
    throw new Error("legacy E2-T05 verdict history differs from its pinned ledger");
  }
  const byRun = new Map();
  for (const section of sections) {
    const explicitVerdict =
      /^\d{4}-\d{2}-\d{2} — judge(?: round (\d+))? — VERDICT: (verified|refuted|needs-evidence)$/.exec(
        section.heading,
      );
    const legacyE2T04Index = usesPinnedE2T04History ? legacyE2T04Sections.indexOf(section) : -1;
    const legacyE2T05Index = usesPinnedE2T05History ? legacyE2T05Sections.indexOf(section) : -1;
    const legacyE2T05Verdict = LEGACY_E2_T05_VERDICTS[legacyE2T05Index];
    if (!explicitVerdict && legacyE2T04Index === -1 && legacyE2T05Verdict === undefined) continue;
    const run =
      legacyE2T05Verdict !== undefined
        ? legacyE2T05Verdict.run
        : legacyE2T04Index === -1
          ? explicitVerdict[1] === undefined
            ? 1
            : Number(explicitVerdict[1])
          : legacyE2T04Index + 1;
    const verdict =
      legacyE2T05Verdict !== undefined
        ? legacyE2T05Verdict.verdict
        : legacyE2T04Index === -1
          ? explicitVerdict[2]
          : /VERDICT: (refuted|needs-evidence)$/.exec(section.heading)[1];
    if (!Number.isInteger(run) || run < 1 || byRun.has(run)) {
      throw new Error(`duplicate or invalid official verdict run ${run}`);
    }
    const findings = topLevelBullets(section.visibleEntry);
    if (findings.length === 0)
      throw new Error(`official verdict run ${run} has no evidence bullet`);
    byRun.set(run, {
      run,
      verdict,
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
    const pinnedLegacyE2T01Audit =
      taskId === "E2-T01" &&
      firstRun === 4 &&
      lastRun === 6 &&
      entryDigest === LEGACY_E2_T01_AUDIT_6_DIGEST;
    const pinnedLegacyE2T05Audit =
      taskId === "E2-T05" &&
      firstRun === 1 &&
      lastRun === 3 &&
      entryDigest === LEGACY_E2_T05_AUDIT_1_3_DIGEST;
    if (!parsed.complete && !pinnedLegacyE2T01Audit && !pinnedLegacyE2T05Audit) {
      throw new Error(`progress audit ${firstRun}-${lastRun} is incomplete`);
    }
    audits.push({
      firstRun,
      lastRun,
      assessment,
      evidence: pinnedLegacyE2T05Audit
        ? [
            {
              kind: "digest",
              ref: runs[lastRun - 1].entryDigest,
              supports: "exact-pinned E2-T05 runs 1-3 progress audit",
            },
          ]
        : parsed.evidence,
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
    const checkpointRequired = requestedRecovery.baseRun > 0 && requestedRecovery.baseRun % 3 === 0;
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
