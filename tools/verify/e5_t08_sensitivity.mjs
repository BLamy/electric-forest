#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const task = join(root, ".eforest/tasks/epic-5-the-meadow/E5-T08-wiki-branch-live");
const evidence = join(task, "evidence");
const browserTest = "apps/web/test/wiki.pw.ts";
const reusableDist = ["apps/web/dist"];

const mutations = [
  {
    label: "forced-full-write",
    expected: "canonical patch chooser assertion",
    sensor: /canonical-patch-chooser/,
    command: ["pnpm", ["exec", "vitest", "run", "--maxWorkers=1", "apps/web/src/wiki/useWiki.test.ts"]],
    builds: [],
    edits: [
      {
        file: "apps/web/src/wiki/useWiki.ts",
        before: "  fileRenameEvent,\n  type FsFileCreateEvent,",
        after: "  fileRenameEvent,\n  fileWriteEvent,\n  type FsFileCreateEvent,",
      },
      {
        file: "apps/web/src/wiki/useWiki.ts",
        before:
          "  return chooseFileWriteEvent(\n    encoder.encode(baseText),\n    encoder.encode(targetText),\n    path,\n    base,\n    now(),\n  );",
        after: "  return fileWriteEvent(encoder.encode(targetText), path, base, now());",
      },
    ],
  },
  {
    label: "optimistic-local-apply",
    expected: "no visible edited content before dispatch acknowledgement",
    sensor: /no-optimistic-visible-content-before-dispatch-ack/,
    command: [process.execPath, ["--experimental-strip-types", browserTest]],
    builds: ["web"],
    timeout: 120_000,
    edits: [
      {
        file: "apps/web/src/wiki/WikiEditor.tsx",
        before: "          <h2>Edit {props.slug}.md</h2>",
        after: [
          "          <h2>",
          "            {wiki.dispatch.counters.sent >",
          "            wiki.dispatch.counters.confirmed + wiki.dispatch.counters.refused",
          "              ? draft",
          "              : `Edit ${props.slug}.md`}",
          "          </h2>",
        ].join("\n"),
      },
    ],
  },
  {
    label: "stripped-base",
    expected: "caller base revision assertion",
    sensor: /caller-base-revision/,
    command: ["pnpm", ["exec", "vitest", "run", "--maxWorkers=1", "apps/web/src/wiki/useWiki.test.ts"]],
    builds: [],
    edits: [
      {
        file: "apps/web/src/wiki/useWiki.ts",
        before:
          "    encoder.encode(targetText),\n    path,\n    base,\n    now(),\n  );",
        after:
          "    encoder.encode(targetText),\n    path,\n    BASE_NONE,\n    now(),\n  );",
      },
    ],
  },
  {
    label: "unsanitized-renderer",
    expected: "hostile sanitizer assertion",
    sensor: /hostile-sanitizer-removes-active-markup/,
    command: [
      "pnpm",
      ["exec", "vitest", "run", "--maxWorkers=1", "apps/web/src/wiki/renderMarkdown.test.ts"],
    ],
    builds: [],
    edits: [
      {
        file: "apps/web/src/wiki/renderMarkdown.tsx",
        before: "export function sanitizeMarkdownForRender(markdown: string): string {\n  return markdown",
        after:
          "export function sanitizeMarkdownForRender(markdown: string): string {\n  if (markdown.length >= 0) return markdown;\n  return markdown",
      },
    ],
  },
];

function copyDependencies(worktree) {
  symlinkSync(join(root, "node_modules"), join(worktree, "node_modules"), "dir");
  for (const group of ["packages", "apps"]) {
    for (const name of readdirSync(join(root, group))) {
      const sourceModules = join(root, group, name, "node_modules");
      const targetModules = join(worktree, group, name, "node_modules");
      if (existsSync(sourceModules)) {
        cpSync(sourceModules, targetModules, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
        });
      }
      const sourceDist = join(root, group, name, "dist");
      const targetDist = join(worktree, group, name, "dist");
      if (existsSync(sourceDist)) cpSync(sourceDist, targetDist, { recursive: true });
    }
  }
  const targetEmulate = join(worktree, "vendor/emulate");
  rmSync(targetEmulate, { recursive: true, force: true });
  symlinkSync(join(root, "vendor/emulate"), targetEmulate, "dir");
}

function command(worktree, executable, args, timeout = 60_000, extraEnv = {}) {
  return spawnSync(executable, args, {
    cwd: worktree,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "true",
      EFOREST_TEST_PREBUILT: "1",
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      ...extraEnv,
    },
    killSignal: "SIGKILL",
    timeout,
  });
}

function restore(worktree, originals) {
  for (const [file, source] of originals) writeFileSync(join(worktree, file), source);
  for (const relative of reusableDist) {
    const target = join(worktree, relative);
    rmSync(target, { recursive: true, force: true });
    cpSync(join(root, relative), target, { recursive: true });
  }
}

