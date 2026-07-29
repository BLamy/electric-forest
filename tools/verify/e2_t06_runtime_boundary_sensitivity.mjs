#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sourceDist = resolve(root, "packages/platform/dist/src");
const scratch = mkdtempSync(join(tmpdir(), "eforest-e2-t06-runtime-"));

function verifyCase(name, mutate, expected) {
  const directory = join(scratch, name);
  cpSync(sourceDist, join(directory, "dist"), { recursive: true });
  writeFileSync(
    join(directory, "runner.mjs"),
    'import { NamespaceRuntime } from "./dist/namespace-runtime.js";\n' +
      "const runtime = new NamespaceRuntime();\n" +
      'await runtime.isName("runtime-boundary");\n',
  );
  mutate(directory);
  const result = spawnSync(process.execPath, ["runner.mjs"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15_000,
  });
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, `${name} unexpectedly passed`);
  assert.match(output, expected, `${name} failed for the wrong reason:\n${output}`);
}

try {
  verifyCase(
    "computed-code-generation",
    (directory) => {
      const path = join(directory, "dist/ns/reducer.js");
      const source = readFileSync(path, "utf8");
      writeFileSync(
        path,
        `${source}\nconst derived = []["con" + "structor"]["con" + "structor"];\nderived("return globalThis")();\n`,
      );
    },
    /Code generation from strings disallowed/,
  );
  verifyCase(
    "runtime-import",
    (directory) => {
      const path = join(directory, "dist/ns/reducer.js");
      writeFileSync(path, `${readFileSync(path, "utf8")}\nimport "node:fs";\n`);
    },
    /namespace runtime import denied: node:fs/,
  );
  verifyCase(
    "permission-widening",
    (directory) => {
      const path = join(directory, "dist/namespace-runtime.js");
      const source = readFileSync(path, "utf8");
      const widened = source.replace('"--permission",', '"--permission", "--allow-fs-write=*",');
      assert.notEqual(widened, source, "permission flag mutation did not apply");
      writeFileSync(path, widened);
    },
    /namespace child acquired a denied runtime permission/,
  );
  console.log(
    "E2_T06_RUNTIME_BOUNDARY_SENSITIVITY_OK codegen=denied linker=denied permission-widening=denied",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
