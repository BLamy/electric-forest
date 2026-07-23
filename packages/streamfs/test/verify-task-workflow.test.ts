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
  it("requires one complete lead review before the skeptic judge", async () => {
    const path = fileURLToPath(
      new URL("../../../.claude/workflows/verify-task.js", import.meta.url),
    );
    const execute = workflowFunction(readFileSync(path, "utf8"));
    const events: string[] = [];

    const agent = (prompt: string, options: AgentOptions): Promise<AgentResult> => {
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
      if (options.label === "lead-critic") {
        expect(prompt.indexOf("For EVERY criterion")).toBeLessThan(
          prompt.indexOf("run exactly ONE registered task-specific cold clone"),
        );
        events.push("settle:lead-critic");
        return Promise.resolve({
          findings: [],
          completion: {
            criteria: ["criterion survived"],
            hunks: ["merge.ts:1-2 executed"],
            attacks: ["task attack survived", "novel attack survived"],
            sabotage: ["mutation 1 red", "mutation 2 red", "mutation 3 red"],
            environment: "scrubbed environment survived",
            coldClone: "passed",
          },
          notes: "consolidated lead review survived",
        });
      }
      if (options.label === "verdict") {
        events.push("settle:verdict");
        return Promise.resolve({
          verdict: "verified",
          logEntry: "entry",
          baseCommit: "base",
          commitOid: "verdict",
        });
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
    const result = await run;

    expect(events).toEqual([
      "start:lead-critic",
      "settle:lead-critic",
      "start:verdict",
      "settle:verdict",
    ]);
    expect(result).toMatchObject({ taskId: "E1-T10", verdict: "verified", findings: [] });
  });
});
