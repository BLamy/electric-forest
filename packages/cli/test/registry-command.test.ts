import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CliIo } from "../src/cli.js";
import { REGISTRY_USAGE, runRegistryCommand } from "../src/registry-command.js";

/**
 * E2-T08 run 2: every usage-refusal branch of `ef registry rebuild` executed
 * and literal-asserted — exit 2 with REGISTRY_USAGE on stderr — plus the
 * generic failure arm (exit 1, `registry rebuild failed:`). The happy path
 * and the RegistryPresentError/--force arms are exercised end-to-end by
 * packages/platform/test/registry.rebuild.test.ts.
 */

interface CapturedIo {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function capture(): CapturedIo {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (text: string) => {
        out += text;
      },
      stderr: (text: string) => {
        err += text;
      },
    },
    stdout: () => out,
    stderr: () => err,
  };
}

const scratch = mkdtempSync(join(tmpdir(), "ef-registry-usage-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("ef registry usage refusals", () => {
  const usageCases: readonly [string, readonly string[]][] = [
    ["no subcommand", []],
    ["unknown subcommand", ["rebuild-all"]],
    ["--data-dir with no value", ["rebuild", "--data-dir"]],
    ["--data-dir swallowing a flag", ["rebuild", "--data-dir", "--force"]],
    ["unknown flag", ["rebuild", "--data-dir", "/tmp/x", "--verbose"]],
    ["missing --data-dir", ["rebuild"]],
    ["missing --data-dir with only --force", ["rebuild", "--force"]],
  ];

  for (const [label, args] of usageCases) {
    it(`refuses ${label} with exit 2 and REGISTRY_USAGE on stderr`, async () => {
      const captured = capture();
      expect(await runRegistryCommand(args, captured.io)).toBe(2);
      expect(captured.stderr()).toBe(`${REGISTRY_USAGE}\n`);
      expect(captured.stdout()).toBe("");
    });
  }

  it("reports a store that cannot be opened as exit 1 with a loud failure line", async () => {
    // A regular file where the stream-store data dir must be: the reference
    // server cannot open it, and the failure arm reports it without a digest.
    const notADir = join(scratch, "not-a-directory");
    writeFileSync(notADir, "occupied\n");
    const captured = capture();
    expect(await runRegistryCommand(["rebuild", "--data-dir", notADir], captured.io)).toBe(1);
    expect(captured.stderr()).toMatch(/registry rebuild failed: /);
    expect(captured.stdout()).toBe("");
  });
});
