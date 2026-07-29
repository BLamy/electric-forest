import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type AgentResult = Record<string, unknown>;
type AgentOptions = { readonly label: string; readonly phase: string };
type AsyncFunction = (...values: readonly unknown[]) => Promise<unknown>;

function workflowFunction(source: string): AsyncFunction {
  const AsyncFunctionConstructor = Object.getPrototypeOf(async function () {}).constructor as new (
    ...parameters: string[]
  ) => AsyncFunction;
  return new AsyncFunctionConstructor(
    "phase",
    "agent",
    "parallel",
    "args",
    "log",
    source.replace(/^export const meta =/m, "const meta ="),
  );
}

describe("verify-task workflow scheduling", () => {
  it("starts the cold critic only after every parallel attacker settles", async () => {
    const path = fileURLToPath(
      new URL("../../../.claude/workflows/verify-task.js", import.meta.url),
    );
    const execute = workflowFunction(readFileSync(path, "utf8"));
    const events: string[] = [];
    const pending = new Map<string, () => void>();
    const parallelLabels = new Set(["falsify:1", "coverage", "sabotage", "own-attacks"]);

    const agent = (_prompt: string, options: AgentOptions): Promise<AgentResult> => {
      if (options.label === "orient") {
        return Promise.resolve({
          ok: true,
          taskId: "E1-T10",
          taskPath: ".eforest/tasks/E1-T10",
          diffCmd: "git diff base..head",
          claims: ["claim"],
          criteria: ["criterion"],
          attackAngles: ["attack"],
          evidencePaths: [],
          replayRecordings: [],
          changedHunks: [{ file: "merge.ts", lines: "1-2" }],
          capstone: false,
        });
      }
      events.push(`start:${options.label}`);
      if (parallelLabels.has(options.label)) {
        return new Promise((resolve) => {
          pending.set(options.label, () => {
            events.push(`settle:${options.label}`);
            resolve({ findings: [], notes: `${options.label} survived` });
          });
        });
      }
      if (options.label === "mock-env-hunt") {
        return Promise.resolve({ findings: [], notes: "cold survived" });
      }
      if (options.label === "verdict") {
        return Promise.resolve({ verdict: "verified", logEntry: "", committed: false });
      }
      throw new Error(`unexpected agent ${options.label}`);
    };
    const parallel = (tasks: readonly (() => Promise<unknown>)[]): Promise<unknown[]> =>
      Promise.all(tasks.map((task) => task()));
    const run = execute(
      () => undefined,
      agent,
      parallel,
      { task: "E1-T10" },
      () => undefined,
    );

    while (pending.size < parallelLabels.size)
      await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).not.toContain("start:mock-env-hunt");
    for (const label of parallelLabels) pending.get(label)!();
    const result = await run;

    const coldStart = events.indexOf("start:mock-env-hunt");
    expect(coldStart).toBeGreaterThan(-1);
    for (const label of parallelLabels) {
      expect(coldStart).toBeGreaterThan(events.indexOf(`settle:${label}`));
    }
    expect(result).toMatchObject({ taskId: "E1-T10", verdict: "verified", findings: [] });
  });
});
