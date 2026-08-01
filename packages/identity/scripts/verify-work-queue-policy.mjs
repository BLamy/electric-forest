import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// Recovery-control bridge 2026-07-28: E3-T02 runs 11-13; policy assertions unchanged.
// Recovery-control bridge 2 2026-07-28: E3-T02 runs 14-16; policy assertions unchanged.
import {
  CONTROL_PATHS,
  RECOVERY_CONTROL_PATHS,
  addressableLineCount,
  buildWorkQueueSnapshot,
  canonicalTaskPath,
  currentGateFromQueue,
  e3T06RecoveryBoundReadme,
  e3T06RecoveryLifecycleProject,
  e3T06RecoveryLifecycleReadme,
  isSafeRepoPath,
  parseVerificationLedger,
  recoveryRequest,
  runCeilingForTask,
  sha256,
} from "./work-queue-snapshot-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workQueueSource = readFileSync(resolve(root, ".claude/workflows/work-queue.js"), "utf8");
const decomposeTaskSource = readFileSync(
  resolve(root, ".claude/workflows/decompose-task.js"),
  "utf8",
);
const verifyTaskSource = readFileSync(resolve(root, ".claude/workflows/verify-task.js"), "utf8");
const snapshotLibSource = readFileSync(
  resolve(root, "packages/identity/scripts/work-queue-snapshot-lib.mjs"),
  "utf8",
);
const snapshotCliSource = readFileSync(
  resolve(root, "packages/identity/scripts/work-queue-snapshot.mjs"),
  "utf8",
);
const coldCloneSource = readFileSync(resolve(root, "tools/verify/cold_clone.sh"), "utf8");
const trustedPathSource = readFileSync(resolve(root, "tools/verify/trusted_path.sh"), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const TASK_ID = "E2-T01";
const TASK_PATH = ".eforest/tasks/epic-2-the-gates/E2-T01-identity-event-model/readme.md";
const ORDINARY_TASK_ID = "E2-T02";
const ORDINARY_TASK_PATH = ".eforest/tasks/epic-2-the-gates/E2-T02-oidc-emulator/readme.md";
const E3_T06_TASK_ID = "E3-T06";
const E3_T06_TASK_PATH = ".eforest/tasks/epic-3-the-canopy/E3-T06-file-tree-live/readme.md";
const E3_T06_STOPPED_COMMIT = "c258fb003c1a735117a5fc251b38338d2a0ff8bf";
const E3_T06_STOPPED_LEDGER_DIGEST =
  "afd2888a1bd9430d94d475cff4b2ed0cd0adb4b6858b8ebb652906ececed9e54";
const E3_T06_STOPPED_PROJECT_DIGEST =
  "69baf13a00decba6ae1434c80788dec7542eb08055a3c0c7c27763f637fce969";
const E3_T06_MIGRATED_RUNS = [
  {
    heading: "2026-07-31 — critic — VERDICT: refuted",
    digest: "3e29339773087dcb1fa13fe8ac07514cff793ab397bf74a7d32b3f6be81a0a2b",
    run: 1,
    verdict: "refuted",
  },
  {
    heading: "2026-07-31 — critic — VERDICT: refuted (remaining)",
    digest: "41379b551cd979ae94cace8a9da2ee492d0ddfb91f6d4a92a63dd7881b55ed39",
    run: 2,
    verdict: "refuted",
  },
  {
    heading: "2026-07-31 — critic — VERDICT: refuted (evidence contradiction)",
    digest: "75877627adc7e3daa77249e2001d8494681dfc0226eefd09b7a9be7c57758451",
    run: 3,
    verdict: "refuted",
  },
  {
    heading: "2026-07-31 — cold-clone gate — refuted (harness race)",
    digest: "c370831074a4a9c721296e743d8ad82d94965a283cdc9cfe7a0378de0a6c4ae7",
    run: 4,
    verdict: "refuted",
  },
  {
    heading: "2026-07-31 — independent critic follow-up — VERDICT: refuted",
    digest: "a4bf06e01383cf217ddeceeaadaa8204469ce6e0795814a1294f28a14376ccda",
    run: 5,
    verdict: "refuted",
  },
  {
    heading: "2026-07-31 — fresh replay critic — VERDICT: needs-evidence",
    digest: "4ebe0f68f81a38976ea17e1cf7cb8d9b48d46eea9a576bd24df6deed4f0df49d",
    run: 6,
    verdict: "needs-evidence",
  },
  {
    heading: "2026-07-31 — fresh replay critic — VERDICT: needs-evidence (artifact parity)",
    digest: "d1109ba9e277c4284ac3ed228f7c7dae3841f54e4cda3b5e9b62aba17446445a",
    run: 7,
    verdict: "needs-evidence",
  },
  {
    heading: "2026-07-31 — fresh replay critic — VERDICT: refuted (dead condition)",
    digest: "b5d56691ea0e3e6235f836779e77eb1921995948b9c0c1ac4dd8ee6880bae806",
    run: 8,
    verdict: "refuted",
  },
];
const E3_T06_SUPERSEDED_ENTRIES = [
  {
    heading: "2026-07-31 — critic — VERDICT: verified",
    digest: "bbb76863df972d2f85b93f4bd1125a1696346f0e70b4edb29380d17865a5561f",
  },
  {
    heading: "2026-07-31 — critic — VERDICT: verified (harness re-review)",
    digest: "84460c17ddd64f7f5c10053b36cc01816926fc7311717934789635fca117e34d",
  },
];
const E3_T06_STOP_AUDIT = {
  heading: "2026-07-31 — independent run-ledger audit — VERDICT: invalid_loop",
  digest: "32b28b2c7b65d93a57052e5c3a24c1b0c0781293ee4ee86df9f2995cd0a909e2",
};
const E3_T06_ALL_PINNED_ENTRIES = [
  ...E3_T06_MIGRATED_RUNS,
  ...E3_T06_SUPERSEDED_ENTRIES,
  E3_T06_STOP_AUDIT,
];
const LEGACY_E2_T04_PATH = ".eforest/tasks/epic-2-the-gates/E2-T04-web-login-sessions/readme.md";
const LEGACY_E2_T05_PATH = ".eforest/tasks/epic-2-the-gates/E2-T05-cli-device-token-flow/readme.md";
const commits = "abcdefghij".split("").map((letter) => letter.repeat(40));
const digest = (letter) => letter.repeat(64);

assert.equal(
  currentGateFromQueue(
    '# queue\n\n## Current gate\n\n1. **E3-T02b** — "suffix gate" *(builder working)*\n\n## Next up\n',
  ),
  "E3-T02b",
  "current gate parser truncated a suffixed task id",
);
assert.ok(CONTROL_PATHS.includes(".claude/workflows/decompose-task.js"));
assert.match(workQueueSource, /configuredMaxRuns !== 10/);
assert.match(workQueueSource, /globalProbationRuns:\s*3/);
assert.match(workQueueSource, /verdict === 'verified'/);
assert.match(decomposeTaskSource, /global three-run probation/i);
assert.match(decomposeTaskSource, /Preserve .*ledger byte-for-byte/);

function compile(source) {
  return new AsyncFunction(
    "agent",
    "workflow",
    "parallel",
    "phase",
    "log",
    "budget",
    "args",
    source.replace("export const meta", "const meta"),
  );
}

function runColdClone(cwd, args, environment = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync("bash", ["tools/verify/cold_clone.sh", ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

function verifyColdCloneTargetBoundary(source, label) {
  const temporary = mkdtempSync(resolve(tmpdir(), `eforest-cold-clone-${label}-`));
  const repo = resolve(temporary, "repo");
  try {
    mkdirSync(resolve(repo, "tools/verify"), { recursive: true });
    writeFileSync(resolve(repo, "tools/verify/cold_clone.sh"), source);
    chmodSync(resolve(repo, "tools/verify/cold_clone.sh"), 0o755);
    writeFileSync(
      resolve(repo, "tools/verify/trusted_path.sh"),
      trustedPathSource +
        `\nmake() {\n` +
        `  local final_argument=""\n` +
        `  for final_argument in "$@"; do :; done\n` +
        `  if [ "\${1:-}" = "-rR" ]; then\n` +
        `    printf 'echo "%s: OK"\\n' "$final_argument"\n` +
        `  else\n` +
        `    printf '%s: OK\\n' "$final_argument"\n` +
        `  fi\n` +
        `}\n` +
        `export -f make\n`,
    );
    writeFileSync(
      resolve(repo, "Makefile"),
      ".PHONY: verify-sentinel verify-broken verify-empty-phony verify-unregistered\n" +
        "verify-sentinel:\n" +
        "\t@echo COLD_CLONE_SENTINEL_EXECUTED\n" +
        '\t@echo "verify-sentinel: OK"\n' +
        "verify-broken: absent-prerequisite\n" +
        '\t@echo "verify-broken: OK"\n' +
        "verify-empty-rule:\n" +
        "verify-empty-phony:\n" +
        "verify-silent-marker:\n" +
        '\t@$(if $(findstring n,$(MAKEFLAGS)),echo "verify-silent-marker: OK",true)\n' +
        "verify-unregistered:\n" +
        '\t@echo "verify-unregistered: OK"\n' +
        "define FORGED_RULE_TEXT\n" +
        "verify-forged-file:\n" +
        "verify-forged-dir:\n" +
        "endef\n",
    );
    writeFileSync(
      resolve(repo, "tools/verify/cold_clone_targets.txt"),
      [
        "verify-sentinel",
        "verify-broken",
        "verify-missing",
        "verify-empty-rule",
        "verify-empty-phony",
        "verify-silent-marker",
        "verify-existing-file",
        "verify-existing-dir",
        "verify-forged-file",
        "verify-forged-dir",
        "verify-ambient-injection",
        "verify-function-injection",
      ].join("\n") + "\n",
    );
    writeFileSync(resolve(repo, "verify-existing-file"), "ordinary committed file\n");
    mkdirSync(resolve(repo, "verify-existing-dir"));
    writeFileSync(resolve(repo, "verify-existing-dir/.keep"), "ordinary committed directory\n");
    writeFileSync(resolve(repo, "verify-forged-file"), "ordinary committed file\n");
    mkdirSync(resolve(repo, "verify-forged-dir"));
    writeFileSync(resolve(repo, "verify-forged-dir/.keep"), "ordinary committed directory\n");
    const ambientMakefile = resolve(temporary, "ambient.mk");
    writeFileSync(
      ambientMakefile,
      ".PHONY: verify-ambient-injection\n" +
        "verify-ambient-injection:\n" +
        "\t@echo AMBIENT_MAKEFILE_EXECUTED\n" +
        '\t@echo "verify-ambient-injection: OK"\n',
    );
    const bashEnvironment = resolve(temporary, "bash-env.sh");
    writeFileSync(bashEnvironment, `export MAKEFILES=${ambientMakefile}\n`);
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Cold Clone Sensor"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "sensor@example.invalid"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "--quiet", "-m", "cold clone target fixture"], {
      cwd: repo,
    });

    const option = runColdClone(repo, ["--version"]);
    const optionOutput = `${option.stdout}${option.stderr}`;
    assert.notEqual(option.status, 0, `${label}: option-shaped target passed`);
    assert.match(optionOutput, /invalid verify target --version/);
    assert.equal(
      optionOutput.includes("cloning HEAD"),
      false,
      `${label}: option-shaped target reached cloning`,
    );

    const arbitrary = runColdClone(repo, ["Makefile"]);
    const arbitraryOutput = `${arbitrary.stdout}${arbitrary.stderr}`;
    assert.notEqual(arbitrary.status, 0, `${label}: arbitrary Make target passed`);
    assert.match(arbitraryOutput, /invalid verify target Makefile/);
    assert.equal(
      arbitraryOutput.includes("cloning HEAD"),
      false,
      `${label}: arbitrary Make target reached cloning`,
    );

    const colon = runColdClone(repo, ["verify-colon:target"]);
    const colonOutput = `${colon.stdout}${colon.stderr}`;
    assert.notEqual(colon.status, 0, `${label}: colon target escaped the verify-target grammar`);
    assert.match(colonOutput, /invalid verify target verify-colon:target/);
    assert.equal(
      colonOutput.includes("cloning HEAD"),
      false,
      `${label}: colon target reached cloning`,
    );

    const seedStore = resolve(temporary, "pnpm-store");
    mkdirSync(resolve(seedStore, "files"), { recursive: true });
    mkdirSync(resolve(seedStore, "index"), { recursive: true });
    mkdirSync(resolve(repo, "node_modules"));
    writeFileSync(resolve(repo, "node_modules/.modules.yaml"), `storeDir: ${seedStore}\n`);
    const missing = runColdClone(repo, ["verify-missing"]);
    const missingOutput = `${missing.stdout}${missing.stderr}`;
    assert.notEqual(missing.status, 0, `${label}: missing target passed`);
    assert.match(
      missingOutput,
      /make target verify-missing has no applicable committed recipe closure/,
    );
    assert.equal(
      missingOutput.includes("hydrating dependencies"),
      false,
      `${label}: missing target reached dependency hydration`,
    );
    assert.equal(missingOutput.includes("PASSED from a pristine clone"), false);

    const broken = runColdClone(repo, ["verify-broken"]);
    const brokenOutput = `${broken.stdout}${broken.stderr}`;
    assert.notEqual(broken.status, 0, `${label}: broken declared target passed`);
    assert.match(
      brokenOutput,
      /make target verify-broken has no applicable committed recipe closure/,
    );
    assert.equal(
      brokenOutput.includes("hydrating dependencies"),
      false,
      `${label}: broken declared target reached dependency hydration`,
    );
    assert.equal(brokenOutput.includes("PASSED from a pristine clone"), false);
    const emptyRule = runColdClone(repo, ["verify-empty-rule"]);
    const emptyRuleOutput = `${emptyRule.stdout}${emptyRule.stderr}`;
    assert.notEqual(emptyRule.status, 0, `${label}: empty rule passed`);
    assert.match(emptyRuleOutput, /does not schedule its registered success marker/);
    assert.equal(emptyRuleOutput.includes("hydrating dependencies"), false);
    assert.equal(emptyRuleOutput.includes("PASSED from a pristine clone"), false);

    const emptyPhony = runColdClone(repo, ["verify-empty-phony"]);
    const emptyPhonyOutput = `${emptyPhony.stdout}${emptyPhony.stderr}`;
    assert.notEqual(emptyPhony.status, 0, `${label}: empty phony rule passed`);
    assert.match(emptyPhonyOutput, /does not schedule its registered success marker/);
    assert.equal(emptyPhonyOutput.includes("hydrating dependencies"), false);
    assert.equal(emptyPhonyOutput.includes("PASSED from a pristine clone"), false);
    rmSync(resolve(repo, "node_modules"), { recursive: true, force: true });

    const existingFile = runColdClone(repo, ["verify-existing-file"]);
    const existingFileOutput = `${existingFile.stdout}${existingFile.stderr}`;
    assert.notEqual(existingFile.status, 0, `${label}: undeclared committed file passed`);
    assert.match(existingFileOutput, /does not schedule its registered success marker/);
    assert.equal(existingFileOutput.includes("Nothing to be done"), false);
    assert.equal(existingFileOutput.includes("PASSED from a pristine clone"), false);

    const existingDirectory = runColdClone(repo, ["verify-existing-dir"]);
    const existingDirectoryOutput = `${existingDirectory.stdout}${existingDirectory.stderr}`;
    assert.notEqual(existingDirectory.status, 0, `${label}: undeclared committed directory passed`);
    assert.match(existingDirectoryOutput, /does not schedule its registered success marker/);
    assert.equal(existingDirectoryOutput.includes("Nothing to be done"), false);
    assert.equal(existingDirectoryOutput.includes("PASSED from a pristine clone"), false);

    const forgedFile = runColdClone(repo, ["verify-forged-file"]);
    const forgedFileOutput = `${forgedFile.stdout}${forgedFile.stderr}`;
    assert.notEqual(forgedFile.status, 0, `${label}: rule-shaped variable plus file passed`);
    assert.match(forgedFileOutput, /does not schedule its registered success marker/);
    assert.equal(forgedFileOutput.includes("PASSED from a pristine clone"), false);

    const forgedDirectory = runColdClone(repo, ["verify-forged-dir"]);
    const forgedDirectoryOutput = `${forgedDirectory.stdout}${forgedDirectory.stderr}`;
    assert.notEqual(
      forgedDirectory.status,
      0,
      `${label}: rule-shaped variable plus directory passed`,
    );
    assert.match(forgedDirectoryOutput, /does not schedule its registered success marker/);
    assert.equal(forgedDirectoryOutput.includes("PASSED from a pristine clone"), false);

    const ambient = runColdClone(repo, ["verify-ambient-injection"], {
      MAKEFILES: ambientMakefile,
    });
    const ambientOutput = `${ambient.stdout}${ambient.stderr}`;
    assert.notEqual(ambient.status, 0, `${label}: ambient Make target passed`);
    assert.match(
      ambientOutput,
      /make target verify-ambient-injection has no applicable committed recipe closure/,
    );
    assert.equal(ambientOutput.includes("AMBIENT_MAKEFILE_EXECUTED"), false);
    assert.equal(ambientOutput.includes("PASSED from a pristine clone"), false);

    const bashEnvironmentInjection = runColdClone(repo, ["verify-ambient-injection"], {
      BASH_ENV: bashEnvironment,
    });
    const bashEnvironmentOutput = `${bashEnvironmentInjection.stdout}${bashEnvironmentInjection.stderr}`;
    assert.notEqual(
      bashEnvironmentInjection.status,
      0,
      `${label}: BASH_ENV-injected Make target passed`,
    );
    assert.match(
      bashEnvironmentOutput,
      /make target verify-ambient-injection has no applicable committed recipe closure/,
    );
    assert.equal(bashEnvironmentOutput.includes("AMBIENT_MAKEFILE_EXECUTED"), false);
    assert.equal(bashEnvironmentOutput.includes("PASSED from a pristine clone"), false);

    const functionInjection = runColdClone(repo, ["verify-function-injection"], {
      "BASH_FUNC_make%%":
        '() { local final_argument=; for final_argument in "$@"; do :; done; if [ "${1:-}" = -rR ]; then printf \'echo "%s: OK"\\n\' "$final_argument"; else printf \'%s: OK\\n\' "$final_argument"; fi; }',
    });
    const functionInjectionOutput = `${functionInjection.stdout}${functionInjection.stderr}`;
    assert.notEqual(functionInjection.status, 0, `${label}: exported make function passed`);
    assert.match(
      functionInjectionOutput,
      /make target verify-function-injection has no applicable committed recipe closure/,
    );
    assert.equal(functionInjectionOutput.includes("verify-function-injection: OK"), false);
    assert.equal(functionInjectionOutput.includes("PASSED from a pristine clone"), false);

    const unregistered = runColdClone(repo, ["verify-unregistered"]);
    const unregisteredOutput = `${unregistered.stdout}${unregistered.stderr}`;
    assert.notEqual(unregistered.status, 0, `${label}: unregistered committed recipe passed`);
    assert.match(unregisteredOutput, /is not in the committed cold-clone registry/);
    assert.equal(unregisteredOutput.includes("verify-unregistered: OK"), false);
    assert.equal(unregisteredOutput.includes("PASSED from a pristine clone"), false);

    const silentMarker = runColdClone(repo, ["verify-silent-marker"]);
    const silentMarkerOutput = `${silentMarker.stdout}${silentMarker.stderr}`;
    assert.notEqual(silentMarker.status, 0, `${label}: non-emitted scheduled marker passed`);
    assert.match(silentMarkerOutput, /exited zero without its registered success marker/);
    assert.equal(silentMarkerOutput.includes("PASSED from a pristine clone"), false);

    const positive = runColdClone(repo, ["verify-sentinel"]);
    const positiveOutput = `${positive.stdout}${positive.stderr}`;
    assert.equal(positive.status, 0, `${label}: declared target failed\n${positiveOutput}`);
    assert.match(positiveOutput, /COLD_CLONE_SENTINEL_EXECUTED/);
    assert.match(positiveOutput, /^verify-sentinel: OK$/m);
    assert.match(positiveOutput, /verify-sentinel PASSED from a pristine clone/);

    const inheritedGitFunction = runColdClone(repo, ["verify-sentinel"], {
      "BASH_FUNC_builtin%%": '() { echo INHERITED_BUILTIN_FUNCTION_EXECUTED "$@"; }',
      "BASH_FUNC_compgen%%": "() { :; }",
      "BASH_FUNC_git%%": '() { echo INHERITED_GIT_FUNCTION_EXECUTED; command git "$@"; }',
      "BASH_FUNC_unset%%": "() { :; }",
    });
    const inheritedGitOutput = `${inheritedGitFunction.stdout}${inheritedGitFunction.stderr}`;
    assert.equal(
      inheritedGitFunction.status,
      0,
      `${label}: inherited git function prevented the registered target`,
    );
    assert.equal(inheritedGitOutput.includes("INHERITED_BUILTIN_FUNCTION_EXECUTED"), false);
    assert.equal(inheritedGitOutput.includes("INHERITED_GIT_FUNCTION_EXECUTED"), false);
    assert.match(inheritedGitOutput, /^verify-sentinel: OK$/m);
    assert.match(inheritedGitOutput, /verify-sentinel PASSED from a pristine clone/);
    return 17;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const coldCloneMutations = [
  {
    name: "cold-clone-privileged-reexec",
    from: 'if [[ "$-" != *p* ]]; then',
    to: "if false; then",
  },
  {
    name: "cold-clone-verify-target-only",
    from: "verify-*) ;;",
    to: "*) ;;",
  },
  {
    name: "cold-clone-target-character-boundary",
    from: "verify-|*[!A-Za-z0-9_.-]*)",
    to: "verify-)",
  },
  {
    name: "cold-clone-make-environment",
    from:
      'while IFS= read -r v; do unset_args+=(-u "$v"); done \\\n' +
      "  < <(env | sed -n 's/^\\(MAKE[A-Za-z0-9_]*\\)=.*/\\1/p')",
    to: ": # mutation: preserve ambient MAKE variables",
  },
  {
    name: "cold-clone-shell-startup-environment",
    from: "  -u BASH_ENV -u ENV",
    to: "  # mutation: preserve non-interactive shell startup hooks",
  },
  {
    name: "cold-clone-target-before-hydration",
    from: '    target_plan="$(mktemp)"\n    set +e',
    to: '    hydrate_dependencies "$2"\n    target_plan="$(mktemp)"\n    set +e',
  },
  {
    name: "cold-clone-target-registry",
    from: '    if [ "$registered" -ne 1 ]; then',
    to: "    if false; then",
  },
  {
    name: "cold-clone-scheduled-success-marker",
    from: '    if [ "$marker_scheduled" -ne 1 ]; then',
    to: "    if false; then",
  },
  {
    name: "cold-clone-resolved-make-command",
    from: '    make_command="$4"',
    to: "    make_command=make",
  },
  {
    name: "cold-clone-exact-target-execution",
    from: '    target_output="$("$make_command" -- "$3" 2>&1)"',
    to: '    target_output="$("$make_command" --version 2>&1)"',
  },
  {
    name: "cold-clone-emitted-success-marker",
    from: '    if [ "$marker_emitted" -ne 1 ]; then',
    to: "    if false; then",
  },
];

function runRecord(run, verdict = "refuted") {
  const heading = `### 2026-07-16 — judge${run === 1 ? "" : ` round ${run}`} — VERDICT: ${verdict}`;
  const entry = `${heading}\n\n- **Finding ${run}.** Prediction and observation with report/path-${run}.md:${run}. Demand: fix.`;
  return {
    run,
    verdict,
    findings: [`**Finding ${run}.** Prediction and observation.`],
    promoted: [`test-${run}`],
    report: entry,
    logEntry: entry,
    entryDigest: digest(String((run % 6) + 1)),
  };
}

function progressFor(taskPath, run) {
  return {
    assessment: "progressing",
    rationale: "Earlier findings closed through a general invariant.",
    evidence: [
      {
        kind: "report",
        ref: `${taskPath}#judge-run-${run}`,
        supports: "The previous counterexample is now rejected while older cases remain green.",
      },
    ],
    nextFocus: ["Exercise the next compositional boundary."],
  };
}

const citedProgress = progressFor(TASK_PATH, 6);

function auditEntry(firstRun, lastRun, progress = citedProgress) {
  const assessment = progress.assessment ?? "progressing";
  return [
    `### 2026-07-16 — progress critic — RUNS ${firstRun}-${lastRun}: ${assessment}`,
    "",
    `- Rationale: ${progress.rationale}`,
    ...progress.evidence.map((item) => `- Evidence (${item.kind}): ${item.ref} — ${item.supports}`),
    ...progress.nextFocus.map((item) => `- Next focus: ${item}`),
    `- Assessment: ${assessment}`,
  ].join("\n");
}

function mutatePinnedEntryByte(readme, heading) {
  const marker = `### ${heading}\n`;
  const start = readme.indexOf(marker);
  assert.notEqual(start, -1, `missing pinned E3-T06 entry ${heading}`);
  const bodyStart = start + marker.length;
  const next = readme.indexOf("\n### ", bodyStart);
  const end = next === -1 ? readme.length : next;
  const body = readme.slice(bodyStart, end);
  const relative = body.search(/[A-Za-z0-9]/);
  assert.notEqual(relative, -1, `pinned E3-T06 entry ${heading} has no mutable byte`);
  const index = bodyStart + relative;
  const replacement = readme[index] === "a" ? "b" : "a";
  return `${readme.slice(0, index)}${replacement}${readme.slice(index + 1)}`;
}

function addPinnedEntryTrailingSpace(readme, heading) {
  const marker = `### ${heading}\n`;
  const start = readme.indexOf(marker);
  assert.notEqual(start, -1, `missing pinned E3-T06 entry ${heading}`);
  const nextHeading = readme.indexOf("\n### ", start + marker.length);
  const sectionEnd = nextHeading === -1 ? readme.length : nextHeading + 1;
  let finalByte = sectionEnd - 1;
  while (finalByte >= start && /\s/.test(readme[finalByte])) finalByte -= 1;
  assert.equal(finalByte >= start, true, `pinned E3-T06 entry ${heading} has no final byte`);
  const insertion = finalByte + 1;
  return `${readme.slice(0, insertion)} ${readme.slice(insertion)}`;
}

function movePinnedEntryBefore(readme, heading, beforeHeading) {
  const marker = `### ${heading}`;
  const start = readme.indexOf(marker);
  assert.notEqual(start, -1, `missing movable E3-T06 entry ${heading}`);
  const next = readme.indexOf("\n### ", start + marker.length);
  const end = next === -1 ? readme.length : next;
  const entry = readme.slice(start, end).trim();
  const withoutEntry = `${readme.slice(0, start)}${readme.slice(end)}`;
  const before = withoutEntry.indexOf(`### ${beforeHeading}`);
  assert.notEqual(before, -1, `missing E3-T06 insertion entry ${beforeHeading}`);
  return `${withoutEntry.slice(0, before)}${entry}\n\n${withoutEntry.slice(before)}`;
}

function removeHeadingSection(readme, heading) {
  const marker = `### ${heading}`;
  const start = readme.indexOf(marker);
  assert.notEqual(start, -1, `missing removable section ${heading}`);
  const next = readme.indexOf("\n### ", start + marker.length);
  const end = next === -1 ? readme.length : next;
  return `${readme.slice(0, start)}${readme.slice(end)}`;
}

function e3T06Audit(firstRun, lastRun, digestRef, assessment = "insufficient-evidence") {
  return auditEntry(firstRun, lastRun, {
    assessment,
    rationale: `Runs ${firstRun}-${lastRun} spent the checkpoint without a timely progress audit.`,
    evidence: [
      {
        kind: "digest",
        ref: digestRef,
        supports: `The exact migrated run ${lastRun} verdict closes this checkpoint.`,
      },
    ],
    nextFocus: ["Use the bounded run-9 window only for the dead-condition deletion reproof."],
  });
}

function e3T06RecoveryAuthorization(module, readme, stoppedLedger, overrides = {}) {
  const ledger = module.parseVerificationLedger(readme, {
    taskId: E3_T06_TASK_ID,
    auditStart: 3,
  });
  const request = module.recoveryRequest(readme, { taskId: E3_T06_TASK_ID });
  return {
    ...request,
    resumeCommit: request.resumeCommit ?? commits[4],
    approvalPathsVerified: true,
    ceilingIntroducedVerified: true,
    checkpointAuditInherited: false,
    checkpointAssessment: "insufficient-evidence",
    checkpointOverrideVerified: true,
    controlParentVerified: true,
    historyPrefixVerified: true,
    invalidLoopStatusVerified: true,
    priorRunCount: 8,
    priorAuditCount: 0,
    priorAuditEntryDigestsDigest: module.sha256(JSON.stringify([])),
    priorLedgerDigest: stoppedLedger.ledgerDigest,
    priorRunEntryDigestsDigest: module.sha256(JSON.stringify(stoppedLedger.runEntryDigests)),
    resumeAuditCount: ledger.auditEntryDigests.length,
    resumeAuditEntryDigestsDigest: module.sha256(JSON.stringify(ledger.auditEntryDigests)),
    resumeAncestorVerified: true,
    resumeParentVerified: true,
    resumeRunCount: 8,
    resumeRunEntryDigestsDigest: module.sha256(JSON.stringify(ledger.runEntryDigests)),
    sameGateVerified: true,
    statusReasonDigest: digest("8"),
    statusReasonVerified: true,
    ...overrides,
  };
}

function e3T06WorkflowSnapshot(options = {}) {
  const progress = {
    assessment: "insufficient-evidence",
    rationale: "Runs 4-6 lacked the mandatory timely progress audit.",
    evidence: [
      {
        kind: "digest",
        ref: E3_T06_MIGRATED_RUNS[5].digest,
        supports: "The exact run-6 needs-evidence verdict closes the checkpoint.",
      },
    ],
    nextFocus: ["Delete and reprove only the dead route-decoder condition in run 9."],
  };
  const value = snapshot(options.count ?? 8, {
    taskId: E3_T06_TASK_ID,
    taskPath: E3_T06_TASK_PATH,
    status: options.status ?? "in-progress",
    runCeiling: 9,
    recoveryBaseRun: 8,
    progressAuditedThrough: 6,
    firstAuditRun: 4,
    progress,
    latestAudit: {
      firstRun: 4,
      lastRun: 6,
      assessment: "insufficient-evidence",
      rationale: progress.rationale,
      evidence: structuredClone(progress.evidence),
      nextFocus: structuredClone(progress.nextFocus),
      entry: e3T06Audit(4, 6, E3_T06_MIGRATED_RUNS[5].digest),
      entryDigest: digest("6"),
    },
    auditEntryDigests: [digest("3"), digest("6")],
    commit: options.commit ?? commits[0],
    lastVerdict: options.lastVerdict,
  });
  value.recoveryAuthorization = {
    ...value.recoveryAuthorization,
    invalidLoopCommit: E3_T06_STOPPED_COMMIT,
    checkpointAuditInherited: false,
    checkpointAssessment: "insufficient-evidence",
    checkpointOverrideVerified: true,
    priorAuditCount: 0,
    resumeAuditCount: 2,
    priorAuditEntryDigestsDigest: sha256(JSON.stringify([])),
    resumeAuditEntryDigestsDigest: sha256(JSON.stringify(value.auditEntryDigests)),
  };
  return value;
}

function snapshot(count, options = {}) {
  const taskId = options.taskId ?? TASK_ID;
  const taskPath = options.taskPath ?? (taskId === TASK_ID ? TASK_PATH : ORDINARY_TASK_PATH);
  const status = options.status ?? (count === 0 ? "pending" : "refuted");
  const progressAuditedThrough = options.progressAuditedThrough ?? 0;
  const auditStart = options.auditStart ?? (taskId === TASK_ID ? 6 : 3);
  const lastVerdict = options.lastVerdict ?? (status === "verified" ? "verified" : "refuted");
  const allRuns = Array.from({ length: count }, (_, index) =>
    runRecord(index + 1, index + 1 === count ? lastVerdict : "refuted"),
  );
  const firstAuditRun = options.firstAuditRun ?? Math.max(1, progressAuditedThrough - 2);
  const auditEnds =
    progressAuditedThrough === 0
      ? []
      : Array.from(
          { length: (progressAuditedThrough - auditStart) / 3 + 1 },
          (_, index) => auditStart + index * 3,
        );
  const auditEntryDigests =
    options.auditEntryDigests ?? auditEnds.map((value) => digest(String(value)));
  const latestAudit = Object.hasOwn(options, "latestAudit")
    ? options.latestAudit
    : progressAuditedThrough === 0
      ? null
      : {
          firstRun: firstAuditRun,
          lastRun: progressAuditedThrough,
          assessment: "progressing",
          rationale: (options.progress ?? citedProgress).rationale,
          evidence: structuredClone((options.progress ?? citedProgress).evidence),
          nextFocus: structuredClone((options.progress ?? citedProgress).nextFocus),
          entry:
            options.auditEntry ??
            auditEntry(firstAuditRun, progressAuditedThrough, options.progress),
          entryDigest: auditEntryDigests.at(-1),
        };
  const runEntryDigests = options.runEntryDigests ?? allRuns.map((run) => run.entryDigest);
  const ledgerDigest =
    options.ledgerDigest ??
    sha256(
      JSON.stringify({
        runs: allRuns.map((run, index) => [run.run, run.verdict, runEntryDigests[index]]),
        audits: auditEnds.map((lastRun, index) => [lastRun - 2, lastRun, auditEntryDigests[index]]),
      }),
    );
  const evidenceCatalog =
    options.evidenceCatalog ??
    allRuns.slice(-3).flatMap((run) => [
      {
        kind: "report",
        ref: `${taskPath}#judge-run-${run.run}`,
        verifier: "ledger-entry",
        target: run.entryDigest,
      },
      {
        kind: "digest",
        ref: run.entryDigest,
        verifier: "ledger-entry-digest",
        target: `${taskPath}#judge-run-${run.run}`,
      },
    ]);
  const runCeiling = options.runCeiling ?? 10;
  const recoveryBaseRun = options.recoveryBaseRun ?? runCeiling - 3;
  const recoveryAuthorization = Object.hasOwn(options, "recoveryAuthorization")
    ? options.recoveryAuthorization
    : runCeiling === 10
      ? null
      : {
          authorizedCeiling: runCeiling,
          baseRun: recoveryBaseRun,
          controlCommit: commits[2],
          invalidLoopCommit: commits[3],
          resumeCommit: commits[4],
          date: "2026-07-16",
          entryDigest: digest("7"),
          firstRun: recoveryBaseRun + 1,
          lastRun: runCeiling,
          priorRunCount: recoveryBaseRun,
          resumeRunCount: recoveryBaseRun,
          priorAuditCount: auditEntryDigests.length,
          resumeAuditCount: auditEntryDigests.length,
          priorLedgerDigest: ledgerDigest,
          priorRunEntryDigestsDigest: sha256(
            JSON.stringify(runEntryDigests.slice(0, recoveryBaseRun)),
          ),
          priorAuditEntryDigestsDigest: sha256(JSON.stringify(auditEntryDigests)),
          resumeRunEntryDigestsDigest: sha256(
            JSON.stringify(runEntryDigests.slice(0, recoveryBaseRun)),
          ),
          resumeAuditEntryDigestsDigest: sha256(JSON.stringify(auditEntryDigests)),
          resumeParentVerified: true,
          resumeAncestorVerified: true,
          controlParentVerified: true,
          historyPrefixVerified: true,
          invalidLoopStatusVerified: true,
          ceilingIntroducedVerified: true,
          statusReasonVerified: true,
          approvalPathsVerified: true,
          checkpointAuditInherited:
            recoveryBaseRun % 3 === 0 && latestAudit?.lastRun === recoveryBaseRun,
          checkpointAssessment:
            recoveryBaseRun % 3 === 0 ? (latestAudit?.assessment ?? "death-spiral") : null,
          checkpointOverrideVerified: recoveryBaseRun % 3 !== 0 || latestAudit !== null,
          sameGateVerified: true,
          statusReasonDigest: digest("8"),
        };
  return {
    schemaVersion: 2,
    sourceCommit: options.commit ?? commits[0],
    attesterSourceCommit: options.attesterSourceCommit ?? options.commit ?? commits[0],
    attesterDigest: options.attesterDigest ?? digest("b"),
    controlDigest: options.controlDigest ?? digest("c"),
    transitionBaseCommit: options.transitionBaseCommit ?? null,
    transitionBaseIsDirectParent: Object.hasOwn(options, "transitionBaseIsDirectParent")
      ? options.transitionBaseIsDirectParent
      : options.transitionBaseCommit
        ? true
        : null,
    changedPaths: options.changedPaths ?? [],
    projectDigest: digest("8"),
    queueDigest: digest("9"),
    taskDigest: digest("a"),
    projectStatus: Object.hasOwn(options, "projectStatus") ? options.projectStatus : "building",
    currentGateTaskId:
      options.currentGateTaskId ??
      (status === "verified" ? (options.nextTaskId ?? "E2-T03") : taskId),
    taskId,
    taskPath,
    status,
    runCeiling,
    recoveryAuthorization,
    auditStart,
    auditEnds,
    auditEntryDigests,
    progressAuditedThrough,
    runCount: count,
    runEntryDigests,
    ledgerDigest,
    runs: allRuns.slice(-3),
    latestAudit,
    evidenceCatalog,
  };
}

function rewriteRunEntry(value, run, replacementDigest) {
  const rewritten = structuredClone(value);
  rewritten.runEntryDigests[run - 1] = replacementDigest;
  const visible = rewritten.runs.find((entry) => entry.run === run);
  if (visible) {
    visible.entryDigest = replacementDigest;
    visible.findings = [`Rewritten finding ${run}`];
    visible.report = visible.report.replace(`Finding ${run}`, `Rewritten ${run}`);
    visible.logEntry = visible.report;
  }
  rewritten.ledgerDigest = digest("e");
  return rewritten;
}

function verdict(before, after, overrides = {}) {
  return {
    taskId: before.taskId,
    verdict: after.runs.at(-1).verdict,
    baseCommit: before.sourceCommit,
    commitOid: after.sourceCommit,
    findings: [{ kind: "other", citation: "report/path.md:1" }],
    promoted: [],
    report: after.runs.at(-1).report,
    logEntry: after.runs.at(-1).logEntry,
    ...overrides,
  };
}

const serialized = (value) => `${JSON.stringify(value)}\n`;

async function executeWorkQueue(source, options = {}) {
  const runWorkflow = compile(source);
  const defaultInitial = snapshot(0, { status: "pending", commit: commits[0] });
  const defaultImplemented = snapshot(0, { status: "implemented", commit: commits[1] });
  const defaultVerified = snapshot(1, {
    status: "verified",
    lastVerdict: "verified",
    commit: commits[2],
  });
  const suppliedSnapshots = options.readerSnapshots ?? [
    defaultInitial,
    defaultImplemented,
    defaultVerified,
  ];
  let previousSourceCommit = null;
  const readerSnapshots = suppliedSnapshots.map((supplied, index) => {
    const link = (value) => {
      if (!value || options.rawReaderSnapshots) return value;
      if (index === 0) {
        return {
          ...value,
          attesterSourceCommit: value.sourceCommit,
          transitionBaseCommit: null,
          transitionBaseIsDirectParent: null,
          changedPaths: [],
        };
      }
      return {
        ...value,
        attesterSourceCommit: previousSourceCommit,
        transitionBaseCommit: previousSourceCommit,
        transitionBaseIsDirectParent: true,
        changedPaths:
          value.changedPaths.length > 0
            ? value.changedPaths
            : [value.taskPath, ".eforest/tasks/QUEUE.md"].sort(),
      };
    };
    const linked =
      supplied && Object.hasOwn(supplied, "a")
        ? { a: link(supplied.a), b: link(supplied.b) }
        : link(supplied);
    previousSourceCommit = (linked?.a ?? linked)?.sourceCommit ?? previousSourceCommit;
    return linked;
  });
  const verdicts = [...(options.verdicts ?? [verdict(defaultImplemented, defaultVerified)])];
  const progressResults = [...(options.progressResults ?? [])];
  const previewResults = [...(options.previewResults ?? [])];
  const commitResults = [...(options.commitResults ?? [])];
  const invalidResults = [...(options.invalidResults ?? [])];
  const events = [];
  const logs = [];
  const labels = [];
  const implementArguments = [];
  let readerCalls = 0;

  const agent = async (_prompt, agentOptions) => {
    labels.push(agentOptions.label);
    if (agentOptions.label.startsWith("queue-snapshot:")) {
      const logicalRead = Math.floor(readerCalls / 2);
      const reader = agentOptions.label.endsWith(":a") ? "a" : "b";
      readerCalls += 1;
      const supplied = readerSnapshots[logicalRead];
      if (supplied === undefined) return undefined;
      if (supplied && Object.hasOwn(supplied, "a") && Object.hasOwn(supplied, "b")) {
        return { snapshot: serialized(supplied[reader]) };
      }
      return { snapshot: serialized(supplied) };
    }
    if (agentOptions.label.startsWith("progress-critic:")) {
      events.push("progress");
      return progressResults.shift();
    }
    if (agentOptions.label.startsWith("progress-preview:")) {
      events.push("progress-preview");
      return previewResults.shift();
    }
    if (agentOptions.label.startsWith("record-progress-audit:")) {
      events.push("record-progress");
      return commitResults.shift();
    }
    if (agentOptions.label === "flip-invalid-loop") {
      events.push("invalid-loop");
      return invalidResults.shift() ?? { baseCommit: "", commitOid: "" };
    }
    throw new Error(`unexpected agent ${agentOptions.label}`);
  };

  const workflow = async (name, workflowArguments) => {
    if (name === "implement-task") {
      events.push("implement");
      implementArguments.push(workflowArguments);
      return { claimed: true, taskId: workflowArguments.task };
    }
    if (name === "verify-task") {
      events.push("verify");
      return verdicts.shift();
    }
    if (name === "decompose-task") {
      events.push("decompose");
      return options.decompositionResult;
    }
    if (name === "work-queue") {
      events.push("decomposition-probation");
      return options.probationResult;
    }
    throw new Error(`unexpected workflow ${name}`);
  };

  const result = await runWorkflow(
    agent,
    workflow,
    async (tasks) => Promise.all(tasks.map((task) => task())),
    () => {},
    (message) => logs.push(message),
    { total: 0, remaining: () => Number.POSITIVE_INFINITY },
    options.args ?? { tasks: 1 },
  );
  return { events, implementArguments, labels, logs, result };
}

async function verifyWorkQueuePolicy(source) {
  let scenarios = 0;

  assert.match(
    source,
    /git show \$\{attesterCommit\}:\$\{SNAPSHOT_SCRIPT\} \| node --input-type=module - --attester/,
  );
  scenarios += 1;

  for (const invalidMaxRuns of [0, -2, 2.5, "3", Number.NaN, 101]) {
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: invalidMaxRuns },
    });
    assert.equal(run.result.refused, "invalid maxRuns");
    assert.deepEqual(run.labels, []);
    scenarios += 1;
  }
  {
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: 11 },
      readerSnapshots: [snapshot(10, { status: "refuted", progressAuditedThrough: 9 })],
    });
    assert.equal(run.result.refused, "maxRuns exceeds committed ceiling");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }
  {
    const a = e3T06WorkflowSnapshot({ status: "in-progress", commit: commits[0] });
    const b = e3T06WorkflowSnapshot({ status: "implemented", commit: commits[1] });
    const c = e3T06WorkflowSnapshot({
      count: 9,
      status: "verified",
      lastVerdict: "verified",
      commit: commits[2],
    });
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: 9 },
      readerSnapshots: [a, b, c],
      verdicts: [verdict(b, c)],
    });
    assert.deepEqual(run.events, ["implement", "verify"]);
    assert.equal(run.result.completed[0].runs, 9);
    assert.equal(run.result.completed[0].verdict, "verified");
    scenarios += 1;
  }

  for (const corruptRecovery of [
    (value) => ({
      ...value,
      latestAudit: { ...value.latestAudit, assessment: "progressing" },
      recoveryAuthorization: {
        ...value.recoveryAuthorization,
        baseRun: 7,
        firstRun: 8,
        priorRunCount: 7,
        resumeRunCount: 7,
      },
    }),
    (value) => ({
      ...value,
      latestAudit: { ...value.latestAudit, assessment: "progressing" },
      recoveryAuthorization: {
        ...value.recoveryAuthorization,
        invalidLoopCommit: commits[3],
      },
    }),
    (value) => ({
      ...value,
      recoveryAuthorization: {
        ...value.recoveryAuthorization,
        controlCommit: null,
        controlParentVerified: null,
      },
    }),
    (value) => ({
      ...value,
      recoveryAuthorization: { ...value.recoveryAuthorization, priorAuditCount: 1 },
    }),
    (value) => ({
      ...value,
      recoveryAuthorization: { ...value.recoveryAuthorization, resumeAuditCount: 1 },
    }),
    (value) => ({
      ...value,
      recoveryAuthorization: {
        ...value.recoveryAuthorization,
        checkpointAuditInherited: true,
      },
    }),
    (value) => ({
      ...value,
      recoveryAuthorization: {
        ...value.recoveryAuthorization,
        checkpointAssessment: "death-spiral",
      },
    }),
    (value) => ({ ...value, auditEnds: [3], auditEntryDigests: [digest("3")] }),
    (value) => ({
      ...value,
      taskId: "E3-T07",
      currentGateTaskId: "E3-T07",
      taskPath: ".eforest/tasks/epic-3-the-canopy/E3-T07-file-view-live/readme.md",
    }),
  ]) {
    const malformed = corruptRecovery(e3T06WorkflowSnapshot());
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: 9 },
      readerSnapshots: [malformed],
    });
    assert.equal(run.result.refused, "invalid committed gate snapshot");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }
  {
    const stoppedWhileBuilding = e3T06WorkflowSnapshot();
    stoppedWhileBuilding.runCeiling = 10;
    stoppedWhileBuilding.recoveryAuthorization = null;
    stoppedWhileBuilding.latestAudit = {
      ...stoppedWhileBuilding.latestAudit,
      assessment: "progressing",
    };
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: 10 },
      readerSnapshots: [stoppedWhileBuilding],
    });
    assert.equal(run.result.refused, "invalid committed gate snapshot");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }
  {
    const run = await executeWorkQueue(source, { args: { tasks: 1, maxRetries: 2 } });
    assert.equal(run.result.refused, "unsupported maxRetries");
    assert.deepEqual(run.labels, []);
    scenarios += 1;
  }

  {
    const a = snapshot(7, {
      status: "in-progress",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: null,
      changedPaths: [],
    });
    const b = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[1],
    });
    const c = snapshot(8, {
      status: "verified",
      lastVerdict: "verified",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[2],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      verdicts: [verdict(b, c)],
    });
    assert.equal(run.result.completed[0].runs, 8);
    assert.equal(run.result.completed[0].verdict, "verified");
    assert.equal(run.implementArguments[0].rework, true);
    assert.match(run.implementArguments[0].report, /Finding 7/);
    scenarios += 1;
  }

  {
    const base = snapshot(0, { status: "pending", commit: commits[0] });
    const other = { ...base, queueDigest: digest("b") };
    const run = await executeWorkQueue(source, { readerSnapshots: [{ a: base, b: other }] });
    assert.equal(run.result.refused, "invalid committed gate snapshot");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  for (const stale of [
    snapshot(4, { taskId: ORDINARY_TASK_ID, status: "refuted", progressAuditedThrough: 0 }),
    snapshot(5, { taskId: ORDINARY_TASK_ID, status: "refuted", progressAuditedThrough: 0 }),
    snapshot(7, { taskId: ORDINARY_TASK_ID, status: "refuted", progressAuditedThrough: 3 }),
    snapshot(8, { taskId: ORDINARY_TASK_ID, status: "refuted", progressAuditedThrough: 3 }),
    snapshot(10, { taskId: ORDINARY_TASK_ID, status: "refuted", progressAuditedThrough: 6 }),
  ]) {
    const run = await executeWorkQueue(source, { readerSnapshots: [stale] });
    assert.equal(run.result.refused, "invalid committed gate snapshot");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  for (const malformed of [
    snapshot(6, { status: "pending", progressAuditedThrough: 6 }),
    snapshot(0, { status: "pending", taskPath: ".eforest/tasks/epic-9/E2-T01-wrong/readme.md" }),
    snapshot(0, { status: "pending", projectStatus: undefined }),
    snapshot(0, {
      status: "pending",
      evidenceCatalog: [
        { kind: "fixture", ref: "AGENTS.md:1", verifier: "git-path", target: "other.md:1" },
      ],
    }),
    snapshot(6, {
      status: "refuted",
      progressAuditedThrough: 6,
      latestAudit: {
        ...snapshot(6, { progressAuditedThrough: 6 }).latestAudit,
        assessment: "death-spiral",
      },
    }),
    snapshot(11, {
      status: "refuted",
      runCeiling: 10,
      progressAuditedThrough: 9,
      firstAuditRun: 7,
    }),
    snapshot(10, {
      status: "refuted",
      runCeiling: 13,
      progressAuditedThrough: 9,
      recoveryAuthorization: {
        ...snapshot(10, { runCeiling: 13 }).recoveryAuthorization,
        statusReasonVerified: false,
      },
    }),
  ]) {
    const run = await executeWorkQueue(source, { readerSnapshots: [malformed] });
    assert.equal(run.result.refused, "invalid committed gate snapshot");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  {
    const ordinaryProgress = progressFor(ORDINARY_TASK_PATH, 3);
    const a = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      commit: commits[0],
    });
    const b = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "in-progress",
      progressAuditedThrough: 3,
      commit: commits[1],
      progress: ordinaryProgress,
    });
    const c = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "implemented",
      progressAuditedThrough: 3,
      commit: commits[2],
      progress: ordinaryProgress,
    });
    const d = snapshot(4, {
      taskId: ORDINARY_TASK_ID,
      status: "verified",
      lastVerdict: "verified",
      progressAuditedThrough: 3,
      commit: commits[3],
      progress: ordinaryProgress,
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c, d],
      progressResults: [structuredClone(ordinaryProgress)],
      commitResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
      verdicts: [verdict(c, d)],
    });
    assert.deepEqual(run.events, ["progress", "record-progress", "implement", "verify"]);
    assert.equal(run.result.completed[0].runs, 4);
    scenarios += 1;
  }

  for (const rejectedProgress of [
    undefined,
    { ...citedProgress, rationale: "" },
    { ...citedProgress, evidence: [] },
    {
      ...citedProgress,
      evidence: [{ kind: "report", ref: "not-a-citation", supports: "Nothing resolvable." }],
    },
    { ...citedProgress, nextFocus: [] },
  ]) {
    const a = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      commit: commits[0],
    });
    const b = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      projectStatus: "invalid_loop",
      commit: commits[1],
      changedPaths: [".eforest/project.json"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b],
      progressResults: [rejectedProgress],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.events.includes("record-progress"), false);
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  {
    const ordinaryProgress = progressFor(ORDINARY_TASK_PATH, 3);
    const a = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      commit: commits[0],
    });
    const b = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "in-progress",
      progressAuditedThrough: 3,
      commit: commits[0],
      progress: ordinaryProgress,
    });
    const c = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      projectStatus: "invalid_loop",
      commit: commits[1],
      changedPaths: [".eforest/project.json"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      progressResults: [structuredClone(ordinaryProgress)],
      commitResults: [{ baseCommit: commits[0], commitOid: commits[0] }],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.deepEqual(run.events, ["progress", "record-progress", "invalid-loop"]);
    scenarios += 1;
  }

  {
    const a = snapshot(0, { status: "implemented", commit: commits[0] });
    const b = snapshot(1, {
      status: "verified",
      lastVerdict: "verified",
      commit: commits[1],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [TASK_PATH, ".eforest/tasks/QUEUE.md"].sort(),
    });
    const c = snapshot(0, {
      status: "implemented",
      projectStatus: "invalid_loop",
      commit: commits[2],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [".eforest/project.json"],
    });
    const run = await executeWorkQueue(source, {
      rawReaderSnapshots: true,
      readerSnapshots: [a, b, c],
      verdicts: [verdict(a, b, { taskId: "E2-T02" })],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[2] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  {
    const a = snapshot(0, { status: "implemented", commit: commits[0] });
    const b = snapshot(0, {
      status: "implemented",
      projectStatus: "invalid_loop",
      commit: commits[1],
      changedPaths: [".eforest/project.json"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, a, b],
      verdicts: [
        verdict(a, snapshot(1, { status: "verified", lastVerdict: "verified" }), {
          baseCommit: commits[0],
          commitOid: commits[0],
        }),
      ],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  {
    const a = snapshot(1, { status: "refuted", commit: commits[0] });
    const b = snapshot(1, { status: "implemented", commit: commits[1] });
    const c = snapshot(2, { status: "refuted", commit: commits[2] });
    const d = snapshot(2, {
      status: "refuted",
      projectStatus: "invalid_loop",
      commit: commits[3],
      changedPaths: [".eforest/project.json"],
    });
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: 2 },
      readerSnapshots: [a, b, c, d],
      verdicts: [verdict(b, c)],
      invalidResults: [{ baseCommit: commits[2], commitOid: commits[3] }],
    });
    assert.equal(run.result.completed[0].runs, 2);
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  for (const finalVerdict of ["refuted", "verified"]) {
    const a = snapshot(9, {
      status: "implemented",
      progressAuditedThrough: 9,
      commit: commits[0],
    });
    const b = snapshot(10, {
      status: finalVerdict === "verified" ? "verified" : "refuted",
      lastVerdict: finalVerdict,
      progressAuditedThrough: 9,
      commit: commits[1],
    });
    const c = snapshot(10, {
      status: "refuted",
      progressAuditedThrough: 9,
      projectStatus: "invalid_loop",
      commit: commits[2],
      changedPaths: [".eforest/project.json"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: finalVerdict === "verified" ? [a, b] : [a, b, c],
      verdicts: [verdict(a, b)],
      ...(finalVerdict === "verified"
        ? {}
        : { invalidResults: [{ baseCommit: commits[1], commitOid: commits[2] }] }),
    });
    assert.equal(run.result.completed[0].runs, 10);
    assert.equal(
      run.result.completed[0].verdict,
      finalVerdict === "verified" ? "verified" : "invalid_loop",
    );
    scenarios += 1;
  }

  {
    const a = snapshot(10, {
      status: "in-progress",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[0],
    });
    const b = snapshot(10, {
      status: "implemented",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[1],
    });
    const c = snapshot(11, {
      status: "verified",
      lastVerdict: "verified",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[2],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      verdicts: [verdict(b, c)],
    });
    assert.deepEqual(run.events, ["implement", "verify"]);
    assert.equal(run.result.completed[0].runs, 11);
    assert.equal(run.result.completed[0].verdict, "verified");
    scenarios += 1;
  }

  for (const corruptTransition of ["non-parent", "recovery-rewrite"]) {
    const a = snapshot(10, {
      status: "in-progress",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[0],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: null,
      transitionBaseIsDirectParent: null,
      changedPaths: [],
    });
    const b = snapshot(10, {
      status: "implemented",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[1],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      transitionBaseIsDirectParent: corruptTransition !== "non-parent",
      changedPaths: [TASK_PATH, ".eforest/tasks/QUEUE.md"].sort(),
      ...(corruptTransition === "recovery-rewrite"
        ? {
            recoveryAuthorization: {
              ...snapshot(10, { runCeiling: 13 }).recoveryAuthorization,
              statusReasonDigest: digest("9"),
            },
          }
        : {}),
    });
    const run = await executeWorkQueue(source, {
      rawReaderSnapshots: true,
      readerSnapshots: [a, b],
    });
    assert.deepEqual(run.events, ["implement"]);
    assert.equal(run.result.completed.length, 0);
    scenarios += 1;
  }

  {
    const a = snapshot(10, {
      status: "in-progress",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[0],
    });
    const b = snapshot(10, {
      status: "implemented",
      runCeiling: 16,
      progressAuditedThrough: 9,
      commit: commits[1],
    });
    const run = await executeWorkQueue(source, { readerSnapshots: [a, b] });
    assert.deepEqual(run.events, ["implement"]);
    assert.equal(run.result.completed.length, 0);
    scenarios += 1;
  }

  {
    const a = snapshot(11, {
      status: "implemented",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[0],
    });
    const b = snapshot(12, {
      status: "refuted",
      runCeiling: 13,
      progressAuditedThrough: 9,
      commit: commits[1],
    });
    const c = snapshot(12, {
      status: "refuted",
      runCeiling: 13,
      progressAuditedThrough: 9,
      projectStatus: "invalid_loop",
      commit: commits[2],
      changedPaths: [".eforest/project.json"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      verdicts: [verdict(a, b)],
      progressResults: [undefined],
      invalidResults: [{ baseCommit: commits[1], commitOid: commits[2] }],
    });
    assert.deepEqual(run.events, ["verify", "progress", "invalid-loop"]);
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  {
    const a = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = snapshot(8, {
      status: "refuted",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[1],
    });
    const c = snapshot(8, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[2],
    });
    const d = snapshot(9, {
      status: "verified",
      lastVerdict: "verified",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[3],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c, d],
      verdicts: [verdict(a, b), verdict(c, d)],
    });
    assert.deepEqual(run.events, ["verify", "implement", "verify"]);
    assert.equal(run.result.completed[0].runs, 9);
    assert.equal(run.result.completed[0].verdict, "verified");
    scenarios += 1;
  }

  {
    const deferred = snapshot(7, {
      status: "refuted",
      auditStart: 9,
      progressAuditedThrough: 0,
    });
    const run = await executeWorkQueue(source, { readerSnapshots: [deferred] });
    assert.equal(run.result.refused, "invalid committed gate snapshot");
    assert.equal(run.events.includes("verify"), false);
    scenarios += 1;
  }

  {
    const ordinaryProgress = progressFor(ORDINARY_TASK_PATH, 3);
    const missingProgress = {
      ...ordinaryProgress,
      evidence: [
        {
          kind: "report",
          ref: "definitely/missing/RESULTS.md:999",
          supports: "This path is intentionally absent.",
        },
      ],
    };
    const a = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      commit: commits[0],
    });
    const b = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      projectStatus: "invalid_loop",
      commit: commits[1],
      changedPaths: [".eforest/project.json"],
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b],
      progressResults: [missingProgress],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    assert.equal(run.events.includes("record-progress"), false);
    scenarios += 1;
  }

  {
    const a = snapshot(7, {
      status: "in-progress",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = rewriteRunEntry(
      snapshot(7, {
        status: "implemented",
        progressAuditedThrough: 6,
        firstAuditRun: 4,
        commit: commits[0],
      }),
      7,
      digest("f"),
    );
    const run = await executeWorkQueue(source, { readerSnapshots: [a, b] });
    assert.deepEqual(run.events, ["implement"]);
    assert.equal(run.result.completed.length, 0);
    scenarios += 1;
  }

  {
    const a = snapshot(7, {
      status: "in-progress",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[1],
      controlDigest: digest("d"),
    });
    const run = await executeWorkQueue(source, { readerSnapshots: [a, b] });
    assert.deepEqual(run.events, ["implement"]);
    assert.equal(run.result.completed.length, 0);
    scenarios += 1;
  }

  {
    const a = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = rewriteRunEntry(
      snapshot(8, {
        status: "verified",
        lastVerdict: "verified",
        progressAuditedThrough: 6,
        firstAuditRun: 4,
        commit: commits[1],
        attesterSourceCommit: commits[0],
        transitionBaseCommit: commits[0],
        changedPaths: [TASK_PATH, ".eforest/tasks/QUEUE.md"].sort(),
      }),
      7,
      digest("f"),
    );
    const c = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      projectStatus: "invalid_loop",
      commit: commits[2],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [".eforest/project.json"],
    });
    const run = await executeWorkQueue(source, {
      rawReaderSnapshots: true,
      readerSnapshots: [a, b, c],
      verdicts: [verdict(a, b)],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[2] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  for (const corruptAudit of [
    (value) => ({ ...value, controlDigest: digest("d") }),
    (value) => ({ ...value, attesterDigest: digest("d") }),
    (value) => rewriteRunEntry(value, 3, digest("f")),
    (value) => ({
      ...value,
      changedPaths: [value.taskPath, ".eforest/tasks/QUEUE.md", "AGENTS.md"].sort(),
    }),
    (value) => ({
      ...value,
      latestAudit: { ...value.latestAudit, rationale: "A different persisted rationale." },
    }),
    (value) => ({
      ...value,
      latestAudit: {
        ...value.latestAudit,
        evidence: [
          {
            ...value.latestAudit.evidence[0],
            supports: "A different persisted evidence claim.",
          },
        ],
      },
    }),
    (value) => ({
      ...value,
      latestAudit: {
        ...value.latestAudit,
        nextFocus: ["A different persisted next focus."],
      },
    }),
  ]) {
    const progress = progressFor(ORDINARY_TASK_PATH, 3);
    const a = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "refuted",
      progressAuditedThrough: 0,
      commit: commits[0],
    });
    const b = corruptAudit(
      snapshot(3, {
        taskId: ORDINARY_TASK_ID,
        status: "in-progress",
        progressAuditedThrough: 3,
        commit: commits[1],
        progress,
      }),
    );
    const c = snapshot(3, {
      taskId: ORDINARY_TASK_ID,
      status: "implemented",
      progressAuditedThrough: 3,
      commit: commits[2],
      progress,
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      progressResults: [structuredClone(progress)],
      commitResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  {
    const progress = progressFor(TASK_PATH, 9);
    const a = snapshot(9, {
      status: "refuted",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = snapshot(9, {
      status: "in-progress",
      progressAuditedThrough: 9,
      firstAuditRun: 7,
      commit: commits[1],
      progress,
      auditEntryDigests: [digest("f"), digest("9")],
      latestAudit: {
        firstRun: 7,
        lastRun: 9,
        assessment: "progressing",
        rationale: progress.rationale,
        evidence: structuredClone(progress.evidence),
        nextFocus: structuredClone(progress.nextFocus),
        entry: auditEntry(7, 9, progress),
        entryDigest: digest("9"),
      },
    });
    const c = snapshot(9, {
      status: "implemented",
      progressAuditedThrough: 9,
      firstAuditRun: 7,
      commit: commits[2],
      progress,
    });
    const run = await executeWorkQueue(source, {
      readerSnapshots: [a, b, c],
      progressResults: [structuredClone(progress)],
      commitResults: [{ baseCommit: commits[0], commitOid: commits[1] }],
    });
    assert.equal(run.events.includes("implement"), false);
    scenarios += 1;
  }

  for (const corruptVerdict of [
    (value) => ({ ...value, controlDigest: digest("d") }),
    (value) => ({ ...value, attesterDigest: digest("d") }),
    (value) => ({
      ...value,
      changedPaths: [value.taskPath, ".eforest/tasks/QUEUE.md", "AGENTS.md"].sort(),
    }),
    (value) => ({
      ...value,
      auditEntryDigests: [digest("f")],
      latestAudit: { ...value.latestAudit, entryDigest: digest("f") },
      ledgerDigest: digest("e"),
    }),
  ]) {
    const a = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = corruptVerdict(
      snapshot(8, {
        status: "verified",
        lastVerdict: "verified",
        progressAuditedThrough: 6,
        firstAuditRun: 4,
        commit: commits[1],
        attesterSourceCommit: commits[0],
        transitionBaseCommit: commits[0],
        changedPaths: [TASK_PATH, ".eforest/tasks/QUEUE.md"].sort(),
      }),
    );
    const c = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      projectStatus: "invalid_loop",
      commit: commits[2],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [".eforest/project.json"],
    });
    const run = await executeWorkQueue(source, {
      rawReaderSnapshots: true,
      readerSnapshots: [a, b, c],
      verdicts: [verdict(a, b)],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[2] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  for (const mismatch of ["log-entry", "verdict-value", "status"]) {
    const a = snapshot(1, { status: "implemented", commit: commits[0] });
    const b = snapshot(2, {
      status: mismatch === "status" ? "in-progress" : "refuted",
      commit: commits[1],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [TASK_PATH, ".eforest/tasks/QUEUE.md"].sort(),
    });
    const claim = verdict(a, b, {
      ...(mismatch === "log-entry" ? { logEntry: "different persisted report" } : {}),
      ...(mismatch === "verdict-value" ? { verdict: "needs-evidence" } : {}),
    });
    const c = snapshot(1, {
      status: "implemented",
      projectStatus: "invalid_loop",
      commit: commits[2],
      attesterSourceCommit: commits[0],
      transitionBaseCommit: commits[0],
      changedPaths: [".eforest/project.json"],
    });
    const run = await executeWorkQueue(source, {
      rawReaderSnapshots: true,
      readerSnapshots: [a, b, c],
      verdicts: [claim],
      invalidResults: [{ baseCommit: commits[0], commitOid: commits[2] }],
    });
    assert.equal(run.result.completed[0].verdict, "invalid_loop");
    scenarios += 1;
  }

  for (const changedPaths of [
    [".eforest/tasks/QUEUE.md"],
    [".eforest/project.json", ".eforest/tasks/QUEUE.md", TASK_PATH].sort(),
  ]) {
    const a = snapshot(7, {
      status: "in-progress",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[0],
    });
    const b = snapshot(7, {
      status: "implemented",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[1],
      changedPaths,
    });
    const c = snapshot(8, {
      status: "verified",
      lastVerdict: "verified",
      progressAuditedThrough: 6,
      firstAuditRun: 4,
      commit: commits[2],
    });
    const run = await executeWorkQueue(source, { readerSnapshots: [a, b, c] });
    assert.equal(run.events.includes("verify"), false);
    scenarios += 1;
  }

  for (const invalidCase of [
    "valid",
    "extra-path",
    "control",
    "ledger",
    "observed-commit",
    "project-status",
  ]) {
    const a = snapshot(1, { status: "implemented", commit: commits[0] });
    const b = snapshot(2, { status: "refuted", commit: commits[1] });
    const invalidPaths = [".eforest/project.json"];
    if (invalidCase === "extra-path") invalidPaths.push("AGENTS.md");
    let c = snapshot(2, {
      status: "refuted",
      projectStatus: invalidCase === "project-status" ? "building" : "invalid_loop",
      commit: commits[2],
      changedPaths: invalidPaths.sort(),
      ...(invalidCase === "control" ? { controlDigest: digest("d") } : {}),
    });
    if (invalidCase === "ledger") c = rewriteRunEntry(c, 1, digest("f"));
    const run = await executeWorkQueue(source, {
      args: { tasks: 1, maxRuns: 2 },
      readerSnapshots: [a, b, c],
      verdicts: [verdict(a, b)],
      invalidResults: [
        {
          baseCommit: invalidCase === "observed-commit" ? commits[0] : commits[1],
          commitOid: commits[2],
        },
      ],
    });
    if (invalidCase === "valid") {
      assert.equal(run.result.completed[0].verdict, "invalid_loop");
      assert.equal(run.result.refused, undefined);
    } else {
      assert.equal(run.result.completed.length, 0);
      assert.equal(run.result.refused, "invalid_loop persistence unconfirmed");
      assert.equal(
        run.logs.some((message) =>
          message.includes("persistence could not be independently attested"),
        ),
        true,
      );
    }
    scenarios += 1;
  }

  return scenarios;
}

function fixtureQueue(
  taskId = TASK_ID,
  path = "epic-2-the-gates/E2-T01-identity-event-model/readme.md",
) {
  return `# queue\n\n## Current gate\n\n1. **${taskId}** — task\n\n## Epic 2\n\n- [?] [${taskId}](${path})\n`;
}

function fixtureReadme(
  count,
  {
    id = TASK_ID,
    status = "refuted",
    audit,
    auditAssessment,
    runCeiling,
    recoveryBaseRun,
    recovery = false,
  } = {},
) {
  const verdicts = Array.from({ length: count }, (_, index) => index + 1)
    .reverse()
    .map((run) => runRecord(run).logEntry)
    .join("\n\n");
  const auditEnds = audit === undefined ? [] : Array.isArray(audit) ? audit : [audit];
  const auditText = auditEnds
    .map((lastRun) =>
      auditEntry(
        lastRun - 2,
        lastRun,
        lastRun === auditEnds.at(-1) && auditAssessment
          ? { ...citedProgress, assessment: auditAssessment }
          : citedProgress,
      ),
    )
    .map((entry) => `${entry}\n\n`)
    .join("");
  const migration = id === TASK_ID ? "progress_audit_start: 6\n" : "";
  const ceiling = runCeiling === undefined ? "" : `verification_run_ceiling: ${runCeiling}\n`;
  const extended = recovery || (/^\d+$/.test(String(runCeiling)) && Number(runCeiling) > 10);
  const baseRun = recoveryBaseRun ?? Number(runCeiling) - 3;
  const recoveryFields = extended
    ? `verification_recovery_base_run: ${baseRun}\nverification_recovery_control_commit: ${commits[2]}\nverification_resume_commit: ${commits[4]}\nverification_invalid_loop_commit: ${commits[3]}\n`
    : "";
  const recoveryEntry = extended
    ? `### 2026-07-16 — human resume — RUNS ${baseRun + 1}-${runCeiling} authorized\n\n- Authorization: APPROVED\n- Task: ${id}\n- Stopped after run: ${baseRun}\n- Authorized runs: ${baseRun + 1}-${runCeiling}\n- Scope: control-plane recovery transition and ${id} verification only\n\n`
    : "";
  return `---\nid: ${id}\nstatus: ${status}\n${migration}${ceiling}${recoveryFields}---\n\n## Verification log\n\n${recoveryEntry}${auditText}${verdicts}\n`;
}

async function verifyParserPolicy(module) {
  let scenarios = 0;
  assert.equal(module.addressableLineCount(""), 0);
  assert.equal(module.addressableLineCount("one"), 1);
  assert.equal(module.addressableLineCount("one\n"), 1);
  assert.equal(module.addressableLineCount("one\n\n"), 2);
  scenarios += 1;

  assert.equal(module.isSafeRepoPath("AGENTS.md"), true);
  assert.equal(module.isSafeRepoPath("evidence/foo..bar.md"), true);
  assert.equal(module.isSafeRepoPath("../AGENTS.md"), false);
  assert.equal(module.isSafeRepoPath("evidence/../AGENTS.md"), false);
  assert.equal(module.isSafeRepoPath("/AGENTS.md"), false);
  assert.equal(module.isSafeRepoPath("evidence//file.md"), false);
  scenarios += 1;
  assert.equal(module.runCeilingForTask({}), 10);
  assert.equal(module.runCeilingForTask({ verification_run_ceiling: "6" }), 6);
  assert.equal(module.runCeilingForTask({ verification_run_ceiling: "13" }), 13);
  assert.throws(() => module.runCeilingForTask({ verification_run_ceiling: "1" }));
  assert.throws(() => module.runCeilingForTask({ verification_run_ceiling: "101" }));
  scenarios += 1;
  const exactPreRunReadme = fixtureReadme(0, {
    id: "E2-T06",
    status: "in-progress",
    runCeiling: 3,
    recoveryBaseRun: 0,
    recovery: true,
  }).replace(commits[3], "f1f21df7ad71bb1978ef0dd12081ddc425368e3c");
  const exactPreRunRecovery = module.recoveryRequest(exactPreRunReadme, { taskId: "E2-T06" });
  assert.equal(exactPreRunRecovery.baseRun, 0);
  assert.equal(exactPreRunRecovery.firstRun, 1);
  assert.equal(exactPreRunRecovery.lastRun, 3);
  assert.throws(() =>
    module.recoveryRequest(exactPreRunReadme.replace("E2-T06", "E2-T07"), {
      taskId: "E2-T07",
    }),
  );
  assert.throws(() =>
    module.recoveryRequest(
      exactPreRunReadme.replace("f1f21df7ad71bb1978ef0dd12081ddc425368e3c", commits[3]),
      { taskId: "E2-T06" },
    ),
  );
  assert.throws(() =>
    module.recoveryRequest(
      exactPreRunReadme.replace("verification_run_ceiling: 3", "verification_run_ceiling: 4"),
      {
        taskId: "E2-T06",
      },
    ),
  );
  scenarios += 1;
  const exactE3T01PreRunReadme = fixtureReadme(0, {
    id: "E3-T01",
    status: "in-progress",
    runCeiling: 3,
    recoveryBaseRun: 0,
    recovery: true,
  }).replace(commits[3], "cafff29593bdaf12e6eb3851fd2664ac661b661f");
  const exactE3T01PreRunRecovery = module.recoveryRequest(exactE3T01PreRunReadme, {
    taskId: "E3-T01",
  });
  assert.equal(exactE3T01PreRunRecovery.baseRun, 0);
  assert.equal(exactE3T01PreRunRecovery.firstRun, 1);
  assert.equal(exactE3T01PreRunRecovery.lastRun, 3);
  assert.throws(() =>
    module.recoveryRequest(exactE3T01PreRunReadme.replaceAll("E3-T01", "E3-T02"), {
      taskId: "E3-T02",
    }),
  );
  assert.throws(() =>
    module.recoveryRequest(
      exactE3T01PreRunReadme.replace("cafff29593bdaf12e6eb3851fd2664ac661b661f", commits[3]),
      { taskId: "E3-T01" },
    ),
  );
  assert.throws(() =>
    module.recoveryRequest(
      exactE3T01PreRunReadme.replace("verification_run_ceiling: 3", "verification_run_ceiling: 4"),
      { taskId: "E3-T01" },
    ),
  );
  scenarios += 1;
  const exactSecondRecoveryReadme = exactPreRunReadme
    .replace(
      "verification_recovery_base_run: 0\n",
      "verification_recovery_base_run: 0\nverification_recovery_generation: 2\n",
    )
    .replace("f1f21df7ad71bb1978ef0dd12081ddc425368e3c", "441e8372e12aad69a68540cfb0e83be3fdfec114")
    .replace("human resume — RUNS 1-3 authorized", "human resume — RECOVERY 2 RUNS 1-3 authorized")
    .replace("- Task: E2-T06\n", "- Task: E2-T06\n- Recovery generation: 2\n");
  const exactSecondRecovery = module.recoveryRequest(exactSecondRecoveryReadme, {
    taskId: "E2-T06",
  });
  assert.equal(exactSecondRecovery.generation, 2);
  assert.equal(exactSecondRecovery.invalidLoopCommit, "441e8372e12aad69a68540cfb0e83be3fdfec114");
  assert.throws(() =>
    module.recoveryRequest(
      exactSecondRecoveryReadme.replace("441e8372e12aad69a68540cfb0e83be3fdfec114", commits[3]),
      { taskId: "E2-T06" },
    ),
  );
  assert.throws(() =>
    module.recoveryRequest(
      exactSecondRecoveryReadme.replace("verification_recovery_generation: 2", ""),
      { taskId: "E2-T06" },
    ),
  );
  scenarios += 1;
  const exactThirdRecoveryReadme = exactSecondRecoveryReadme
    .replace("verification_run_ceiling: 3", "verification_run_ceiling: 6")
    .replace("verification_recovery_base_run: 0", "verification_recovery_base_run: 3")
    .replace("verification_recovery_generation: 2", "verification_recovery_generation: 3")
    .replace("441e8372e12aad69a68540cfb0e83be3fdfec114", "f1e72dd0f40089fc1a2d62bec715ca6405e36386")
    .replace("RECOVERY 2 RUNS 1-3 authorized", "RECOVERY 3 RUNS 4-6 authorized")
    .replace("Recovery generation: 2", "Recovery generation: 3")
    .replace("Stopped after run: 0", "Stopped after run: 3")
    .replace("Authorized runs: 1-3", "Authorized runs: 4-6");
  const exactThirdRecovery = module.recoveryRequest(exactThirdRecoveryReadme, {
    taskId: "E2-T06",
  });
  assert.equal(exactThirdRecovery.generation, 3);
  assert.equal(exactThirdRecovery.baseRun, 3);
  assert.equal(exactThirdRecovery.firstRun, 4);
  assert.equal(exactThirdRecovery.lastRun, 6);
  assert.equal(exactThirdRecovery.invalidLoopCommit, "f1e72dd0f40089fc1a2d62bec715ca6405e36386");
  assert.throws(() =>
    module.recoveryRequest(
      exactThirdRecoveryReadme.replace("f1e72dd0f40089fc1a2d62bec715ca6405e36386", commits[3]),
      { taskId: "E2-T06" },
    ),
  );
  scenarios += 1;
  const exactFourthRecoveryReadme = exactThirdRecoveryReadme
    .replace("verification_run_ceiling: 6", "verification_run_ceiling: 10")
    .replace("verification_recovery_base_run: 3", "verification_recovery_base_run: 6")
    .replace("verification_recovery_generation: 3", "verification_recovery_generation: 4")
    .replace("f1e72dd0f40089fc1a2d62bec715ca6405e36386", "2b2ab56a8f8b7103eb9625d0e2c96967b5215649")
    .replace("RECOVERY 3 RUNS 4-6 authorized", "RECOVERY 4 RUNS 7-10 authorized")
    .replace("Recovery generation: 3", "Recovery generation: 4")
    .replace("Stopped after run: 3", "Stopped after run: 6")
    .replace("Authorized runs: 4-6", "Authorized runs: 7-10");
  const exactFourthRecovery = module.recoveryRequest(exactFourthRecoveryReadme, {
    taskId: "E2-T06",
  });
  assert.equal(exactFourthRecovery.generation, 4);
  assert.equal(exactFourthRecovery.baseRun, 6);
  assert.equal(exactFourthRecovery.firstRun, 7);
  assert.equal(exactFourthRecovery.lastRun, 10);
  assert.equal(exactFourthRecovery.invalidLoopCommit, "2b2ab56a8f8b7103eb9625d0e2c96967b5215649");
  assert.throws(() =>
    module.recoveryRequest(
      exactFourthRecoveryReadme.replace("2b2ab56a8f8b7103eb9625d0e2c96967b5215649", commits[3]),
      { taskId: "E2-T06" },
    ),
  );
  scenarios += 1;
  assert.deepEqual(
    [
      "AGENTS.md",
      ".eforest/loop.md",
      ".claude/workflows/implement-task.js",
      ".claude/workflows/work-queue.js",
      ".claude/workflows/verify-task.js",
      "tools/build_queue.py",
    ].every((path) => module.CONTROL_PATHS.includes(path)),
    true,
  );
  scenarios += 1;

  const stoppedE3T06Readme = execFileSync(
    "git",
    ["show", `${E3_T06_STOPPED_COMMIT}:${E3_T06_TASK_PATH}`],
    { cwd: root, encoding: "utf8" },
  );
  const stoppedE3T06Project = execFileSync(
    "git",
    ["show", `${E3_T06_STOPPED_COMMIT}:.eforest/project.json`],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(module.sha256(stoppedE3T06Project), E3_T06_STOPPED_PROJECT_DIGEST);
  const recoveredE3T06Project = module.e3T06RecoveryLifecycleProject(stoppedE3T06Project);
  assert.deepEqual(JSON.parse(recoveredE3T06Project), {
    ...JSON.parse(stoppedE3T06Project),
    status: "building",
    statusReason:
      "Human authorized E3-T06 recovery on 2026-08-01 after run 8: control-plane transition and verification runs 9-9 only",
    updatedAt: "2026-08-01",
  });
  const oneByteProjectDrift = stoppedE3T06Project.replace("electric-forest", "electric-foresu");
  assert.notEqual(oneByteProjectDrift, stoppedE3T06Project);
  assert.equal(oneByteProjectDrift.length, stoppedE3T06Project.length);
  assert.throws(
    () => module.e3T06RecoveryLifecycleProject(oneByteProjectDrift),
    undefined,
    "one-byte drift survived the E3-T06 stopped project digest pin",
  );
  const stoppedE3T06Ledger = module.parseVerificationLedger(stoppedE3T06Readme, {
    taskId: E3_T06_TASK_ID,
    auditStart: 3,
  });
  assert.equal(stoppedE3T06Ledger.runCount, 8);
  assert.deepEqual(stoppedE3T06Ledger.auditEntryDigests, []);
  assert.equal(stoppedE3T06Ledger.progressAuditedThrough, 0);
  assert.equal(stoppedE3T06Ledger.ledgerDigest, E3_T06_STOPPED_LEDGER_DIGEST);
  assert.deepEqual(
    stoppedE3T06Ledger.runs.map(({ run, verdict, entryDigest }) => ({
      run,
      verdict,
      entryDigest,
    })),
    E3_T06_MIGRATED_RUNS.map(({ run, verdict, digest: entryDigest }) => ({
      run,
      verdict,
      entryDigest,
    })),
  );
  for (const entry of E3_T06_SUPERSEDED_ENTRIES) {
    assert.equal(stoppedE3T06Ledger.runEntryDigests.includes(entry.digest), false);
  }
  assert.equal(stoppedE3T06Ledger.auditEntryDigests.includes(E3_T06_STOP_AUDIT.digest), false);
  for (const entry of E3_T06_ALL_PINNED_ENTRIES) {
    assert.throws(
      () =>
        module.parseVerificationLedger(mutatePinnedEntryByte(stoppedE3T06Readme, entry.heading), {
          taskId: E3_T06_TASK_ID,
          auditStart: 3,
        }),
      undefined,
      `one-byte drift survived for pinned E3-T06 entry ${entry.heading}`,
    );
  }
  assert.throws(
    () =>
      module.parseVerificationLedger(
        addPinnedEntryTrailingSpace(stoppedE3T06Readme, E3_T06_MIGRATED_RUNS[0].heading),
        { taskId: E3_T06_TASK_ID, auditStart: 3 },
      ),
    undefined,
    "trailing-space drift survived inside a pinned E3-T06 entry",
  );
  scenarios += 1;

  const recoveredE3T06Readme = module.e3T06RecoveryLifecycleReadme(stoppedE3T06Readme, commits[2]);
  const recoveredE3T06Request = module.recoveryRequest(recoveredE3T06Readme, {
    taskId: E3_T06_TASK_ID,
  });
  assert.equal(recoveredE3T06Request.baseRun, 8);
  assert.equal(recoveredE3T06Request.firstRun, 9);
  assert.equal(recoveredE3T06Request.lastRun, 9);
  assert.equal(recoveredE3T06Request.invalidLoopCommit, E3_T06_STOPPED_COMMIT);
  const recoveredE3T06Ledger = module.parseVerificationLedger(recoveredE3T06Readme, {
    taskId: E3_T06_TASK_ID,
    auditStart: 3,
  });
  assert.equal(recoveredE3T06Ledger.runCount, 8);
  assert.deepEqual(recoveredE3T06Ledger.runEntryDigests, stoppedE3T06Ledger.runEntryDigests);
  assert.deepEqual(
    recoveredE3T06Ledger.audits.map(({ firstRun, lastRun, assessment }) => ({
      firstRun,
      lastRun,
      assessment,
    })),
    [
      { firstRun: 1, lastRun: 3, assessment: "insufficient-evidence" },
      { firstRun: 4, lastRun: 6, assessment: "insufficient-evidence" },
    ],
  );
  assert.deepEqual(
    recoveredE3T06Ledger.audits.map((audit) => audit.evidence.map((item) => item.ref)),
    [
      [E3_T06_MIGRATED_RUNS[2].digest, E3_T06_STOP_AUDIT.digest],
      [
        E3_T06_MIGRATED_RUNS[3].digest,
        E3_T06_MIGRATED_RUNS[4].digest,
        E3_T06_MIGRATED_RUNS[5].digest,
        E3_T06_STOP_AUDIT.digest,
      ],
    ],
  );
  assert.equal(recoveredE3T06Ledger.progressAuditedThrough, 6);
  const validE3T06Recovery = e3T06RecoveryAuthorization(
    module,
    recoveredE3T06Readme,
    stoppedE3T06Ledger,
  );
  const e3T06SnapshotInput = {
    projectText: '{"status":"building"}\n',
    queueText: fixtureQueue(E3_T06_TASK_ID, "epic-3-the-canopy/E3-T06-file-tree-live/readme.md"),
    sourceCommit: commits[4],
    attesterSourceCommit: commits[2],
    attesterDigest: digest("b"),
    controlDigest: digest("c"),
    resolvePath: () => true,
    commitExists: () => true,
  };
  assert.throws(
    () =>
      module.buildWorkQueueSnapshot({
        ...e3T06SnapshotInput,
        readmeText: stoppedE3T06Readme,
        recoveryAuthorization: null,
      }),
    undefined,
    "E3-T06 stopped ledger reopened under projectStatus=building without recovery authorization",
  );
  const recoveredE3T06Snapshot = module.buildWorkQueueSnapshot({
    ...e3T06SnapshotInput,
    readmeText: recoveredE3T06Readme,
    recoveryAuthorization: validE3T06Recovery,
  });
  assert.equal(recoveredE3T06Snapshot.runCeiling, 9);
  assert.equal(recoveredE3T06Snapshot.runCount, 8);
  assert.deepEqual(recoveredE3T06Snapshot.auditEnds, [3, 6]);
  assert.equal(recoveredE3T06Snapshot.progressAuditedThrough, 6);
  assert.equal(recoveredE3T06Snapshot.recoveryAuthorization.priorAuditCount, 0);
  assert.equal(recoveredE3T06Snapshot.recoveryAuthorization.resumeAuditCount, 2);

  const implementedClaimE3T06Readme = `${recoveredE3T06Readme.replace(
    "status: in-progress\n",
    "status: implemented\n",
  )}\n### 2026-08-01 — builder — run 9 exact-source claim\n\n- Builder claim is not an official judge verdict.\n`;
  const implementedClaimE3T06Ledger = module.parseVerificationLedger(implementedClaimE3T06Readme, {
    taskId: E3_T06_TASK_ID,
    auditStart: 3,
  });
  assert.equal(implementedClaimE3T06Ledger.runCount, 8);
  const implementedClaimE3T06Snapshot = module.buildWorkQueueSnapshot({
    ...e3T06SnapshotInput,
    readmeText: implementedClaimE3T06Readme,
    recoveryAuthorization: e3T06RecoveryAuthorization(
      module,
      implementedClaimE3T06Readme,
      stoppedE3T06Ledger,
    ),
  });
  assert.equal(implementedClaimE3T06Snapshot.status, "implemented");
  assert.equal(implementedClaimE3T06Snapshot.runCount, 8);
  for (const verdict of ["verified", "refuted"]) {
    const judgedReadme = `${implementedClaimE3T06Readme}\n### 2026-08-01 — judge round 9 — VERDICT: ${verdict}\n\n- Exact run-9 finding for status-canonicalization coverage.\n`;
    const judgedLedger = module.parseVerificationLedger(judgedReadme, {
      taskId: E3_T06_TASK_ID,
      auditStart: 3,
    });
    assert.equal(judgedLedger.runCount, 9);
    assert.equal(judgedLedger.runs.at(-1).run, 9);
    assert.equal(judgedLedger.runs.at(-1).verdict, verdict);
  }
  const duplicateStatusE3T06Readme = implementedClaimE3T06Readme.replace(
    "status: implemented\n",
    "status: implemented\nstatus: verified\n",
  );
  const movedStatusE3T06Readme = implementedClaimE3T06Readme
    .replace("status: implemented\n", "")
    .replace("\n## Goal\n", "\nstatus: implemented\n\n## Goal\n");
  for (const invalidReadme of [
    implementedClaimE3T06Readme.replace("status: implemented\n", "status: refuted\n"),
    duplicateStatusE3T06Readme,
    movedStatusE3T06Readme,
  ]) {
    assert.throws(() =>
      module.parseVerificationLedger(invalidReadme, {
        taskId: E3_T06_TASK_ID,
        auditStart: 3,
      }),
    );
  }
  const boundE3T06Readme = module.e3T06RecoveryBoundReadme(recoveredE3T06Readme, commits[4]);
  assert.equal(
    module.recoveryRequest(boundE3T06Readme, { taskId: E3_T06_TASK_ID }).resumeCommit,
    commits[4],
  );
  const boundClaimE3T06Readme = `${boundE3T06Readme.replace(
    "status: in-progress\n",
    "status: implemented\n",
  )}\n### 2026-08-01 — builder — run 9 bound claim\n\n- Legitimate bounded run-9 builder claim.\n`;
  const duplicateResumeE3T06Readme = `${boundClaimE3T06Readme}\n### 2026-08-02 — human resume — RUNS 10-10 authorized\n\n- Authorization: APPROVED\n- Task: E3-T06\n- Stopped after run: 9\n- Authorized runs: 10-10\n- Scope: valid-looking but unauthorized descendant recovery\n`;
  assert.throws(
    () => module.recoveryRequest(duplicateResumeE3T06Readme, { taskId: E3_T06_TASK_ID }),
    undefined,
    "E3-T06 accepted a second visible human-resume authorization",
  );
  assert.throws(() =>
    module.buildWorkQueueSnapshot({
      ...e3T06SnapshotInput,
      readmeText: duplicateResumeE3T06Readme,
      recoveryAuthorization: e3T06RecoveryAuthorization(
        module,
        boundClaimE3T06Readme,
        stoppedE3T06Ledger,
      ),
    }),
  );

  const generation2E3T06Readme = recoveredE3T06Readme
    .replace(
      "verification_recovery_base_run: 8\n",
      "verification_recovery_base_run: 8\nverification_recovery_generation: 2\n",
    )
    .replace("human resume — RUNS 9-9 authorized", "human resume — RECOVERY 2 RUNS 9-9 authorized")
    .replace("- Task: E3-T06\n", "- Task: E3-T06\n- Recovery generation: 2\n");
  const base7E3T06Readme = recoveredE3T06Readme
    .replace("verification_recovery_base_run: 8\n", "verification_recovery_base_run: 7\n")
    .replace("human resume — RUNS 9-9 authorized", "human resume — RUNS 8-9 authorized")
    .replace("- Stopped after run: 8\n", "- Stopped after run: 7\n")
    .replace("- Authorized runs: 9-9\n", "- Authorized runs: 8-9\n");
  const ceiling11E3T06Readme = recoveredE3T06Readme
    .replace("verification_run_ceiling: 9\n", "verification_run_ceiling: 11\n")
    .replace("human resume — RUNS 9-9 authorized", "human resume — RUNS 9-11 authorized")
    .replace("- Authorized runs: 9-9\n", "- Authorized runs: 9-11\n");
  const ceiling10OnlyE3T06Readme = stoppedE3T06Readme.replace(
    "capstone: false\n---\n",
    "capstone: false\nverification_run_ceiling: 10\n---\n",
  );
  assert.notEqual(ceiling10OnlyE3T06Readme, stoppedE3T06Readme);
  assert.throws(
    () => module.recoveryRequest(ceiling10OnlyE3T06Readme, { taskId: E3_T06_TASK_ID }),
    undefined,
    "E3-T06 accepted an explicit ceiling 10 with no recovery metadata",
  );

  for (const [label, invalidReadme] of [
    ["wrong base", base7E3T06Readme],
    ["ceiling 11", ceiling11E3T06Readme],
    ["generation 2", generation2E3T06Readme],
    ["wrong stop", recoveredE3T06Readme.replace(E3_T06_STOPPED_COMMIT, commits[3])],
    [
      "missing control",
      recoveredE3T06Readme.replace(`verification_recovery_control_commit: ${commits[2]}\n`, ""),
    ],
  ]) {
    assert.throws(
      () =>
        module.recoveryRequest(invalidReadme, {
          taskId: E3_T06_TASK_ID,
        }),
      undefined,
      `E3-T06 recovery accepted ${label}`,
    );
  }
  assert.throws(() =>
    module.recoveryRequest(recoveredE3T06Readme, {
      taskId: "E3-T07",
    }),
  );
  assert.throws(() =>
    module.parseVerificationLedger(
      movePinnedEntryBefore(
        stoppedE3T06Readme,
        E3_T06_MIGRATED_RUNS[1].heading,
        E3_T06_MIGRATED_RUNS[0].heading,
      ),
      { taskId: E3_T06_TASK_ID, auditStart: 3 },
    ),
  );

  const incompleteE3T06Readme = removeHeadingSection(
    recoveredE3T06Readme,
    "2026-08-01 — progress critic — RUNS 4-6: insufficient-evidence",
  );
  const progressingE3T06Readme = recoveredE3T06Readme
    .replace(
      "progress critic — RUNS 4-6: insufficient-evidence",
      "progress critic — RUNS 4-6: progressing",
    )
    .replace(
      "- Assessment: insufficient-evidence\n\n### 2026-08-01 — human resume",
      "- Assessment: progressing\n\n### 2026-08-01 — human resume",
    );
  const wrongDigestE3T06Readme = recoveredE3T06Readme.replace(
    `- Evidence (digest): ${E3_T06_MIGRATED_RUNS[2].digest} — Exact-pinned run-3 refutation closes the first failed three-run window.`,
    `- Evidence (digest): ${E3_T06_MIGRATED_RUNS[1].digest} — Exact-pinned run-3 refutation closes the first failed three-run window.`,
  );
  for (const invalidReadme of [
    incompleteE3T06Readme,
    progressingE3T06Readme,
    wrongDigestE3T06Readme,
  ]) {
    const invalidRecovery = e3T06RecoveryAuthorization(module, invalidReadme, stoppedE3T06Ledger);
    assert.throws(() =>
      module.buildWorkQueueSnapshot({
        ...e3T06SnapshotInput,
        readmeText: invalidReadme,
        recoveryAuthorization: invalidRecovery,
      }),
    );
  }
  assert.throws(() =>
    module.parseVerificationLedger(
      recoveredE3T06Readme.replace(
        "progress critic — RUNS 4-6: insufficient-evidence",
        "progress critic — RUNS 3-5: insufficient-evidence",
      ),
      { taskId: E3_T06_TASK_ID, auditStart: 3 },
    ),
  );
  for (const recoveryAuthorization of [
    { ...validE3T06Recovery, priorAuditCount: 1 },
    { ...validE3T06Recovery, checkpointOverrideVerified: false },
  ]) {
    assert.throws(() =>
      module.buildWorkQueueSnapshot({
        ...e3T06SnapshotInput,
        readmeText: recoveredE3T06Readme,
        recoveryAuthorization,
      }),
    );
  }

  const deletedTaskBodyE3T06Readme = recoveredE3T06Readme.replace(
    "Directory\nnavigation, renames, deletes, and recreates update live while the DOM exposes the exact\napplication checkpoint and tree digest.\n",
    "",
  );
  assert.notEqual(deletedTaskBodyE3T06Readme, recoveredE3T06Readme);
  const unrelatedTaskBodyE3T06Readme = recoveredE3T06Readme.replace(
    "\n## Deliverables\n",
    "\nUnrelated task-body content is not part of the authorized recovery.\n\n## Deliverables\n",
  );
  assert.notEqual(unrelatedTaskBodyE3T06Readme, recoveredE3T06Readme);
  const trailingSpaceE3T06Readme = recoveredE3T06Readme.replace(
    "application checkpoint and tree digest.\n",
    "application checkpoint and tree digest. \n",
  );
  assert.notEqual(trailingSpaceE3T06Readme, recoveredE3T06Readme);
  const extraLifecycleHeadingE3T06Readme = `${recoveredE3T06Readme.trimEnd()}\n\n### 2026-08-01 — builder — unauthorized lifecycle heading\n\n- This heading is outside the bounded recovery bridge.\n`;
  const extraLifecycleContentE3T06Readme = `${recoveredE3T06Readme.trimEnd()}\nUnauthorized lifecycle content.\n`;
  for (const invalidReadme of [
    deletedTaskBodyE3T06Readme,
    unrelatedTaskBodyE3T06Readme,
    trailingSpaceE3T06Readme,
  ]) {
    assert.throws(() => {
      const recoveryAuthorization = e3T06RecoveryAuthorization(
        module,
        invalidReadme,
        stoppedE3T06Ledger,
      );
      module.buildWorkQueueSnapshot({
        ...e3T06SnapshotInput,
        readmeText: invalidReadme,
        recoveryAuthorization,
      });
    });
  }
  const exactLifecycleReadme = module.e3T06RecoveryLifecycleReadme(stoppedE3T06Readme, commits[2]);
  assert.equal(recoveredE3T06Readme, exactLifecycleReadme);
  for (const invalidReadme of [
    extraLifecycleHeadingE3T06Readme,
    extraLifecycleContentE3T06Readme,
  ]) {
    assert.throws(() => assert.equal(invalidReadme, exactLifecycleReadme));
  }
  scenarios += 1;

  const projectText = '{"status":"building"}\n';
  const queueText = fixtureQueue();
  const readmeText = fixtureReadme(3, { status: "refuted" });
  const parsed = module.buildWorkQueueSnapshot({
    projectText,
    queueText,
    readmeText,
    sourceCommit: commits[0],
    attesterSourceCommit: commits[0],
    attesterDigest: digest("b"),
    controlDigest: digest("c"),
    resolvePath: () => true,
    commitExists: () => true,
  });
  assert.equal(parsed.taskId, TASK_ID);
  assert.equal(parsed.taskPath, TASK_PATH);
  assert.equal(parsed.runCount, 3);
  assert.equal(parsed.runCeiling, 10);
  assert.equal(parsed.progressAuditedThrough, 0);
  scenarios += 1;

  const resumedReadme = fixtureReadme(10, { status: "in-progress", runCeiling: 13 });
  const resumedLedger = module.parseVerificationLedger(resumedReadme, {
    taskId: TASK_ID,
    auditStart: 6,
  });
  const validRecovery = {
    ...module.recoveryRequest(resumedReadme, { taskId: TASK_ID }),
    approvalPathsVerified: true,
    ceilingIntroducedVerified: true,
    checkpointAuditInherited: false,
    checkpointAssessment: null,
    checkpointOverrideVerified: true,
    controlParentVerified: true,
    historyPrefixVerified: true,
    invalidLoopStatusVerified: true,
    priorRunCount: 10,
    priorAuditCount: resumedLedger.auditEntryDigests.length,
    priorAuditEntryDigestsDigest: module.sha256(JSON.stringify(resumedLedger.auditEntryDigests)),
    priorLedgerDigest: resumedLedger.ledgerDigest,
    priorRunEntryDigestsDigest: module.sha256(JSON.stringify(resumedLedger.runEntryDigests)),
    resumeAuditCount: resumedLedger.auditEntryDigests.length,
    resumeAuditEntryDigestsDigest: module.sha256(JSON.stringify(resumedLedger.auditEntryDigests)),
    resumeAncestorVerified: true,
    resumeParentVerified: true,
    resumeRunCount: 10,
    resumeRunEntryDigestsDigest: module.sha256(JSON.stringify(resumedLedger.runEntryDigests)),
    sameGateVerified: true,
    statusReasonDigest: digest("8"),
    statusReasonVerified: true,
  };
  const resumed = module.buildWorkQueueSnapshot({
    projectText,
    queueText,
    readmeText: resumedReadme,
    sourceCommit: commits[0],
    attesterSourceCommit: commits[0],
    attesterDigest: digest("b"),
    controlDigest: digest("c"),
    recoveryAuthorization: validRecovery,
    resolvePath: () => true,
    commitExists: () => true,
  });
  assert.equal(resumed.runCeiling, 13);
  assert.equal(resumed.runCount, 10);
  assert.equal(resumed.recoveryAuthorization.resumeCommit, commits[4]);
  for (const missing of [
    `verification_resume_commit: ${commits[4]}\n`,
    `verification_invalid_loop_commit: ${commits[3]}\n`,
    `verification_recovery_control_commit: ${commits[2]}\n`,
    `### 2026-07-16 — human resume — RUNS 11-13 authorized\n\n- Authorization: APPROVED\n- Task: E2-T01\n- Stopped after run: 10\n- Authorized runs: 11-13\n- Scope: control-plane recovery transition and E2-T01 verification only\n\n`,
  ]) {
    assert.throws(() =>
      module.buildWorkQueueSnapshot({
        projectText,
        queueText,
        readmeText: resumedReadme.replace(missing, ""),
        sourceCommit: commits[0],
        attesterSourceCommit: commits[0],
        attesterDigest: digest("b"),
        controlDigest: digest("c"),
        recoveryAuthorization: validRecovery,
      }),
    );
  }
  for (const corruptRecovery of [
    { ...validRecovery, resumeCommit: commits[5] },
    { ...validRecovery, statusReasonDigest: "" },
    { ...validRecovery, priorLedgerDigest: digest("f") },
    ...[
      "resumeParentVerified",
      "resumeAncestorVerified",
      "controlParentVerified",
      "historyPrefixVerified",
      "invalidLoopStatusVerified",
      "ceilingIntroducedVerified",
      "statusReasonVerified",
      "approvalPathsVerified",
      "sameGateVerified",
    ].map((field) => ({ ...validRecovery, [field]: false })),
  ]) {
    assert.throws(() =>
      module.buildWorkQueueSnapshot({
        projectText,
        queueText,
        readmeText: resumedReadme,
        sourceCommit: commits[0],
        attesterSourceCommit: commits[0],
        attesterDigest: digest("b"),
        controlDigest: digest("c"),
        recoveryAuthorization: corruptRecovery,
      }),
    );
  }
  const checkpointReadme = fixtureReadme(12, {
    status: "in-progress",
    audit: [6, 9, 12],
    auditAssessment: "death-spiral",
    runCeiling: 15,
    recoveryBaseRun: 12,
  });
  const checkpointLedger = module.parseVerificationLedger(checkpointReadme, {
    taskId: TASK_ID,
    auditStart: 6,
  });
  const checkpointPriorAudits = checkpointLedger.audits.slice(0, -1);
  const checkpointPriorAuditDigests = checkpointLedger.auditEntryDigests.slice(0, -1);
  const checkpointRecovery = {
    ...validRecovery,
    ...module.recoveryRequest(checkpointReadme, { taskId: TASK_ID }),
    checkpointAuditInherited: false,
    checkpointAssessment: "death-spiral",
    checkpointOverrideVerified: true,
    priorRunCount: 12,
    priorAuditCount: checkpointPriorAuditDigests.length,
    priorAuditEntryDigestsDigest: module.sha256(JSON.stringify(checkpointPriorAuditDigests)),
    priorLedgerDigest: module.sha256(
      JSON.stringify({
        runs: checkpointLedger.runs.map((run) => [run.run, run.verdict, run.entryDigest]),
        audits: checkpointPriorAudits.map((entry) => [
          entry.firstRun,
          entry.lastRun,
          entry.entryDigest,
        ]),
      }),
    ),
    priorRunEntryDigestsDigest: module.sha256(JSON.stringify(checkpointLedger.runEntryDigests)),
    resumeAuditCount: checkpointLedger.auditEntryDigests.length,
    resumeAuditEntryDigestsDigest: module.sha256(
      JSON.stringify(checkpointLedger.auditEntryDigests),
    ),
    resumeRunCount: 12,
    resumeRunEntryDigestsDigest: module.sha256(JSON.stringify(checkpointLedger.runEntryDigests)),
  };
  const checkpointInput = {
    projectText,
    queueText,
    readmeText: checkpointReadme,
    sourceCommit: commits[0],
    attesterSourceCommit: commits[0],
    attesterDigest: digest("b"),
    controlDigest: digest("c"),
  };
  assert.equal(
    module.buildWorkQueueSnapshot({
      ...checkpointInput,
      recoveryAuthorization: checkpointRecovery,
    }).runCeiling,
    15,
  );
  assert.throws(() =>
    module.buildWorkQueueSnapshot({
      ...checkpointInput,
      recoveryAuthorization: { ...checkpointRecovery, checkpointOverrideVerified: false },
    }),
  );
  const inheritedProgressReadme = fixtureReadme(15, {
    status: "in-progress",
    audit: [6, 9, 12, 15],
    auditAssessment: "progressing",
    runCeiling: 18,
    recoveryBaseRun: 15,
  });
  const inheritedProgressLedger = module.parseVerificationLedger(inheritedProgressReadme, {
    taskId: TASK_ID,
    auditStart: 6,
  });
  const inheritedProgressRecovery = {
    ...validRecovery,
    ...module.recoveryRequest(inheritedProgressReadme, { taskId: TASK_ID }),
    checkpointAuditInherited: true,
    checkpointAssessment: "progressing",
    checkpointOverrideVerified: true,
    priorRunCount: 15,
    priorAuditCount: inheritedProgressLedger.auditEntryDigests.length,
    priorAuditEntryDigestsDigest: module.sha256(
      JSON.stringify(inheritedProgressLedger.auditEntryDigests),
    ),
    priorLedgerDigest: inheritedProgressLedger.ledgerDigest,
    priorRunEntryDigestsDigest: module.sha256(
      JSON.stringify(inheritedProgressLedger.runEntryDigests),
    ),
    resumeAuditCount: inheritedProgressLedger.auditEntryDigests.length,
    resumeAuditEntryDigestsDigest: module.sha256(
      JSON.stringify(inheritedProgressLedger.auditEntryDigests),
    ),
    resumeRunCount: 15,
    resumeRunEntryDigestsDigest: module.sha256(
      JSON.stringify(inheritedProgressLedger.runEntryDigests),
    ),
  };
  const inheritedProgressInput = {
    projectText,
    queueText,
    readmeText: inheritedProgressReadme,
    sourceCommit: commits[0],
    attesterSourceCommit: commits[0],
    attesterDigest: digest("b"),
    controlDigest: digest("c"),
  };
  assert.equal(
    module.buildWorkQueueSnapshot({
      ...inheritedProgressInput,
      recoveryAuthorization: inheritedProgressRecovery,
    }).recoveryAuthorization.checkpointAssessment,
    "progressing",
  );
  for (const corruptRecovery of [
    { ...inheritedProgressRecovery, checkpointAuditInherited: false },
    { ...inheritedProgressRecovery, checkpointAuditInherited: "yes" },
    {
      ...inheritedProgressRecovery,
      resumeAuditCount: inheritedProgressRecovery.priorAuditCount + 1,
    },
  ]) {
    assert.throws(() =>
      module.buildWorkQueueSnapshot({
        ...inheritedProgressInput,
        recoveryAuthorization: corruptRecovery,
      }),
    );
  }
  const shortRecoveryReadme = fixtureReadme(9, { status: "in-progress", runCeiling: 13 });
  const shortRecoveryLedger = module.parseVerificationLedger(shortRecoveryReadme, {
    taskId: TASK_ID,
    auditStart: 6,
  });
  const shortRecovery = {
    ...validRecovery,
    ...module.recoveryRequest(shortRecoveryReadme, { taskId: TASK_ID }),
    priorAuditCount: shortRecoveryLedger.auditEntryDigests.length,
    priorAuditEntryDigestsDigest: module.sha256(
      JSON.stringify(shortRecoveryLedger.auditEntryDigests),
    ),
    priorLedgerDigest: shortRecoveryLedger.ledgerDigest,
    priorRunEntryDigestsDigest: module.sha256(JSON.stringify(shortRecoveryLedger.runEntryDigests)),
    resumeAuditCount: shortRecoveryLedger.auditEntryDigests.length,
    resumeAuditEntryDigestsDigest: module.sha256(
      JSON.stringify(shortRecoveryLedger.auditEntryDigests),
    ),
    resumeRunEntryDigestsDigest: module.sha256(JSON.stringify(shortRecoveryLedger.runEntryDigests)),
  };
  assert.throws(() =>
    module.buildWorkQueueSnapshot({
      projectText,
      queueText,
      readmeText: shortRecoveryReadme,
      sourceCommit: commits[0],
      attesterSourceCommit: commits[0],
      attesterDigest: digest("b"),
      controlDigest: digest("c"),
      recoveryAuthorization: shortRecovery,
    }),
  );
  scenarios += 1;
  for (const invalidCeiling of [9, 11, 14, 101, "three"]) {
    assert.throws(() => {
      const numeric = Number(invalidCeiling);
      const count = Number.isInteger(numeric) && numeric > 10 && numeric <= 100 ? numeric - 3 : 3;
      const invalidReadme = fixtureReadme(count, { runCeiling: invalidCeiling });
      let recoveryAuthorization = null;
      if (Number.isInteger(numeric) && numeric > 10 && numeric <= 100) {
        const request = module.recoveryRequest(invalidReadme, { taskId: TASK_ID });
        recoveryAuthorization = {
          ...request,
          approvalPathsVerified: true,
          ceilingIntroducedVerified: true,
          invalidLoopStatusVerified: true,
          priorRunCount: numeric - 3,
          resumeAncestorVerified: true,
          resumeParentVerified: true,
          sameGateVerified: true,
          statusReasonDigest: digest("8"),
          statusReasonVerified: true,
        };
      }
      module.buildWorkQueueSnapshot({
        projectText,
        queueText,
        readmeText: invalidReadme,
        sourceCommit: commits[0],
        attesterSourceCommit: commits[0],
        attesterDigest: digest("b"),
        controlDigest: digest("c"),
        recoveryAuthorization,
      });
    });
  }
  assert.throws(() =>
    module.buildWorkQueueSnapshot({
      projectText,
      queueText,
      readmeText: fixtureReadme(11),
      sourceCommit: commits[0],
      attesterSourceCommit: commits[0],
      attesterDigest: digest("b"),
      controlDigest: digest("c"),
    }),
  );
  scenarios += 1;

  const legacyE2T05Readme = readFileSync(resolve(root, LEGACY_E2_T05_PATH), "utf8");
  const legacyE2T05Ledger = module.parseVerificationLedger(legacyE2T05Readme, {
    taskId: "E2-T05",
    auditStart: 3,
  });
  assert.equal(legacyE2T05Ledger.runCount, 7);
  assert.deepEqual(
    legacyE2T05Ledger.runs.map(({ run, verdict }) => [run, verdict]),
    [
      [1, "refuted"],
      [2, "refuted"],
      [3, "refuted"],
      [4, "refuted"],
      [5, "refuted"],
      [6, "refuted"],
      [7, "verified"],
    ],
  );
  assert.equal(legacyE2T05Ledger.progressAuditedThrough, 6);
  for (const [from, to] of [
    ["revocation race/totality — FAILED", "revocation race/totality — MUTATED"],
    ["cross-runtime revocation totality — FAILED", "cross-runtime revocation totality — MUTATED"],
    ["orphaned durable operation — FAILED", "orphaned durable operation — MUTATED"],
    ["unavailable recovery target — FAILED", "unavailable recovery target — MUTATED"],
    ["late-writer TOCTOU — FAILED", "late-writer TOCTOU — MUTATED"],
    ["false append-winner attribution — FAILED", "false append-winner attribution — MUTATED"],
    ["Producer settlement — PASSED", "Producer settlement — MUTATED"],
    ["progress critic — RUNS 1-3: progressing", "progress critic — RUNS 1-3: death-spiral"],
    ["progress critic — RUNS 4-6: progressing", "progress critic — RUNS 4-6: death-spiral"],
  ]) {
    assert.throws(() =>
      module.parseVerificationLedger(legacyE2T05Readme.replace(from, to), {
        taskId: "E2-T05",
        auditStart: 3,
      }),
    );
  }
  assert.throws(() =>
    module.parseVerificationLedger(
      legacyE2T05Readme.replace(
        "critics — VERDICT: refuted (verification run 2)",
        "critic — VERDICT: refuted (verification run 2)",
      ),
      { taskId: "E2-T05", auditStart: 3 },
    ),
  );
  scenarios += 1;

  assert.throws(() =>
    module.buildWorkQueueSnapshot({
      projectText,
      queueText,
      readmeText: fixtureReadme(3, { id: "E2-T02" }).replace(
        "status: refuted\n",
        "status: refuted\nprogress_audit_start: 6\n",
      ),
      sourceCommit: commits[0],
      attesterSourceCommit: commits[0],
      attesterDigest: digest("b"),
      controlDigest: digest("c"),
    }),
  );
  scenarios += 1;

  const skipped = fixtureReadme(3).replace(runRecord(2).logEntry, "");
  assert.throws(() => module.parseVerificationLedger(skipped, { taskId: TASK_ID, auditStart: 6 }));
  scenarios += 1;

  const legacyE2T04Readme = readFileSync(resolve(root, LEGACY_E2_T04_PATH), "utf8");
  const legacyE2T04Ledger = module.parseVerificationLedger(legacyE2T04Readme, {
    taskId: "E2-T04",
    auditStart: 3,
  });
  assert.equal(legacyE2T04Ledger.runCount, 4);
  assert.deepEqual(
    legacyE2T04Ledger.runs.map(({ run, verdict }) => [run, verdict]),
    [
      [1, "refuted"],
      [2, "refuted"],
      [3, "needs-evidence"],
      [4, "verified"],
    ],
  );
  assert.throws(() =>
    module.parseVerificationLedger(
      legacyE2T04Readme.replace("DOM truth — FAILED", "DOM truth — MUTATED"),
      { taskId: "E2-T04", auditStart: 3 },
    ),
  );
  scenarios += 1;

  assert.throws(() =>
    module.canonicalTaskPath(fixtureQueue(TASK_ID, "epic-9/E2-T01-wrong/readme.md"), TASK_ID),
  );
  scenarios += 1;

  const badAudit = `${fixtureReadme(3)}\n${auditEntry(1, 3, progressFor(TASK_PATH, 3))}\n`;
  assert.throws(() => module.parseVerificationLedger(badAudit, { taskId: TASK_ID, auditStart: 6 }));
  scenarios += 1;

  const missingEarlierAudit = `${fixtureReadme(9)}\n${auditEntry(7, 9)}\n`;
  assert.throws(() =>
    module.parseVerificationLedger(missingEarlierAudit, { taskId: TASK_ID, auditStart: 6 }),
  );
  scenarios += 1;

  const fenced = fixtureReadme(0).replace(
    "## Verification log",
    `## Context\n\n\`\`\`md\n${runRecord(1).logEntry}\n\`\`\`\n\n## Verification log`,
  );
  assert.equal(
    module.parseVerificationLedger(fenced, { taskId: TASK_ID, auditStart: 6 }).runCount,
    0,
  );
  scenarios += 1;

  const outside = fixtureReadme(0).replace(
    "## Verification log",
    `## Context\n\n${runRecord(1).logEntry}\n\n## Verification log`,
  );
  assert.equal(
    module.parseVerificationLedger(outside, { taskId: TASK_ID, auditStart: 6 }).runCount,
    0,
  );
  scenarios += 1;

  const plainBullet = fixtureReadme(1).replace("- **Finding 1.**", "- Evidence for run 1.");
  assert.equal(
    module.parseVerificationLedger(plainBullet, { taskId: TASK_ID, auditStart: 6 }).runCount,
    1,
  );
  scenarios += 1;

  const visibleFinding =
    "- **Finding 1.** Prediction and observation with report/path-1.md:1. Demand: fix.";
  for (const hiddenBody of [
    "```md\n- Hidden evidence only.\n```",
    "<!--\n- Hidden evidence only.\n-->",
  ]) {
    const hiddenVerdict = fixtureReadme(1).replace(visibleFinding, hiddenBody);
    assert.throws(() =>
      module.parseVerificationLedger(hiddenVerdict, { taskId: TASK_ID, auditStart: 6 }),
    );
    scenarios += 1;
  }

  const completeAudit = auditEntry(4, 6);
  const auditHeading = "### 2026-07-16 — progress critic — RUNS 4-6: progressing";
  for (const hiddenBody of [
    `${auditHeading}\n\n\`\`\`md\n- Rationale: hidden\n- Evidence (report): fabricated — hidden\n- Next focus: hidden\n- Assessment: progressing\n\`\`\``,
    `${auditHeading}\n\n<!--\n- Rationale: hidden\n- Evidence (report): fabricated — hidden\n- Next focus: hidden\n- Assessment: progressing\n-->`,
  ]) {
    const hiddenAudit = fixtureReadme(6, { audit: 6 }).replace(completeAudit, hiddenBody);
    assert.throws(() =>
      module.parseVerificationLedger(hiddenAudit, { taskId: TASK_ID, auditStart: 6 }),
    );
    scenarios += 1;
  }

  for (const missing of [
    `- Rationale: ${citedProgress.rationale}\n`,
    `- Evidence (${citedProgress.evidence[0].kind}): ${citedProgress.evidence[0].ref} — ${citedProgress.evidence[0].supports}\n`,
    `- Next focus: ${citedProgress.nextFocus[0]}\n`,
    "- Assessment: progressing",
  ]) {
    const incomplete = fixtureReadme(6, { audit: 6 }).replace(missing, "");
    assert.throws(() =>
      module.parseVerificationLedger(incomplete, { taskId: TASK_ID, auditStart: 6 }),
    );
    scenarios += 1;
  }

  const headingOnlyAudit = fixtureReadme(6, { audit: 6 }).replace(
    /### 2026-07-16 — progress critic — RUNS 4-6: progressing[\s\S]*?(?=\n\n### 2026-07-16 — judge)/,
    "### 2026-07-16 — progress critic — RUNS 4-6: progressing",
  );
  assert.throws(() =>
    module.parseVerificationLedger(headingOnlyAudit, { taskId: TASK_ID, auditStart: 6 }),
  );
  scenarios += 1;

  const noEvidenceAudit = fixtureReadme(6, { audit: 6 }).replace(/- Evidence \([^\n]+\n/, "");
  assert.throws(() =>
    module.parseVerificationLedger(noEvidenceAudit, { taskId: TASK_ID, auditStart: 6 }),
  );
  scenarios += 1;

  const arbitraryDigest = "f".repeat(64);
  const missingCommit = "0".repeat(40);
  const catalogReadme = fixtureReadme(3).replace(
    visibleFinding.replaceAll("1", "3"),
    `${visibleFinding.replaceAll("1", "3")} Visible refs: \`AGENTS.md:1\`, \`AGENTS.md:999999\`, \`node missing-script.mjs\`, \`${commits[0]}..${missingCommit}\`, and ${arbitraryDigest}. <!-- \`hidden.md:1\` hidden commit ${commits[0]} -->`,
  );
  const catalogSnapshot = module.buildWorkQueueSnapshot({
    projectText,
    queueText,
    readmeText: catalogReadme,
    sourceCommit: commits[0],
    attesterSourceCommit: commits[0],
    attesterDigest: digest("b"),
    controlDigest: digest("c"),
    resolvePath: (ref) => ref === "AGENTS.md:1" || ref === "hidden.md:1",
    commitExists: (oid) => oid === commits[0],
  });
  assert.equal(
    catalogSnapshot.evidenceCatalog.some(
      (item) => item.kind === "fixture" && item.ref === "AGENTS.md:1",
    ),
    true,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some((item) => item.ref === "AGENTS.md:999999"),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some((item) => item.kind === "command"),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some((item) => item.ref === arbitraryDigest),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some((item) => item.ref.includes(missingCommit)),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some(
      (item) => item.kind === "commit" && item.ref === commits[0],
    ),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.some((item) => item.ref === "hidden.md:1"),
    false,
  );
  assert.equal(
    catalogSnapshot.evidenceCatalog.every(
      (item) => typeof item.verifier === "string" && typeof item.target === "string",
    ),
    true,
  );
  scenarios += 1;

  const deferred = fixtureReadme(7).replace("progress_audit_start: 6", "progress_audit_start: 9");
  assert.throws(() =>
    module.buildWorkQueueSnapshot({
      projectText,
      queueText,
      readmeText: deferred,
      sourceCommit: commits[0],
      attesterSourceCommit: commits[0],
      attesterDigest: digest("b"),
      controlDigest: digest("c"),
    }),
  );
  scenarios += 1;
  return scenarios;
}

async function importSnapshotModule(source, label) {
  const url = `data:text/javascript;base64,${Buffer.from(`${source}\n//# sourceURL=${label}`).toString("base64")}`;
  return import(url);
}

async function verifyVerifyTaskBoundary(source) {
  const runWorkflow = compile(source);
  const verdictEntry = runRecord(8).logEntry;
  const agent = async (_prompt, options) => {
    if (options.label === "orient") {
      return {
        ok: true,
        taskId: TASK_ID,
        taskPath: TASK_PATH.replace(/\/readme\.md$/, ""),
        diffCmd: "git diff",
        claims: ["claim"],
        criteria: ["criterion"],
        attackAngles: [],
        evidencePaths: [],
        replayRecordings: [],
        changedHunks: [],
        capstone: false,
      };
    }
    if (options.label === "verdict") {
      return {
        verdict: "refuted",
        logEntry: verdictEntry,
        baseCommit: commits[0],
        commitOid: commits[1],
        promoted: [],
        report: verdictEntry,
      };
    }
    if (options.label.startsWith("xcheck:")) return { stands: true, reason: "confirmed" };
    return { findings: [], notes: "survived" };
  };
  const result = await runWorkflow(
    agent,
    async () => {},
    async (tasks) => Promise.all(tasks.map((task) => task())),
    () => {},
    () => {},
    { total: 0, remaining: () => Infinity },
    { task: TASK_ID },
  );
  assert.equal(result.taskId, TASK_ID);
  assert.equal(result.baseCommit, commits[0]);
  assert.equal(result.commitOid, commits[1]);
  assert.equal(result.logEntry, verdictEntry);
  return 1;
}

let scenarios = await verifyWorkQueuePolicy(workQueueSource);
scenarios += await verifyParserPolicy({
  CONTROL_PATHS,
  addressableLineCount,
  buildWorkQueueSnapshot,
  canonicalTaskPath,
  e3T06RecoveryBoundReadme,
  e3T06RecoveryLifecycleProject,
  e3T06RecoveryLifecycleReadme,
  isSafeRepoPath,
  parseVerificationLedger,
  recoveryRequest,
  runCeilingForTask,
  sha256,
});
scenarios += await verifyVerifyTaskBoundary(verifyTaskSource);
scenarios += verifyColdCloneTargetBoundary(coldCloneSource, "baseline");

function committedSnapshot(
  cwd,
  taskId = TASK_ID,
  { attester = "HEAD", source = "HEAD", base } = {},
) {
  const cli = execFileSync(
    "git",
    ["show", `${attester}:packages/identity/scripts/work-queue-snapshot.mjs`],
    {
      cwd,
    },
  );
  const args = [
    "--input-type=module",
    "-",
    "--attester",
    attester,
    "--source",
    source,
    "--task",
    taskId,
  ];
  if (base !== undefined) args.push("--base", base);
  return JSON.parse(execFileSync(process.execPath, args, { cwd, input: cli, encoding: "utf8" }));
}

function snapshotFromCliSource(cwd, cliSource, taskId, { attester, source, base }) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-",
        "--attester",
        attester,
        "--source",
        source,
        "--base",
        base,
        "--task",
        taskId,
      ],
      { cwd, input: cliSource, encoding: "utf8" },
    ),
  );
}

function verifyRecoveryLifecyclePathSet(cliSource, label) {
  const currentReadme = readFileSync(resolve(root, TASK_PATH), "utf8");
  const recovery = recoveryRequest(currentReadme, { taskId: TASK_ID });
  assert.notEqual(recovery, null, "recovery path sensor requires an authorized window");
  assert.notEqual(recovery.controlCommit, null, "recovery path sensor requires a control bridge");
  assert.notEqual(
    recovery.resumeCommit,
    null,
    "recovery path sensor requires a bound resume commit",
  );
  const value = snapshotFromCliSource(root, cliSource, TASK_ID, {
    attester: recovery.controlCommit,
    source: recovery.resumeCommit,
    base: recovery.controlCommit,
  });
  assert.deepEqual(value.changedPaths, [TASK_PATH, ".eforest/project.json"].sort());
  assert.equal(value.projectStatus, "building");
  assert.equal(value.recoveryAuthorization.approvalPathsVerified, true);
  assert.equal(value.recoveryAuthorization.checkpointAuditInherited, true);
  return 1;
}

function verifyE3T06ExactLifecycleComparator(cliSource, label, expectations = {}) {
  const {
    ambiguousBindAccepted = false,
    badBindPathsAccepted = false,
    badBindReadmeAccepted = false,
    badProjectAccepted = false,
    badQueueAccepted = false,
    badReadmeAccepted = false,
  } = expectations;
  const temporary = mkdtempSync(resolve(tmpdir(), `eforest-e3-t06-lifecycle-${label}-`));
  const clone = resolve(temporary, "repo");
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", root, clone]);
    execFileSync("git", ["config", "user.name", "E3-T06 Lifecycle Sensor"], { cwd: clone });
    execFileSync("git", ["config", "user.email", "policy@example.invalid"], { cwd: clone });
    execFileSync("git", ["checkout", "--quiet", "--detach", E3_T06_STOPPED_COMMIT], {
      cwd: clone,
    });

    for (const path of RECOVERY_CONTROL_PATHS) {
      const content =
        path === "packages/identity/scripts/work-queue-snapshot.mjs"
          ? cliSource
          : readFileSync(resolve(root, path), "utf8");
      writeFileSync(resolve(clone, path), content);
    }
    execFileSync("git", ["add", ...RECOVERY_CONTROL_PATHS], { cwd: clone });
    const controlPaths = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: clone,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort();
    assert.deepEqual(controlPaths, RECOVERY_CONTROL_PATHS);
    execFileSync("git", ["commit", "--quiet", "-m", `E3-T06 control ${label}`], {
      cwd: clone,
    });
    const controlCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();

    const stoppedReadme = execFileSync(
      "git",
      ["show", `${E3_T06_STOPPED_COMMIT}:${E3_T06_TASK_PATH}`],
      { cwd: clone, encoding: "utf8" },
    );
    const exactReadme = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { readFileSync } from "node:fs"; import { e3T06RecoveryLifecycleReadme } from "./packages/identity/scripts/work-queue-snapshot-lib.mjs"; process.stdout.write(e3T06RecoveryLifecycleReadme(readFileSync(0, "utf8"), process.env.E3_T06_CONTROL_COMMIT));',
      ],
      {
        cwd: clone,
        input: stoppedReadme,
        encoding: "utf8",
        env: { ...process.env, E3_T06_CONTROL_COMMIT: controlCommit },
      },
    );
    const projectPath = resolve(clone, ".eforest/project.json");
    const stoppedProjectText = execFileSync(
      "git",
      ["show", `${E3_T06_STOPPED_COMMIT}:.eforest/project.json`],
      { cwd: clone, encoding: "utf8" },
    );
    const exactProjectText = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { readFileSync } from "node:fs"; import { e3T06RecoveryLifecycleProject } from "./packages/identity/scripts/work-queue-snapshot-lib.mjs"; process.stdout.write(e3T06RecoveryLifecycleProject(readFileSync(0, "utf8")));',
      ],
      { cwd: clone, input: stoppedProjectText, encoding: "utf8" },
    );
    const commitLifecycle = ({ projectText, queueText = null, readme }, message) => {
      writeFileSync(resolve(clone, E3_T06_TASK_PATH), readme);
      writeFileSync(projectPath, projectText);
      const expectedPaths = [E3_T06_TASK_PATH, ".eforest/project.json"];
      if (queueText !== null) {
        writeFileSync(resolve(clone, ".eforest/tasks/QUEUE.md"), queueText);
        expectedPaths.push(".eforest/tasks/QUEUE.md");
      }
      execFileSync("git", ["add", ...expectedPaths], { cwd: clone });
      const paths = execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: clone,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
      assert.deepEqual(paths, expectedPaths.sort());
      execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: clone });
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: clone,
        encoding: "utf8",
      }).trim();
    };

    const exactCommit = commitLifecycle(
      { readme: exactReadme, projectText: exactProjectText },
      `E3-T06 exact lifecycle ${label}`,
    );
    assert.equal(
      execFileSync("git", ["show", `${exactCommit}:${E3_T06_TASK_PATH}`], {
        cwd: clone,
        encoding: "utf8",
      }),
      exactReadme,
    );
    assert.equal(
      execFileSync("git", ["show", `${exactCommit}:.eforest/project.json`], {
        cwd: clone,
        encoding: "utf8",
      }),
      exactProjectText,
    );
    const exactSnapshot = snapshotFromCliSource(clone, cliSource, E3_T06_TASK_ID, {
      attester: controlCommit,
      source: exactCommit,
      base: controlCommit,
    });
    assert.equal(exactSnapshot.recoveryAuthorization.baseRun, 8);
    assert.equal(exactSnapshot.recoveryAuthorization.authorizedCeiling, 9);
    assert.equal(exactSnapshot.recoveryAuthorization.resumeCommit, exactCommit);

    const inspectSibling = (commit, base = controlCommit) =>
      snapshotFromCliSource(clone, cliSource, E3_T06_TASK_ID, {
        attester: controlCommit,
        source: commit,
        base,
      });
    const assertSibling = (
      commit,
      accepted,
      failure,
      base = controlCommit,
      expectedResume = commit,
    ) => {
      if (accepted) {
        const siblingSnapshot = inspectSibling(commit, base);
        assert.equal(siblingSnapshot.recoveryAuthorization.resumeCommit, expectedResume);
      } else {
        assert.throws(() => inspectSibling(commit, base), undefined, failure);
      }
    };

    execFileSync("git", ["checkout", "--quiet", "--detach", controlCommit], { cwd: clone });
    const badReadme = `${exactReadme}\n### 2026-08-01 — builder — unauthorized lifecycle heading\n\n- x\n`;
    const badReadmeCommit = commitLifecycle(
      { readme: badReadme, projectText: exactProjectText },
      `E3-T06 bad readme lifecycle ${label}`,
    );
    assertSibling(
      badReadmeCommit,
      badReadmeAccepted,
      "E3-T06 CLI accepted extra lifecycle content",
    );

    execFileSync("git", ["checkout", "--quiet", "--detach", controlCommit], { cwd: clone });
    const badProject = JSON.parse(exactProjectText);
    badProject.unauthorizedLifecycleField = true;
    const badProjectText = `${JSON.stringify(badProject, null, 2)}\n`;
    const badProjectCommit = commitLifecycle(
      { readme: exactReadme, projectText: badProjectText },
      `E3-T06 bad project lifecycle ${label}`,
    );
    assertSibling(
      badProjectCommit,
      badProjectAccepted,
      "E3-T06 CLI accepted unrelated lifecycle project content",
    );

    execFileSync("git", ["checkout", "--quiet", "--detach", controlCommit], { cwd: clone });
    const stoppedQueueText = readFileSync(resolve(clone, ".eforest/tasks/QUEUE.md"), "utf8");
    const badQueueText = `${stoppedQueueText.trimEnd()}\n\n<!-- unauthorized lifecycle queue byte -->\n`;
    const badQueueCommit = commitLifecycle(
      { readme: exactReadme, projectText: exactProjectText, queueText: badQueueText },
      `E3-T06 bad queue lifecycle ${label}`,
    );
    assertSibling(
      badQueueCommit,
      badQueueAccepted,
      "E3-T06 CLI accepted a lifecycle commit that changed generated queue bytes",
    );

    execFileSync("git", ["checkout", "--quiet", "--detach", exactCommit], { cwd: clone });
    const exactBoundReadme = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { readFileSync } from "node:fs"; import { e3T06RecoveryBoundReadme } from "./packages/identity/scripts/work-queue-snapshot-lib.mjs"; process.stdout.write(e3T06RecoveryBoundReadme(readFileSync(0, "utf8"), process.env.E3_T06_LIFECYCLE_COMMIT));',
      ],
      {
        cwd: clone,
        input: exactReadme,
        encoding: "utf8",
        env: { ...process.env, E3_T06_LIFECYCLE_COMMIT: exactCommit },
      },
    );
    const commitBinding = ({ projectText = null, queueText = null, readme }, message) => {
      writeFileSync(resolve(clone, E3_T06_TASK_PATH), readme);
      const expectedPaths = [E3_T06_TASK_PATH];
      if (projectText !== null) {
        writeFileSync(projectPath, projectText);
        expectedPaths.push(".eforest/project.json");
      }
      if (queueText !== null) {
        writeFileSync(resolve(clone, ".eforest/tasks/QUEUE.md"), queueText);
        expectedPaths.push(".eforest/tasks/QUEUE.md");
      }
      execFileSync("git", ["add", ...expectedPaths], { cwd: clone });
      const paths = execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: clone,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
      assert.deepEqual(paths, expectedPaths.sort());
      execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: clone });
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: clone,
        encoding: "utf8",
      }).trim();
    };
    const exactBindCommit = commitBinding(
      { readme: exactBoundReadme },
      `E3-T06 exact lifecycle bind ${label}`,
    );
    const exactBoundSnapshot = snapshotFromCliSource(clone, cliSource, E3_T06_TASK_ID, {
      attester: controlCommit,
      source: exactBindCommit,
      base: exactCommit,
    });
    assert.equal(exactBoundSnapshot.recoveryAuthorization.resumeCommit, exactCommit);
    assert.deepEqual(exactBoundSnapshot.changedPaths, [E3_T06_TASK_PATH]);

    execFileSync("git", ["checkout", "--quiet", "--detach", exactCommit], { cwd: clone });
    const badBindProject = JSON.parse(exactProjectText);
    badBindProject.unauthorizedBindMutation = true;
    const badBindPathsCommit = commitBinding(
      {
        readme: exactBoundReadme,
        projectText: `${JSON.stringify(badBindProject, null, 2)}\n`,
      },
      `E3-T06 bad bind paths ${label}`,
    );
    assertSibling(
      badBindPathsCommit,
      badBindPathsAccepted,
      "E3-T06 CLI accepted a lifecycle bind that changed project bytes",
      exactCommit,
      exactCommit,
    );

    execFileSync("git", ["checkout", "--quiet", "--detach", exactCommit], { cwd: clone });
    const badBindReadme = `${exactBoundReadme}\n### 2026-08-01 — builder — unauthorized bind content\n\n- x\n`;
    const badBindReadmeCommit = commitBinding(
      { readme: badBindReadme },
      `E3-T06 bad bind readme ${label}`,
    );
    assertSibling(
      badBindReadmeCommit,
      badBindReadmeAccepted,
      "E3-T06 CLI accepted a lifecycle bind that changed unrelated readme bytes",
      exactCommit,
      exactCommit,
    );

    execFileSync("git", ["checkout", "--quiet", "--detach", exactCommit], { cwd: clone });
    const secondBindCommit = commitBinding(
      { readme: exactBoundReadme },
      `E3-T06 second lifecycle bind ${label}`,
    );
    const bindTree = execFileSync("git", ["rev-parse", `${exactBindCommit}^{tree}`], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const ambiguousBindCommit = execFileSync(
      "git",
      [
        "commit-tree",
        bindTree,
        "-p",
        exactBindCommit,
        "-p",
        secondBindCommit,
        "-m",
        `E3-T06 ambiguous lifecycle bind ${label}`,
      ],
      { cwd: clone, encoding: "utf8" },
    ).trim();
    assertSibling(
      ambiguousBindCommit,
      ambiguousBindAccepted,
      "E3-T06 CLI accepted two competing lifecycle-binding children",
      exactCommit,
      exactCommit,
    );
    return 8;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function joinRecoveredFixtureLineage(clone) {
  const fixtureRecovery = recoveryRequest(readFileSync(resolve(clone, TASK_PATH), "utf8"), {
    taskId: TASK_ID,
  });
  assert.notEqual(fixtureRecovery, null, "lineage sensor requires a recovered task fixture");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", fixtureRecovery.resumeCommit, "HEAD"], {
      cwd: clone,
    });
  } catch {
    // The stacked task branch can carry an exact recovery record without descending from
    // that older task's resume commit. Join only the disposable fixture's object graph so
    // the lineage sensor measures its intended transition instead of unrelated stack shape.
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const fixtureBase = execFileSync(
      "git",
      [
        "commit-tree",
        tree,
        "-p",
        head,
        "-p",
        fixtureRecovery.resumeCommit,
        "-m",
        "join recovered lineage fixture",
      ],
      { cwd: clone, encoding: "utf8" },
    ).trim();
    execFileSync("git", ["checkout", "--quiet", "--detach", fixtureBase], { cwd: clone });
  }
  return fixtureRecovery;
}

