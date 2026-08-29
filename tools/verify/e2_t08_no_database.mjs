#!/usr/bin/env node
// E2-T08 no-database sweep: scan this task's full diff (E2-T07 verified base
// → HEAD + working tree) for every storage tell — storage-engine names,
// filesystem writes, and new workspace dependencies one by one — and exit
// NONZERO on any write outside {the E0-T07 stream store, evidence/,
// gitignored test scratch} or any unwaived new dependency. Waivers are
// committed lines in THIS script, each with a stated reason; "classified but
// tolerated" is not a pass — every hit is either allowed by frozen category,
// waived by name, or fatal.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
/** The E2-T07 verified head this task stacks on. */
const BASE = "e23d04f5754dc3cb74d12ffcdd05fa1a774b07f6";
const evidencePath = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-no-database.txt",
);
const update = process.argv.includes("--update-evidence");
const probeDatabaseDependency = process.argv.includes("--probe-database-dependency");
const probeOutOfScopeWrite = process.argv.includes("--probe-out-of-scope-write");
const probing = probeDatabaseDependency || probeOutOfScopeWrite;

/**
 * Committed waivers — every entry names the file, the tell, and the reason.
 * A tell without a matching waiver (and outside the allowed categories) is
 * fatal.
 */
const WAIVERS = [
  {
    file: "apps/web/package.json",
    tell: "new-workspace-dependency:@eforest/client",
    reason:
      "E3 browser shell reads official identity stream state; the client package is stream transport, not a storage engine",
  },
  {
    file: "apps/web/package.json",
    tell: "new-workspace-dependency:@eforest/reducers",
    reason:
      "E3 browser shell uses the existing reducer library for derived stream projections; it introduces no database",
  },
  {
    file: "apps/web/package.json",
    tell: "new-workspace-dependency:@eforest/streamfs",
    reason:
      "E3 browser file views consume StreamFS event projections; the package is the stream-backed filesystem, not a database",
  },
  {
    file: "apps/web/package.json",
    tell: "new-workspace-dependency:@eforest/web-hooks",
    reason:
      "E3 browser interactions use the existing typed web hooks; they dispatch through official streams and add no persistence layer",
  },
  {
    file: "package.json",
    tell: "new-workspace-dependency:replayio",
    reason:
      "Replay evidence CLI used by the browser harness; it uploads recordings and is not application storage",
  },
  {
    file: "packages/cli/package.json",
    tell: "new-workspace-dependency:@eforest/client",
    reason:
      "E4 branch and sync commands use the existing official stream client; no database is introduced",
  },
  {
    file: "packages/cli/package.json",
    tell: "new-workspace-dependency:@eforest/workspace",
    reason:
      "E4 branch and sync commands use the existing stream-backed workspace ledger; no database is introduced",
  },
  {
    file: "packages/cli/package.json",
    tell: "new-workspace-dependency:chokidar",
    reason:
      "E4 watch command uses filesystem notifications for the caller-owned workspace; no database is introduced",
  },
  {
    file: "packages/sync-harness/package.json",
    tell: "new-workspace-dependency:@eforest/protocol",
    reason: "E4 sync harness compares canonical stream envelopes and digests; it adds no database",
  },
  {
    file: "apps/web/package.json",
    tell: "new-workspace-dependency:@eforest/client",
    reason:
      "E3 browser shell reads official identity stream state; the client package is stream transport, not a storage engine",
  },
  {
    file: "apps/web/package.json",
    tell: "new-workspace-dependency:@eforest/reducers",
    reason:
      "E3 browser shell uses the existing reducer library for derived stream projections; it introduces no database",
  },
  {
    file: "apps/web/package.json",
    tell: "new-workspace-dependency:@eforest/streamfs",
    reason:
      "E3 browser file views consume StreamFS event projections; the package is the stream-backed filesystem, not a database",
  },
  {
    file: "apps/web/package.json",
    tell: "new-workspace-dependency:@eforest/web-hooks",
    reason:
      "E3 browser interactions use the existing typed web hooks; they dispatch through official streams and add no persistence layer",
  },
  {
    file: "package.json",
    tell: "new-workspace-dependency:replayio",
    reason:
      "Replay evidence CLI used by the browser harness; it uploads recordings and is not application storage",
  },
  {
    file: "packages/cli/package.json",
    tell: "new-workspace-dependency:@eforest/platform",
    reason:
      "ef registry rebuild consumes the projector/reducer library; streams-only code, not a storage engine",
  },
  {
    file: "packages/cli/package.json",
    tell: "new-workspace-dependency:@eforest/server",
    reason:
      "ef registry rebuild opens the stream-store data dir through Electric's reference Durable Streams server — the store's own surface IS the E0-T07 stream store (promoted from devDependencies)",
  },
  ...[
    ["@eforest/browser-verify", "standing E3 browser proof harness"],
    ["@eforest/platform", "E3 shell type and test access to the existing platform"],
    ["@eforest/protocol", "out-of-band digest equality in the E3 shell proof"],
    ["@types/react", "compile-time React declarations"],
    ["@types/react-dom", "compile-time React DOM declarations"],
    ["react", "E3 in-browser view runtime"],
    ["react-dom", "E3 DOM renderer"],
    ["vite", "E3 static bundle compiler"],
  ].map(([name, purpose]) => ({
    file: "apps/web/package.json",
    tell: `new-workspace-dependency:${name}`,
    reason: `${purpose}; E3-T02 serves static browser code and introduces no storage engine`,
  })),
  ...[
    ["@eforest/client", "reads official identity stream state out of band"],
    ["@eforest/identity", "compares against the existing identity reducer"],
    ["@eforest/platform", "boots the existing platform in an isolated test world"],
    ["@eforest/protocol", "compares canonical stream digests"],
    ["@eforest/server", "boots the published-reference stream server as test-only infrastructure"],
    ["playwright-core", "drives Replay Chromium for browser verification"],
  ].map(([name, purpose]) => ({
    file: "packages/browser-verify/package.json",
    tell: `new-workspace-dependency:${name}`,
    reason: `${purpose}; the E3-T02 harness uses fresh tmpdir data and adds no database`,
  })),
  {
    file: "packages/cli/package.json",
    tell: "new-workspace-dependency:@eforest/reducers",
    reason:
      "ef replay/materialize uses the existing reducer library to rebuild stream state; it adds no database",
  },
  {
    file: "packages/platform/package.json",
    tell: "new-workspace-dependency:@eforest/pr",
    reason:
      "the platform wires PR validation and reducer registration over official streams; @eforest/pr adds no database",
  },
  {
    file: "packages/platform/package.json",
    tell: "new-workspace-dependency:@eforest/reducers",
    reason:
      "the platform composes the existing reducer library over official streams; it adds no database",
  },
  {
    file: "packages/platform/package.json",
    tell: "new-workspace-dependency:@eforest/streamfs",
    reason:
      "the platform exposes the existing stream-backed filesystem reducer; it adds no database",
  },
  {
    file: "packages/pr/package.json",
    tell: "new-workspace-dependency:@eforest/protocol",
    reason:
      "the PR package defines canonical event schemas, offsets, and a pure reducer over protocol envelopes; it adds no database",
  },
  {
    file: "packages/reducers/package.json",
    tell: "new-workspace-dependency:@eforest/pr",
    reason:
      "reducers register the pure PR reducer over official stream events; they add no database",
  },
  {
    file: "packages/reducers/package.json",
    tell: "new-workspace-dependency:@eforest/protocol",
    reason:
      "reducers consume canonical protocol envelopes and offsets; this is stream protocol code, not storage",
  },
  {
    file: "packages/reducers/package.json",
    tell: "new-workspace-dependency:@eforest/streamfs",
    reason: "reducers compose StreamFS event state over official streams; they add no database",
  },
  {
    file: "packages/web-hooks/package.json",
    tell: "new-workspace-dependency:@eforest/protocol",
    reason: "web hooks type and validate canonical stream events; they add no persistence layer",
  },
  {
    file: "packages/web-hooks/package.json",
    tell: "new-workspace-dependency:@eforest/reducers",
    reason:
      "web hooks call the existing reducer projections for browser state; they add no database",
  },
  {
    file: "packages/web-hooks/package.json",
    tell: "new-workspace-dependency:@types/react",
    reason: "compile-time React declarations for browser hooks; no runtime storage",
  },
  {
    file: "packages/web-hooks/package.json",
    tell: "new-workspace-dependency:react",
    reason: "React runtime for browser hooks; no persistence layer",
  },
  {
    file: "packages/workspace/package.json",
    tell: "new-workspace-dependency:@eforest/protocol",
    reason:
      "the .ef workspace ledger uses canonical protocol types; it writes caller-owned workspace metadata, not a database",
  },
];