function applyMutation(worktree, mutation) {
  for (const edit of mutation.edits) {
    const path = join(worktree, edit.file);
    const source = readFileSync(path, "utf8");
    assert.equal(
      source.split(edit.before).length - 1,
      1,
      `${mutation.label}: mutation anchor count for ${edit.file}`,
    );
    writeFileSync(path, source.replace(edit.before, edit.after));
  }
}

function buildMutation(worktree, mutation) {
  if (!mutation.builds.includes("web")) return;
  const result = command(worktree, "pnpm", ["--filter", "@eforest/web", "build"]);
  assert.equal(
    result.status,
    0,
    `${mutation.label}: targeted build failed:\n${result.stdout}\n${result.stderr}`,
  );
}

function observedLine(output, sensor) {
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => sensor.test(line)) ?? "<sensor matched only across lines>"
  ).slice(0, 500);
}

function markdownSafe(value) {
  return value.replaceAll("`", "\\`").replaceAll("\n", " ");
}

const worktree = mkdtempSync(join(tmpdir(), "eforest-e5-t08-sabotage-"));
const corruptedEvidenceRoot = mkdtempSync(join(tmpdir(), "eforest-e5-t08-golden-"));
let added = false;
const transcripts = [];
try {
  const add = spawnSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(add.status, 0, add.stderr);
  added = true;
  copyDependencies(worktree);

  const files = new Set(mutations.flatMap((mutation) => mutation.edits.map((edit) => edit.file)));
  const originals = new Map(
    [...files].map((file) => [file, readFileSync(join(worktree, file), "utf8")]),
  );

  for (const mutation of mutations) {
    restore(worktree, originals);
    applyMutation(worktree, mutation);
    buildMutation(worktree, mutation);
    const [executable, args] = mutation.command;
    const result = command(worktree, executable, args, mutation.timeout ?? 60_000);
    assert.notEqual(result.status, null, `${mutation.label}: causal run timed out`);
    assert.notEqual(result.status, 0, `${mutation.label}: causal run unexpectedly stayed green`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, mutation.sensor, `${mutation.label}: expected failure assertion absent`);
    transcripts.push({
      label: mutation.label,
      expected: mutation.expected,
      command: [executable, ...args].join(" "),
      exit: result.status,
      observed: observedLine(output, mutation.sensor),
    });
  }

  const corruptedEvidence = join(corruptedEvidenceRoot, "evidence");
  cpSync(evidence, corruptedEvidence, { recursive: true });
  const goldenPath = join(corruptedEvidence, "e5-t08-golden.digest");
  const golden = readFileSync(goldenPath, "utf8").trim();
  const corrupted = `${golden[0] === "0" ? "1" : "0"}${golden.slice(1)}`;
  writeFileSync(goldenPath, `${corrupted}\n`);
  const goldenResult = command(
    root,
    process.execPath,
    ["tools/verify/e5_t08_evidence.mjs"],
    60_000,
    { E5_T08_EVIDENCE_DIR: corruptedEvidence },
  );
  assert.notEqual(goldenResult.status, null, "corrupted-golden: causal run timed out");
  assert.notEqual(goldenResult.status, 0, "corrupted-golden: verifier unexpectedly stayed green");
  const goldenOutput = `${goldenResult.stdout}\n${goldenResult.stderr}`;
  const goldenSensor = /independent replay matches committed golden/;
  assert.match(goldenOutput, goldenSensor, "corrupted-golden: exact equality assertion absent");
  transcripts.push({
    label: "corrupted-golden",
    expected: "independent replay matches committed golden",
    command: "E5_T08_EVIDENCE_DIR=<corrupted-copy> node tools/verify/e5_t08_evidence.mjs",
    exit: goldenResult.status,
    observed: observedLine(goldenOutput, goldenSensor),
  });

  const report = [
    "# E5-T08 causal sensitivity transcripts",
    "",
    "Each case ran against a scratch worktree or copied evidence. Exit zero would fail this verifier.",
    "",
    ...transcripts.flatMap((entry) => [
      `## mutation=${entry.label} expected=${entry.expected}`,
      "",
      `- command: \`${markdownSafe(entry.command)}\``,
      `- exit: \`${String(entry.exit)}\` (precisely expected: nonzero)` ,
      `- observed assertion: \`${markdownSafe(entry.observed)}\``,
      `- mutation=${entry.label} expected=${entry.expected} EXPECTED-FAIL OK`,
      "",
    ]),
    `E5_T08_SENSITIVITY_OK cases=${String(transcripts.length)}`,
    "",
  ].join("\n");
  writeFileSync(join(evidence, "e5-t08-sensitivity.md"), report);
  for (const entry of transcripts) {
    process.stdout.write(
      `E5_T08_SENSITIVITY mutation=${entry.label} expected=${entry.expected} EXPECTED-FAIL OK\n`,
    );
  }
  process.stdout.write(`E5_T08_SENSITIVITY_OK cases=${String(transcripts.length)}\n`);
} finally {
  if (added) {
    const removed = spawnSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(removed.status, 0, removed.stderr);
  }
  rmSync(corruptedEvidenceRoot, { recursive: true, force: true });
}