function verifyCharterControlRoot() {
  const temporary = mkdtempSync(resolve(tmpdir(), "eforest-charter-root-"));
  const clone = resolve(temporary, "repo");
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", root, clone]);
    execFileSync("git", ["config", "user.name", "E2 Policy Sensor"], { cwd: clone });
    execFileSync("git", ["config", "user.email", "policy@example.invalid"], { cwd: clone });
    joinRecoveredFixtureLineage(clone);
    writeFileSync(
      resolve(clone, "packages/identity/scripts/work-queue-snapshot-lib.mjs"),
      snapshotLibSource,
    );
    writeFileSync(
      resolve(clone, "packages/identity/scripts/work-queue-snapshot.mjs"),
      snapshotCliSource,
    );
    execFileSync(
      "git",
      [
        "add",
        "packages/identity/scripts/work-queue-snapshot-lib.mjs",
        "packages/identity/scripts/work-queue-snapshot.mjs",
      ],
      { cwd: clone },
    );
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: clone });
    } catch {
      execFileSync("git", ["commit", "--quiet", "-m", "install control-root sensor"], {
        cwd: clone,
      });
    }
    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const before = committedSnapshot(clone, E3_T06_TASK_ID);
    const agentsPath = resolve(clone, "AGENTS.md");
    writeFileSync(agentsPath, `${readFileSync(agentsPath, "utf8")}\n<!-- control-root-probe -->\n`);
    execFileSync("git", ["add", "AGENTS.md"], { cwd: clone });
    execFileSync("git", ["commit", "--quiet", "-m", "mutate governing charter"], { cwd: clone });
    const after = committedSnapshot(clone, E3_T06_TASK_ID, {
      attester: base,
      source: "HEAD",
      base,
    });
    assert.notEqual(after.controlDigest, before.controlDigest);
    assert.deepEqual(after.changedPaths, ["AGENTS.md"]);
    assert.equal(after.attesterDigest, before.attesterDigest);
    return 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyCommittedCliResolvers(cliSource, label) {
  const temporary = mkdtempSync(resolve(tmpdir(), `eforest-resolvers-${label}-`));
  const clone = resolve(temporary, "repo");
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", root, clone]);
    execFileSync("git", ["config", "user.name", "E2 Policy Sensor"], { cwd: clone });
    execFileSync("git", ["config", "user.email", "policy@example.invalid"], { cwd: clone });
    const sourceBase = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const sourceParent = execFileSync("git", ["rev-parse", "HEAD^"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const sourceTree = execFileSync("git", ["rev-parse", `${sourceBase}^{tree}`], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const orphanCommit = execFileSync(
      "git",
      ["commit-tree", sourceTree, "-m", "unreachable resolver probe"],
      { cwd: clone, encoding: "utf8" },
    ).trim();
    const missingCommit = "0".repeat(40);
    const agentsLineCount = addressableLineCount(readFileSync(resolve(clone, "AGENTS.md"), "utf8"));
    const resolverTaskId = "E9-T99";
    const resolverTaskRelativePath = "epic-9-synthetic/E9-T99-resolver/readme.md";
    const resolverTaskPath = `.eforest/tasks/${resolverTaskRelativePath}`;
    const readmePath = resolve(clone, resolverTaskPath);
    mkdirSync(resolve(readmePath, ".."), { recursive: true });
    // Resolver probes use an isolated ordinary-task ledger. They must not append to or
    // rewrite whichever real task happens to be at the queue gate when this sensor runs.
    const probe =
      "### 2026-07-17 — judge — VERDICT: refuted\n\n" +
      `- Resolver probe: \`AGENTS.md:1\`, \`AGENTS.md:${agentsLineCount}\`, ` +
      `\`AGENTS.md:${agentsLineCount + 1}\`, \`resolver-empty.txt:1\`, ` +
      `\`../AGENTS.md:1\`, \`AGENTS.md:999999\`, \`${sourceParent}..${sourceBase}\`, ` +
      `\`${orphanCommit}..${sourceBase}\`, and \`${missingCommit}..${sourceBase}\`.`;
    writeFileSync(
      readmePath,
      `---\nid: ${resolverTaskId}\nstatus: in-progress\n---\n\n## Verification log\n\n${probe}\n`,
    );
    writeFileSync(
      resolve(clone, ".eforest/tasks/QUEUE.md"),
      fixtureQueue(resolverTaskId, resolverTaskRelativePath),
    );
    writeFileSync(resolve(clone, "resolver-empty.txt"), "");
    writeFileSync(
      resolve(clone, "packages/identity/scripts/work-queue-snapshot-lib.mjs"),
      snapshotLibSource,
    );
    writeFileSync(resolve(clone, "packages/identity/scripts/work-queue-snapshot.mjs"), cliSource);
    execFileSync(
      "git",
      [
        "add",
        ".eforest/tasks/QUEUE.md",
        resolverTaskPath,
        "resolver-empty.txt",
        "packages/identity/scripts/work-queue-snapshot-lib.mjs",
        "packages/identity/scripts/work-queue-snapshot.mjs",
      ],
      { cwd: clone },
    );
    execFileSync("git", ["commit", "--quiet", "-m", `resolver policy ${label}`], { cwd: clone });
    const value = committedSnapshot(clone, resolverTaskId);
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === "AGENTS.md:1"),
      true,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === `AGENTS.md:${agentsLineCount}`),
      true,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === `AGENTS.md:${agentsLineCount + 1}`),
      false,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === "resolver-empty.txt:1"),
      false,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === "../AGENTS.md:1"),
      false,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === "AGENTS.md:999999"),
      false,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === `${sourceParent}..${sourceBase}`),
      true,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === `${missingCommit}..${sourceBase}`),
      false,
    );
    assert.equal(
      value.evidenceCatalog.some((item) => item.ref === `${orphanCommit}..${sourceBase}`),
      false,
    );
    return 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function verifyTransitionLineage(cliSource, label) {
  const temporary = mkdtempSync(resolve(tmpdir(), `eforest-lineage-${label}-`));
  const clone = resolve(temporary, "repo");
  try {
    execFileSync("git", ["clone", "--quiet", "--shared", root, clone]);
    execFileSync("git", ["config", "user.name", "E2 Policy Sensor"], { cwd: clone });
    execFileSync("git", ["config", "user.email", "policy@example.invalid"], { cwd: clone });
    const fixtureRecovery = joinRecoveredFixtureLineage(clone);
    writeFileSync(
      resolve(clone, "packages/identity/scripts/work-queue-snapshot-lib.mjs"),
      snapshotLibSource,
    );
    writeFileSync(resolve(clone, "packages/identity/scripts/work-queue-snapshot.mjs"), cliSource);
    execFileSync(
      "git",
      [
        "add",
        "packages/identity/scripts/work-queue-snapshot-lib.mjs",
        "packages/identity/scripts/work-queue-snapshot.mjs",
      ],
      { cwd: clone },
    );
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: clone });
    } catch {
      execFileSync("git", ["commit", "--quiet", "-m", `install lineage sensor ${label}`], {
        cwd: clone,
      });
    }

    // Build the lifecycle base inside the disposable clone. The permanent sensor must
    // run from verified, refuted, implemented, or invalid-loop repository tips; it may
    // not assume the caller happens to be in the builder's pre-submission phase.
    let inProgressTaskPaths = "";
    try {
      inProgressTaskPaths = execFileSync(
        "git",
        ["grep", "-l", "^status: in-progress$", "--", ".eforest/tasks"],
        { cwd: clone, encoding: "utf8" },
      );
    } catch (error) {
      if (error.status !== 1) throw error;
    }
    const displacedTaskPaths = inProgressTaskPaths
      .trim()
      .split("\n")
      .filter((path) => path.length > 0 && path !== TASK_PATH);
    for (const path of displacedTaskPaths) {
      const taskReadme = readFileSync(resolve(clone, path), "utf8");
      const pendingReadme = taskReadme.replace(/^status: in-progress$/m, "status: pending");
      assert.notEqual(pendingReadme, taskReadme, `could not displace ${path}`);
      writeFileSync(resolve(clone, path), pendingReadme);
    }
    const readmePath = resolve(clone, TASK_PATH);
    const startingReadme = readFileSync(readmePath, "utf8");
    const startingLedger = parseVerificationLedger(startingReadme, {
      taskId: TASK_ID,
      auditStart: 6,
    });
    const startingRecovery = recoveryRequest(startingReadme, { taskId: TASK_ID });
    const runCeiling = runCeilingForTask(
      Object.fromEntries(
        /^---\n([\s\S]*?)\n---\n/
          .exec(startingReadme)[1]
          .split("\n")
          .map((line) => /^([a-z_]+):\s*(.*)$/.exec(line))
          .filter(Boolean)
          .map((entry) => [entry[1], entry[2]]),
      ),
    );
    const keepRuns = Math.max(
      startingRecovery?.baseRun ?? 0,
      Math.min(startingLedger.runCount, runCeiling - 1),
    );
    const removeSection = (text, entry) => {
      const heading = entry.split("\n", 1)[0];
      const start = text.indexOf(heading);
      assert.notEqual(start, -1, `lineage fixture could not find ${heading}`);
      const next = text.indexOf("\n### ", start + heading.length);
      return next === -1 ? text.slice(0, start) : `${text.slice(0, start)}${text.slice(next + 1)}`;
    };
    let lineageReadme = startingReadme;
    for (const run of startingLedger.runs.filter((entry) => entry.run > keepRuns)) {
      lineageReadme = removeSection(lineageReadme, run.report);
    }
    for (const audit of startingLedger.audits.filter((entry) => entry.lastRun > keepRuns)) {
      lineageReadme = removeSection(lineageReadme, audit.entry);
    }
    const inProgressReadme = lineageReadme.replace(
      /^status: (?:verified|refuted|implemented|in-progress)$/m,
      "status: in-progress",
    );
    assert.notEqual(inProgressReadme, lineageReadme, "lineage status transition did not apply");
    assert.equal(inProgressReadme.includes("status: in-progress\n"), true);
    writeFileSync(readmePath, inProgressReadme);
    const projectPath = resolve(clone, ".eforest/project.json");
    const project = JSON.parse(readFileSync(projectPath, "utf8"));
    if (project.status !== "building") {
      project.status = "building";
      project.statusReason = "Policy sensor synthetic in-progress base";
      writeFileSync(projectPath, `${JSON.stringify(project, null, 2)}\n`);
    }
    const queuePath = resolve(clone, ".eforest/tasks/QUEUE.md");
    try {
      execFileSync("python3", ["tools/build_queue.py"], {
        cwd: clone,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
      const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
      throw new Error(
        `synthetic queue rebuild failed (${label}): ${stderr || stdout || error.message}`,
        { cause: error },
      );
    }
    const inProgressQueue = readFileSync(queuePath, "utf8");
    assert.equal(inProgressQueue.includes("*(builder working)*"), true);
    execFileSync(
      "git",
      ["add", TASK_PATH, ...displacedTaskPaths, ".eforest/project.json", ".eforest/tasks/QUEUE.md"],
      { cwd: clone },
    );
    try {
      execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: clone });
      execFileSync(
        "git",
        ["commit", "--quiet", "--allow-empty", "-m", "synthetic in-progress base"],
        { cwd: clone },
      );
    } catch {
      execFileSync("git", ["commit", "--quiet", "-m", "synthetic in-progress base"], {
        cwd: clone,
      });
    }

    const base = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["merge-base", "--is-ancestor", fixtureRecovery.resumeCommit, base], {
      cwd: clone,
    });
    const before = committedSnapshot(clone);
    assert.equal(before.status, "in-progress");
    assert.equal(before.runCount >= 1, true);
    const implemented = readFileSync(readmePath, "utf8").replace(
      "status: in-progress\n",
      "status: implemented\n",
    );
    assert.notEqual(implemented, readFileSync(readmePath, "utf8"));
    writeFileSync(readmePath, implemented);
    const queue = readFileSync(queuePath, "utf8");
    const implementedQueue = queue
      .replace("*(builder working)*", "*(awaiting independent critic)*")
      .replace("- [~] `201` [E2-T01]", "- [?] `201` [E2-T01]");
    assert.notEqual(implementedQueue, queue, "synthetic queue transition did not apply");
    assert.equal(implementedQueue.includes("*(builder working)*"), false);
    assert.equal(implementedQueue.includes("- [~] `201` [E2-T01]"), false);
    writeFileSync(queuePath, implementedQueue);
    execFileSync("git", ["add", TASK_PATH, ".eforest/tasks/QUEUE.md"], { cwd: clone });
    execFileSync("git", ["commit", "--quiet", "-m", "synthetic implementation"], {
      cwd: clone,
    });
    const implementationTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: clone,
      encoding: "utf8",
    }).trim();
    const sideCommit = execFileSync(
      "git",
      [
        "commit-tree",
        implementationTree,
        "-p",
        before.recoveryAuthorization.resumeCommit,
        "-m",
        "non-descendant implementation",
      ],
      { cwd: clone, encoding: "utf8" },
    ).trim();
    assert.throws(() =>
      execFileSync("git", ["merge-base", "--is-ancestor", base, sideCommit], { cwd: clone }),
    );
    const side = committedSnapshot(clone, TASK_ID, {
      attester: base,
      source: sideCommit,
      base,
    });
    assert.equal(side.transitionBaseIsDirectParent, false);
    assert.deepEqual(side.changedPaths, [TASK_PATH, ".eforest/tasks/QUEUE.md"].sort());
    const run = await executeWorkQueue(workQueueSource, {
      rawReaderSnapshots: true,
      readerSnapshots: [before, side],
    });
    assert.deepEqual(run.events, ["implement"]);
    assert.equal(run.events.includes("verify"), false);
    return 1;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const cliSnapshot = committedSnapshot(root, E3_T06_TASK_ID);