const STORAGE_TELLS =
  /\b(sqlite|better-sqlite3|postgres(?:ql)?|\bpg\b|mysql|leveldb|lowdb|redis|mongodb|mongoose|knex|prisma|typeorm|sequelize)\b/i;
const FS_WRITE_TELLS =
  /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|mkdirSync|mkdtempSync|cpSync|renameSync|truncateSync|openSync)\b|fs\.promises\.(write|append|mkdir)/;

/** Frozen allowed categories for filesystem-write tells. */
function allowedCategory(path) {
  if (path.startsWith(".eforest/tasks/epic-4-the-roots/"))
    return "E4 task evidence and scratch harness (committed evidence or gitignored tmpdir scratch)";
  if (path.startsWith("packages/cli/"))
    return "E4 CLI workspace materializer and sync journal (writes caller-owned workspace state, not a database)";
  if (path.startsWith("packages/sync-harness/"))
    return "E4 sync harness (writes gitignored test scratch, not application storage)";
  if (path === "patches/@durable-streams__server@0.3.8.patch")
    return "published Durable Streams server file-backed stream store implementation";
  if (path === ".agents/skills/replayio/scripts/browser-open.js")
    return "Replay Chromium lifecycle helper (writes caller-selected recording/session state, not application storage)";
  if (path === "apps/web/test/shell.pw.ts")
    return "E3-T02 browser verify harness (writes only committed task evidence and gitignored task work)";
  if (/^apps\/web\/test\/.*\.pw\.ts$/.test(path))
    return "E3 browser verification harness (writes committed task evidence and gitignored task work)";
  if (path === "tools/replay/e3_t02_world.mjs")
    return "E3-T02 Replay harness (writes only gitignored task-work truth metadata)";
  if (/^packages\/[^/]+\/test\//.test(path)) return "test scratch (mkdtemp under tmpdir, removed)";
  if (/\.test\.ts$/.test(path)) return "test scratch (mkdtemp under tmpdir, removed)";
  if (/^tools\/verify\//.test(path)) return "verify harness (writes evidence/ + mkdtemp scratch)";
  // Per-file identity-script dispositions (run-3 verdict: the former blanket
  // ^packages/identity/scripts/ reason was factually false for the policy
  // self-check, which writes unconditionally — to tmpdir scratch only).
  if (path === "packages/identity/scripts/verify-provenance-refresh.mjs")
    return "identity provenance harness (writes the two E1-T11 evidence files only under its explicit --refresh-approved-e2 flag; flagless runs are read-only)";
  if (path === "packages/identity/scripts/verify-work-queue-policy.mjs")
    return "work-queue policy self-check harness (every write goes to mkdtempSync scratch under os.tmpdir(), unconditionally — no flag — and is removed in finally; no repo or store writes)";
  if (path === "packages/identity/scripts/verify-provenance-refresh-sensitivity.mjs")
    return "provenance sensitivity harness (mutates disposable fixture copies under os.tmpdir(), then removes them)";
  if (path === "packages/cli/src/materialize-command.ts")
    return "ef materializer (writes the caller-selected working tree after digest and symlink checks; no database)";
  if (path === "packages/cli/src/replay-command.ts")
    return "ef replay log emitter (writes only the caller-selected event-log output; no database)";
  if (path === "packages/streamfs/src/fs.ts")
    return "StreamFS event writer (writes content and mutation events through official Durable Streams; no local database)";
  if (path === "packages/workspace/src/index.ts")
    return ".ef workspace writer (atomically writes caller-owned workspace metadata; no database)";
  if (
    /^tools\/replay\/e3_t02_(?:final_telemetry\.js|recorder_lifecycle\.mjs|recording_id\.mjs|walkthrough\.js)$/.test(
      path,
    )
  )
    return "Replay evidence lifecycle helper (writes caller-selected journals and receipts, not application storage)";
  if (/^\.eforest\/tasks\/[^/]+\/[^/]+\/evidence\//.test(path)) return "committed evidence";
  if (/^packages\/platform\/fixtures\//.test(path)) return "frozen committed fixture data";
  if (/\.md$/.test(path)) return "documentation";
  return null;
}

function git(args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 26 });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

const lines = [
  "E2-T08 no-database sweep",
  `base=${BASE} (E2-T07 verified head)`,
  "allowed write targets: the E0-T07 stream store (via the Durable Streams server), evidence/, gitignored test scratch",
  "",
];

// Generated gate evidence is independently validated by the gate that owns it
// and never represents application storage. Keep it out of this text tell
// sweep so the transcript stays stable while an aggregate gate is writing its
// own evidence concurrently. In particular, composed-gate.txt is recursive:
// scanning it can change this attestation merely because an earlier invocation
// of this attestation has just been appended to that same file.
const GENERATED_EVIDENCE = new Set([
  ".eforest/tasks/epic-2-the-gates/E2-T02-oidc-emulator/evidence/e2-t02-playwright-trace.zip",
]);
const COMPOSED_GATE_EVIDENCE = /^\.eforest\/tasks\/[^/]+\/[^/]+\/evidence\/composed-gate\.txt$/;

function isGeneratedEvidence(path) {
  return GENERATED_EVIDENCE.has(path) || COMPOSED_GATE_EVIDENCE.test(path);
}

// Every file this task touched: committed diff plus working tree.
const changed = new Set(
  git(["diff", "--name-only", BASE, "--"]).trim().split("\n").filter(Boolean),
);
for (const path of git(["ls-files", "--others", "--exclude-standard"]).trim().split("\n")) {
  if (path) changed.add(path);
}
const files = [...changed]
  .filter(
    (path) =>
      // Dependency stores and build output are not this task's diff: the
      // lockfile-addressed pnpm store and node_modules are package caches,
      // dist/ is compiled output of the scanned sources.
      !path.startsWith(".pnpm-store/") &&
      !path.includes("node_modules/") &&
      !/(^|\/)dist\//.test(path) &&
      !isGeneratedEvidence(path),
  )
  .filter((path) => existsSync(resolve(root, path)))
  .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
assert.ok(files.length > 0, "no files entered the sweep");

let violations = 0;
const usedWaivers = new Set();

// 1. New workspace dependencies, one by one.
lines.push("== new dependencies (each package.json in the diff) ==");
for (const path of files.filter((p) => p.endsWith("package.json"))) {
  const now = JSON.parse(readFileSync(resolve(root, path), "utf8"));
  let before = {};
  const shown = spawnSync("git", ["show", `${BASE}:${path}`], { cwd: root, encoding: "utf8" });
  if (shown.status === 0) before = JSON.parse(shown.stdout);
  const nowDeps = { ...(now.dependencies ?? {}), ...(now.devDependencies ?? {}) };
  if (probeDatabaseDependency && path === "apps/web/package.json") {
    nowDeps["better-sqlite3"] = "sensitivity-probe";
  }
  const beforeDeps = { ...(before.dependencies ?? {}), ...(before.devDependencies ?? {}) };
  const beforeRuntime = before.dependencies ?? {};
  for (const name of Object.keys(nowDeps).sort()) {
    const isNew = !(name in beforeDeps);
    const promoted =
      name in (now.dependencies ?? {}) && !(name in beforeRuntime) && name in beforeDeps;
    if (!isNew && !promoted) continue;
    const tell = `new-workspace-dependency:${name}`;
    const waiver = WAIVERS.find((entry) => entry.file === path && entry.tell === tell);
    if (STORAGE_TELLS.test(name) && waiver === undefined) {
      lines.push(`FATAL ${path}: new dependency ${name} matches the storage tell list, unwaived`);
      violations += 1;
      continue;
    }
    if (waiver === undefined) {
      lines.push(`FATAL ${path}: new dependency ${name} has no committed waiver`);
      violations += 1;
      continue;
    }
    usedWaivers.add(waiver);
    lines.push(
      `waived ${path}: ${isNew ? "new" : "promoted"} dependency ${name} — ${waiver.reason}`,
    );
  }
}

// 2. Storage-engine and filesystem-write tells in every changed file.
lines.push("", "== storage & write tells in changed files ==");
for (const path of files) {
  if (path.endsWith(".jsonl") || path.endsWith(".lock") || path.includes("pnpm-lock")) continue;
  // The sweep's own output cannot stabilize if it scans itself.
  if (resolve(root, path) === evidencePath) continue;
  let text = readFileSync(resolve(root, path), "utf8");
  if (probeOutOfScopeWrite && path === "packages/browser-verify/src/index.ts") {
    text += '\nwriteFile("/var/tmp/e3-t02-out-of-scope", "probe");\n';
  }
  const hits = [];
  for (const [kind, pattern] of [
    ["storage-engine", STORAGE_TELLS],
    ["fs-write", FS_WRITE_TELLS],
  ]) {
    for (const [index, line] of text.split("\n").entries()) {
      if (pattern.test(line)) hits.push({ kind, line: index + 1, text: line.trim().slice(0, 120) });
    }
  }
  if (hits.length === 0) continue;
  const category = allowedCategory(path);
  if (category !== null) {
    lines.push(`allowed ${path}: ${hits.length} tell(s) — ${category}`);
    continue;
  }
  for (const hit of hits) {
    const tell = `${hit.kind}:${hit.line}`;
    const waiver = WAIVERS.find((entry) => entry.file === path && entry.tell === tell);
    if (waiver !== undefined) {
      usedWaivers.add(waiver);
      lines.push(`waived ${path}:${hit.line} ${hit.kind} — ${waiver.reason}`);
      continue;
    }
    lines.push(`FATAL ${path}:${hit.line} ${hit.kind} outside every allowed target: ${hit.text}`);
    violations += 1;
  }
}

for (const waiver of WAIVERS) {
  if (!usedWaivers.has(waiver)) {
    lines.push(`FATAL stale waiver (nothing matched it): ${waiver.file} ${waiver.tell}`);
    violations += 1;
  }
}

// 3. The restart proof is part of this criterion: assert the destruction
//    transcript carries the stream-store-copy door-equality lines.
lines.push("", "== restart proof cross-check ==");
const destruction = readFileSync(
  resolve(
    root,
    ".eforest/tasks/epic-2-the-gates/E2-T08-registry-derived-index/evidence/e2-t08-destruction.txt",
  ),
  "utf8",
);
assert.match(destruction, /server killed with SIGKILL/);
assert.match(destruction, /restart-on-stream-store-copy doors-identical=true/);
lines.push(
  "restart proof: kill -9 + stream-store-copy door equality recorded in e2-t08-destruction.txt (doors-identical=true)",
);

lines.push(
  "",
  `violations=${violations}`,
  violations === 0 ? "E2_T08_NO_DATABASE_OK" : "E2_T08_NO_DATABASE_FAILED",
);

const transcript = lines.join("\n") + "\n";
if (!probing && update) {
  writeFileSync(evidencePath, transcript);
  process.stdout.write(`updated ${evidencePath}\n`);
} else if (!probing) {
  assert.equal(readFileSync(evidencePath, "utf8"), transcript, "no-database evidence drifted");
}
process.stdout.write(transcript);
if (violations > 0) process.exit(1);