assert.equal(cliSnapshot.taskId, E3_T06_TASK_ID);
assert.equal(
  cliSnapshot.sourceCommit,
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
);
scenarios += 1;
scenarios += verifyCommittedCliResolvers(snapshotCliSource, "baseline");
scenarios += verifyRecoveryLifecyclePathSet(snapshotCliSource, "baseline");
scenarios += verifyE3T06ExactLifecycleComparator(snapshotCliSource, "baseline");
scenarios += verifyCharterControlRoot();
scenarios += await verifyTransitionLineage(snapshotCliSource, "baseline");

const dirtyRoot = mkdtempSync(resolve(tmpdir(), "eforest-attester-"));
const dirtyRepo = resolve(dirtyRoot, "repo");
try {
  execFileSync("git", ["clone", "--quiet", "--shared", root, dirtyRepo]);
  writeFileSync(
    resolve(dirtyRepo, "packages/identity/scripts/work-queue-snapshot.mjs"),
    'process.stdout.write("{\\"schemaVersion\\":2,\\"status\\":\\"verified\\"}\\n");\n',
  );
  const honest = committedSnapshot(dirtyRepo, E3_T06_TASK_ID);
  assert.equal(honest.status, cliSnapshot.status);
  assert.equal(honest.sourceCommit, cliSnapshot.sourceCommit);
  scenarios += 1;
} finally {
  rmSync(dirtyRoot, { recursive: true, force: true });
}

const workQueueMutations = [
  {
    name: "reader-consensus",
    from: "if (!readers[0]?.snapshot || readers[0].snapshot !== readers[1]?.snapshot) return null",
    to: "if (!readers[0]?.snapshot || false) return null",
  },
  {
    name: "checkpoint-closure",
    from: "if (snapshot.progressAuditedThrough < requiredPriorCheckpoint || snapshot.progressAuditedThrough > latestPossibleCheckpoint) return false",
    to: "if (snapshot.progressAuditedThrough > latestPossibleCheckpoint) return false",
  },
  {
    name: "canonical-task-path",
    from: "if (!validTaskPath(taskId, snapshot.taskPath)) return false",
    to: "if (false) return false",
  },
  {
    name: "structured-citation",
    from: "candidate.kind === item.kind && candidate.ref === item.ref",
    to: "true",
  },
  {
    name: "catalog-verifier-binding",
    from: "snapshot.evidenceCatalog.some((item) => !validCatalogItem(item))",
    to: "false",
  },
  {
    name: "committed-attester-command",
    from: "git show ${attesterCommit}:${SNAPSHOT_SCRIPT} | node",
    to: "node packages/identity/scripts/work-queue-snapshot.mjs && node",
  },
  {
    name: "immutable-ledger-history",
    from: "before.ledgerDigest === after.ledgerDigest &&\n  JSON.stringify(before.runEntryDigests) === JSON.stringify(after.runEntryDigests)",
    to: "true &&\n  true",
  },
  {
    name: "requested-run-ceiling",
    from: "if (configuredMaxRuns > snapshot.runCeiling) {",
    to: "if (false) {",
  },
  {
    name: "snapshot-run-ceiling",
    from: "snapshot.runCount > snapshot.runCeiling",
    to: "false",
  },
  {
    name: "transition-direct-parent",
    from: "(expectedBase !== null && snapshot.transitionBaseIsDirectParent !== true)",
    to: "false",
  },
  {
    name: "recovery-authorization-shape",
    from: "if (!validRecoveryAuthorization(snapshot)) return false",
    to: "if (false) return false",
  },
  {
    name: "e3-t06-recovery-base-pin",
    from: "    value?.baseRun === 8 &&",
    to: "    value?.baseRun >= 7 &&",
  },
  {
    name: "e3-t06-recovery-stop-pin",
    from: "    value.invalidLoopCommit === E3_T06_LEDGER_RECOVERY_INVALID_LOOP_COMMIT &&",
    to: "    OID.test(value.invalidLoopCommit) &&",
  },
  {
    name: "e3-t06-recovery-prior-audit-count",
    from: "        value.priorAuditCount === 0 &&",
    to: "        value.priorAuditCount >= 0 &&",
  },
  {
    name: "e3-t06-recovery-resume-audit-count",
    from: "        value.resumeAuditCount === 2 &&",
    to: "        value.resumeAuditCount >= 1 &&",
  },
  {
    name: "e3-t06-null-recovery-invalid-loop-state",
    from: "return snapshot.projectStatus === 'invalid_loop' && snapshot.runCeiling === 10",
    to: "return snapshot.runCeiling === 10",
  },
  {
    name: "recovery-authorization-history",
    from: "JSON.stringify(before.recoveryAuthorization) === JSON.stringify(after.recoveryAuthorization) &&",
    to: "true &&",
  },
  {
    name: "control-source-digest",
    from: "before.controlDigest === after.controlDigest &&",
    to: "true &&",
  },
  {
    name: "audit-control-source-digest",
    from: "after.controlDigest === snapshot.controlDigest &&",
    to: "true &&",
  },
  {
    name: "verdict-control-source-digest",
    from: "      after.controlDigest === before.controlDigest &&",
    to: "      true &&",
  },
  {
    name: "audit-run-history-prefix",
    from: "JSON.stringify(after.runEntryDigests) === JSON.stringify(snapshot.runEntryDigests) &&",
    to: "true &&",
  },
  {
    name: "audit-entry-history-prefix",
    from: "samePrefix(snapshot, after, 'auditEntryDigests', 1) &&",
    to: "true &&",
  },
  {
    name: "verdict-audit-history",
    from: "JSON.stringify(after.auditEntryDigests) === JSON.stringify(before.auditEntryDigests) &&",
    to: "true &&",
  },
  {
    name: "audit-transition-path-set",
    from: "exactChanged(after, [snapshot.taskPath, QUEUE_PATH]) &&",
    to: "true &&",
  },
  {
    name: "audit-structured-readback",
    from: "canonicalText(after.latestAudit.rationale) === canonicalText(progress.rationale) &&",
    to: "true &&",
  },
  {
    name: "latest-audit-assessment",
    from: "snapshot.latestAudit.assessment !== 'progressing' &&",
    to: "false &&",
  },
  {
    name: "audit-attester-digest",
    from: "after.attesterDigest === snapshot.attesterDigest &&",
    to: "true &&",
  },
  {
    name: "audit-evidence-readback",
    from: "after.latestAudit.evidence.map((item) => ({",
    to: "progress.evidence.map((item) => ({",
  },
  {
    name: "audit-next-focus-readback",
    from: "JSON.stringify(after.latestAudit.nextFocus.map(canonicalText)) ===",
    to: "JSON.stringify(progress.nextFocus.map(canonicalText)) ===",
  },
  {
    name: "implementation-transition-path-set",
    from: "!implementationChanged(after, before.taskPath) ||",
    to: "false ||",
  },
  {
    name: "verdict-transition-path-set",
    from: "verdictChanged(after, before.taskPath) &&",
    to: "true &&",
  },
  {
    name: "invalid-loop-transition-path-set",
    from: "exactChanged(after, [PROJECT_PATH])",
    to: "true",
  },
  {
    name: "invalid-loop-project-status",
    from: "    after.projectStatus === 'invalid_loop' &&",
    to: "    true &&",
  },
  {
    name: "task-bound-audit-start",
    from: "if (snapshot.auditStart !== (taskId === 'E2-T01' ? 6 : 3)) return false",
    to: "if (!Number.isInteger(snapshot.auditStart)) return false",
  },
  {
    name: "verdict-history-prefix",
    from: "samePrefix(before, after, 'runEntryDigests', 1) &&",
    to: "true &&",
  },
  {
    name: "observed-commit-movement",
    from: "after.sourceCommit !== before.sourceCommit",
    to: "true",
  },
  {
    name: "verdict-task-identity",
    from: "verdict?.taskId === taskId &&",
    to: "true &&",
  },
  {
    name: "verdict-attester-digest",
    from: "      after.attesterDigest === before.attesterDigest &&",
    to: "      true &&",
  },
  {
    name: "verdict-log-entry-readback",
    from: "last?.logEntry === verdict?.logEntry?.trim() &&",
    to: "true &&",
  },
  {
    name: "verdict-value-readback",
    from: "last?.verdict === verdict.verdict &&",
    to: "true &&",
  },
  {
    name: "verdict-status-readback",
    from: "after.status === expectedStatus",
    to: "true",
  },
  {
    name: "invalid-loop-ledger-readback",
    from: "    sameLedger(before, after) &&",
    to: "    true &&",
  },
  {
    name: "invalid-loop-observed-commit",
    from: "    observedCommit(committed, before, after) &&",
    to: "    true &&",
  },
  {
    name: "invalid-loop-result-propagation",
    from: "if (!(await flipInvalid(reason, before))) return unpersistedStop(reason)",
    to: "await flipInvalid(reason, before)",
  },
  {
    name: "initial-audit-stop-propagation",
    from: "if (initialAuditStop) return initialAuditStop",
    to: "if (false) return initialAuditStop",
  },
  {
    name: "loop-audit-stop-propagation",
    from: "if (auditStop) return auditStop",
    to: "if (false) return auditStop",
  },
];

for (const mutation of workQueueMutations) {
  const mutated = workQueueSource.replace(mutation.from, mutation.to);
  assert.notEqual(mutated, workQueueSource, `${mutation.name} did not apply`);
  await assert.rejects(
    () => verifyWorkQueuePolicy(mutated),
    undefined,
    `${mutation.name} survived`,
  );
}

const parserMutations = [
  {
    name: "parser-authorized-run-ceiling",
    from: "ceiling < 2 || ceiling > 100",
    to: "ceiling < 2 || false",
  },
  {
    name: "parser-history-run-ceiling",
    from: "if (ledger.runCount > runCeiling) {",
    to: "if (false) {",
  },
  {
    name: "parser-recovery-history-boundary",
    from: "ledger.runCount < recoveryAuthorization.priorRunCount ||",
    to: "false ||",
  },
  {
    name: "parser-recovery-ledger-prefix-digest",
    from: "priorLedgerPrefixDigest !== recoveryAuthorization?.priorLedgerDigest ||",
    to: "false ||",
  },
  ...[
    "resumeParentVerified",
    "resumeAncestorVerified",
    "controlParentVerified",
    "invalidLoopStatusVerified",
    "ceilingIntroducedVerified",
    "statusReasonVerified",
    "approvalPathsVerified",
    "historyPrefixVerified",
    "checkpointOverrideVerified",
    "sameGateVerified",
  ].map((field) => ({
    name: `parser-recovery-${field}`,
    from: `recoveryAuthorization?.${field} !== true`,
    to: "false",
  })),
  {
    name: "parser-recovery-checkpoint-audit-inheritance",
    from: 'typeof recoveryAuthorization?.checkpointAuditInherited !== "boolean"',
    to: "false",
  },
  {
    name: "parser-frontmatter-id",
    from: "if (fields.id !== taskId)",
    to: "if (false)",
  },
  {
    name: "parser-run-sequence",
    from: "if (run.run !== index + 1) throw new Error(`official verdict history skips run ${index + 1}`);",
    to: "if (false) throw new Error('disabled');",
  },
  {
    name: "parser-canonical-path",
    from: "!new RegExp(`^\\\\.eforest/tasks/epic-${epic}[^/]*/${escaped}(?:-[^/]+)?/readme\\\\.md$`).test(path)",
    to: "false",
  },
  {
    name: "parser-audit-window",
    from: "lastRun < auditStart ||",
    to: "false ||",
  },
  {
    name: "parser-audit-sequence",
    from: "if (!audits.some((entry) => entry.lastRun === expected)) {",
    to: "if (false) {",
  },
  {
    name: "parser-verification-log-scope",
    from: "const start = logStarts[0] + 1;",
    to: "const start = 0;",
  },
  {
    name: "parser-visible-verdict-body",
    from: "const findings = topLevelBullets(section.visibleEntry);",
    to: "const findings = topLevelBullets(section.entry);",
  },
  {
    name: "parser-visible-audit-body",
    from: "const bullets = topLevelBullets(section.visibleEntry);",
    to: "const bullets = topLevelBullets(section.entry);",
  },
  {
    name: "parser-audit-fields",
    from: "if (!parsed.complete && !pinnedLegacyE2T01Audit && !pinnedLegacyE2T05Audit) {",
    to: "if (false && !pinnedLegacyE2T01Audit && !pinnedLegacyE2T05Audit) {",
  },
  {
    name: "parser-e2-t05-verdict-pin",
    from: "sha256(section.entry) === LEGACY_E2_T05_VERDICTS[index].digest",
    to: "true",
  },
  {
    name: "parser-e2-t05-audit-pin",
    from: "entryDigest === LEGACY_E2_T05_AUDIT_1_3_DIGEST",
    to: "true",
  },
  {
    name: "parser-e3-t06-run-mapping",
    from: '    digest: "c370831074a4a9c721296e743d8ad82d94965a283cdc9cfe7a0378de0a6c4ae7",\n    run: 4,\n    verdict: "refuted",',
    to: '    digest: "c370831074a4a9c721296e743d8ad82d94965a283cdc9cfe7a0378de0a6c4ae7",\n    run: 5,\n    verdict: "refuted",',
  },
  {
    name: "parser-e3-t06-verdict-mapping",
    from: '    digest: "4ebe0f68f81a38976ea17e1cf7cb8d9b48d46eea9a576bd24df6deed4f0df49d",\n    run: 6,\n    verdict: "needs-evidence",',
    to: '    digest: "4ebe0f68f81a38976ea17e1cf7cb8d9b48d46eea9a576bd24df6deed4f0df49d",\n    run: 6,\n    verdict: "refuted",',
  },
  {
    name: "parser-e3-t06-recovery-stop-pin",
    from: "fields.verification_invalid_loop_commit === E3_T06_LEDGER_RECOVERY_INVALID_LOOP_COMMIT",
    to: 'COMMIT_OID.test(fields.verification_invalid_loop_commit ?? "")',
  },
  {
    name: "parser-e3-t06-full-stopped-readme-pin",
    from: "if (sha256(reconstructed) !== E3_T06_LEDGER_RECOVERY_STOPPED_README_DIGEST) {",
    to: "if (false) {",
  },
  {
    name: "parser-e3-t06-full-stopped-project-pin",
    from: "if (sha256(stoppedProjectText) !== E3_T06_LEDGER_RECOVERY_STOPPED_PROJECT_DIGEST) {",
    to: "if (false) {",
  },
  {
    name: "parser-e3-t06-status-canonicalization",
    from: '        return ["status: in-progress"];',
    to: "        return [line];",
  },
  {
    name: "parser-e3-t06-status-domain",
    from: "!/^status: (in-progress|implemented|verified)$/.test(line)",
    to: "!/^status: \\S+$/.test(line)",
  },
  {
    name: "parser-e3-t06-single-human-resume",
    from: "      humanResumeSections.length !== 1 ||",
    to: "      humanResumeSections.length < 1 ||",
  },
  {
    name: "parser-e3-t06-exact-recovery-tuple",
    from: "(e3T06RecoveryMetadataPresent && !exactE3T06LedgerRecovery)",
    to: "(e3T06LedgerRecovery && !exactE3T06LedgerRecovery)",
  },
  {
    name: "parser-e3-t06-explicit-default-ceiling",
    from: "if (e3T06RecoveryMetadataPresent) {",
    to: "if (false) {",
  },
  {
    name: "parser-e3-t06-null-recovery-project-state",
    from: '      JSON.parse(projectText).status !== "invalid_loop"',
    to: "      false",
  },
  {
    name: "parser-e2-t06-pre-run-stop-pin",
    from: "fields.verification_invalid_loop_commit === E2_T06_PRE_RUN_INVALID_LOOP_COMMIT",
    to: "true",
  },
  {
    name: "parser-e3-t01-pre-run-stop-pin",
    from: "fields.verification_invalid_loop_commit === E3_T01_PRE_RUN_INVALID_LOOP_COMMIT",
    to: "true",
  },
  {
    name: "parser-e2-t06-second-recovery-stop-pin",
    from: "fields.verification_invalid_loop_commit === E2_T06_SECOND_RECOVERY_INVALID_LOOP_COMMIT",
    to: "true",
  },
  {
    name: "parser-e2-t06-third-recovery-stop-pin",
    from: "fields.verification_invalid_loop_commit === E2_T06_THIRD_RECOVERY_INVALID_LOOP_COMMIT",
    to: "true",
  },
  {
    name: "parser-e2-t06-fourth-recovery-stop-pin",
    from: "fields.verification_invalid_loop_commit === E2_T06_FOURTH_RECOVERY_INVALID_LOOP_COMMIT",
    to: "true",
  },
  {
    name: "parser-task-bound-migration",
    from: 'if (fields.progress_audit_start !== "6") {',
    to: "if (false) {",
  },
  {
    name: "parser-plain-evidence-bullet",
    from: "const bullet = /^- (\\S.*)$/.exec(line);",
    to: "const bullet = /^- \\*\\*(\\S.*)$/.exec(line);",
  },
  {
    name: "parser-control-agents",
    from: '  "AGENTS.md",\n',
    to: "",
  },
  {
    name: "parser-control-loop",
    from: '  ".eforest/loop.md",\n',
    to: "",
  },
  {
    name: "parser-visible-evidence-catalog",
    from: "for (const match of run.visibleReport.matchAll",
    to: "for (const match of run.report.matchAll",
  },
  {
    name: "parser-visible-commit-catalog",
    from: "for (const value of run.visibleReport.match(/\\b[0-9a-f]{40}",
    to: "for (const value of run.report.match(/\\b[0-9a-f]{40}",
  },
  {
    name: "parser-addressable-line-count",
    from: 'return text.split("\\n").length - (text.endsWith("\\n") ? 1 : 0);',
    to: 'return text.split("\\n").length;',
  },
  {
    name: "parser-path-traversal",
    from: 'path.split("/").every((segment) => segment.length > 0 && segment !== "..")',
    to: "true",
  },
  {
    name: "parser-command-syntax-is-not-evidence",
    from: "      const ref = match[1];",
    to: '      const ref = match[1];\n      if (/^node /.test(ref)) add("command", ref, "git-path", ref);',
  },
  {
    name: "parser-unbound-digest-is-not-evidence",
    from: '    add("report", reportRef, "ledger-entry", run.entryDigest);',
    to: '    add("report", reportRef, "ledger-entry", run.entryDigest);\n    for (const value of run.visibleReport.match(/\\b[0-9a-f]{64}\\b/g) ?? []) add("digest", value, "ledger-entry-digest", reportRef);',
  },
];

for (const mutation of parserMutations) {
  const mutated = snapshotLibSource.replace(mutation.from, mutation.to);
  assert.notEqual(mutated, snapshotLibSource, `${mutation.name} did not apply`);
  const module = await importSnapshotModule(mutated, mutation.name);
  await assert.rejects(() => verifyParserPolicy(module), undefined, `${mutation.name} survived`);
}

const snapshotCliMutations = [
  {
    name: "path-line-resolver",
    from: "return start >= 1 && end >= start && end <= lineCount;",
    to: "return true;",
  },
  {
    name: "commit-resolver",
    from: 'git("cat-file", "-e", `${oid}^{commit}`);',
    to: "return true;",
  },
  {
    name: "commit-reachability",
    from: 'git("merge-base", "--is-ancestor", oid, sourceCommit);',
    to: "void sourceCommit;",
  },
  {
    name: "recovery-lifecycle-generated-queue-optionality",
    from: "const queueMayBeUnchanged = controlCommit !== null && !exactE3T06LedgerRecovery;",
    to: "const queueMayBeUnchanged = false;",
  },
  {
    name: "e3-t06-exact-lifecycle-readme",
    from: "resumeReadme !== snapshotModule.e3T06RecoveryLifecycleReadme(invalidReadme, controlCommit)",
    to: "false",
  },
  {
    name: "e3-t06-exact-lifecycle-project",
    from: "resumeProjectText !== snapshotModule.e3T06RecoveryLifecycleProject(invalidProjectText)",
    to: "false",
  },
  {
    name: "e3-t06-exact-lifecycle-path-set",
    from: "    !exactPaths(actualResumePaths, expectedResumePaths) &&",
    to: '    !exactPaths(actualResumePaths, expectedResumePaths) &&\n    !exactPaths(actualResumePaths, [...expectedResumePaths, ".eforest/tasks/QUEUE.md"]) &&',
  },
  {
    name: "e3-t06-single-lifecycle-bind-child",
    from: "if (bindCandidates.length !== 1) {",
    to: "if (false) {",
  },
  {
    name: "e3-t06-exact-bind-path-set",
    from: "!exactPaths(changedPathsFor(bindCommit), [taskPath])",
    to: "false",
  },
  {
    name: "e3-t06-exact-bound-readme",
    from: "bindReadme !== snapshotModule.e3T06RecoveryBoundReadme(resumeReadme, resumeCommit)",
    to: "false",
  },
];

for (const mutation of snapshotCliMutations) {
  const mutated = snapshotCliSource.replace(mutation.from, mutation.to);
  assert.notEqual(mutated, snapshotCliSource, `${mutation.name} did not apply`);
  if (mutation.name === "recovery-lifecycle-generated-queue-optionality") {
    assert.throws(
      () => verifyRecoveryLifecyclePathSet(mutated, mutation.name),
      undefined,
      `${mutation.name} survived its lifecycle fixture`,
    );
  } else if (mutation.name === "e3-t06-exact-lifecycle-readme") {
    verifyE3T06ExactLifecycleComparator(mutated, mutation.name, { badReadmeAccepted: true });
  } else if (mutation.name === "e3-t06-exact-lifecycle-project") {
    verifyE3T06ExactLifecycleComparator(mutated, mutation.name, { badProjectAccepted: true });
  } else if (mutation.name === "e3-t06-exact-lifecycle-path-set") {
    verifyE3T06ExactLifecycleComparator(mutated, mutation.name, { badQueueAccepted: true });
  } else if (mutation.name === "e3-t06-single-lifecycle-bind-child") {
    verifyE3T06ExactLifecycleComparator(mutated, mutation.name, { ambiguousBindAccepted: true });
  } else if (mutation.name === "e3-t06-exact-bind-path-set") {
    verifyE3T06ExactLifecycleComparator(mutated, mutation.name, { badBindPathsAccepted: true });
  } else if (mutation.name === "e3-t06-exact-bound-readme") {
    verifyE3T06ExactLifecycleComparator(mutated, mutation.name, { badBindReadmeAccepted: true });
  } else {
    assert.throws(
      () => verifyCommittedCliResolvers(mutated, mutation.name),
      undefined,
      `${mutation.name} survived`,
    );
  }
}

const transitionCliMutation = {
  name: "transition-cli-direct-parent",
  from: "sourceParents.length === 1 && sourceParents[0] === transitionBaseCommit",
  to: "true",
};
const mutatedTransitionCli = snapshotCliSource.replace(
  transitionCliMutation.from,
  transitionCliMutation.to,
);
assert.notEqual(
  mutatedTransitionCli,
  snapshotCliSource,
  `${transitionCliMutation.name} did not apply`,
);
await assert.rejects(
  () => verifyTransitionLineage(mutatedTransitionCli, transitionCliMutation.name),
  undefined,
  `${transitionCliMutation.name} survived`,
);

const verifyTaskMutation = {
  name: "verify-task-commit-oid-propagation",
  from: "commitOid: verdict?.commitOid ?? '',",
  to: "commitOid: '',",
};
const mutatedVerifyTask = verifyTaskSource.replace(verifyTaskMutation.from, verifyTaskMutation.to);
assert.notEqual(mutatedVerifyTask, verifyTaskSource, `${verifyTaskMutation.name} did not apply`);
await assert.rejects(
  () => verifyVerifyTaskBoundary(mutatedVerifyTask),
  undefined,
  `${verifyTaskMutation.name} survived`,
);

for (const mutation of coldCloneMutations) {
  const mutated = coldCloneSource.replace(mutation.from, mutation.to);
  assert.notEqual(mutated, coldCloneSource, `${mutation.name} did not apply`);
  assert.throws(
    () => verifyColdCloneTargetBoundary(mutated, mutation.name),
    undefined,
    `${mutation.name} survived`,
  );
}

const mutations = [
  ...workQueueMutations.map(({ name }) => name),
  ...parserMutations.map(({ name }) => name),
  ...snapshotCliMutations.map(({ name }) => name),
  transitionCliMutation.name,
  verifyTaskMutation.name,
  ...coldCloneMutations.map(({ name }) => name),
];
process.stdout.write(
  `${JSON.stringify({ mutations, scenarios, status: "WORK_QUEUE_POLICY_OK" })}\n`,
);
