import { describe, expect, it } from "vitest";
import { diffLines, formatDuration, parseRun, relative } from "./runSteps.js";

const cwd = "/tmp/eforest-agent-luna-x/docstream-demo";
const output = (lines: unknown[], channel = "stdout") => ({
  type: "agent.run.output",
  payload: {
    v: 1,
    seq: 0,
    channel,
    lines: lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))),
  },
});

describe("parseRun", () => {
  it("turns a Claude Code stream-json transcript into readable steps", () => {
    const view = parseRun([
      { type: "agent.run.started", payload: { model: "harness-default" }, ts: 1_000 },
      output([
        { type: "system", subtype: "init", cwd, model: "claude-sonnet-5" },
        { type: "system", subtype: "thinking_tokens", estimated_tokens: 50 },
        {
          type: "assistant",
          message: { content: [{ type: "thinking", thinking: "", signature: "x" }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Checking the README." }] },
        },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "Read",
                input: { file_path: `${cwd}/README.md` },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1", content: "1\t# docstream-demo" }],
          },
        },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "t2",
                name: "Edit",
                input: {
                  file_path: `${cwd}/README.md`,
                  old_string: "Hello world!",
                  new_string: "**Hello world!**",
                },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t2", content: "updated", is_error: false },
            ],
          },
        },
        { type: "rate_limit_event", rate_limit_info: {} },
        {
          type: "result",
          subtype: "success",
          duration_ms: 11_659,
          total_cost_usd: 0.047,
          result: "Done",
        },
      ]),
      { type: "agent.run.finished", payload: { status: "succeeded" }, ts: 14_000 },
    ]);
    expect(view).toMatchObject({
      status: "succeeded",
      durationMs: 11_659,
      model: "claude-sonnet-5",
      costUsd: 0.047,
    });
    expect(
      view.steps.map((step) =>
        step.kind === "tool" ? `${step.title} → ${step.result}` : `${step.kind}`,
      ),
    ).toEqual(["message", "Read README.md → 1\t# docstream-demo", "Edited README.md → updated"]);
    const edit = view.steps[2];
    expect(edit?.kind === "tool" ? edit.diff : null).toEqual({
      before: "Hello world!",
      after: "**Hello world!**",
    });
  });

  it("understands Codex exec --json items and merges started/completed", () => {
    const view = parseRun([
      { type: "agent.run.started", payload: {}, ts: 0 },
      output([
        { type: "thread.started", thread_id: "th" },
        {
          type: "item.started",
          item: { id: "i1", type: "command_execution", command: "ls", status: "in_progress" },
        },
        {
          type: "item.completed",
          item: {
            id: "i1",
            type: "command_execution",
            command: "ls",
            aggregated_output: "README.md\n",
            exit_code: 0,
          },
        },
        {
          type: "item.completed",
          item: {
            id: "i2",
            type: "file_change",
            changes: [{ path: "README.md", kind: "update" }],
            status: "completed",
          },
        },
        { type: "item.completed", item: { id: "i3", type: "agent_message", text: "Added hello." } },
        { type: "turn.completed", usage: {} },
      ]),
    ]);
    expect(view.status).toBe("running");
    expect(view.steps.map((step) => (step.kind === "tool" ? step.title : step.kind))).toEqual([
      "Ran ls",
      "Edited README.md",
      "message",
    ]);
  });

  it("keeps anything it does not understand as a raw line", () => {
    const view = parseRun([output(["warning: something", '{"type":"mystery"}'], "stderr")]);
    expect(view.steps).toMatchObject([
      { kind: "raw", channel: "stderr", text: "warning: something" },
      { kind: "raw", text: '{"type":"mystery"}' },
    ]);
  });

  it("formats durations like Codex", () => {
    expect(formatDuration(11_659)).toBe("12s");
    expect(formatDuration(63_000)).toBe("1m 3s");
    expect(formatDuration(120_000)).toBe("2m");
  });
});

describe("diffLines / relative", () => {
  it("shows only the changed lines of a whole-file rewrite, with context", () => {
    const before = "# demo\n\nDurable stream workspace.";
    const after = "# demo\n\nDurable stream workspace.\n\n## Getting started\n\nClone it.";
    expect(diffLines(before, after)).toEqual([
      { kind: "context", text: "# demo" },
      { kind: "context", text: "" },
      { kind: "context", text: "Durable stream workspace." },
      { kind: "add", text: "" },
      { kind: "add", text: "## Getting started" },
      { kind: "add", text: "" },
      { kind: "add", text: "Clone it." },
    ]);
  });

  it("collapses long unchanged runs to a gap", () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${String(index)}`);
    const edited = [...lines];
    edited[5] = "changed";
    expect(diffLines(lines.join("\n"), edited.join("\n")).map((line) => line.kind)).toEqual([
      "gap",
      "context",
      "context",
      "del",
      "add",
      "context",
      "context",
      "gap",
    ]);
  });

  it("keeps checkout paths relative and shortens anything outside it", () => {
    expect(relative("/tmp/co/src/app.ts", "/tmp/co")).toBe("src/app.ts");
    expect(relative("/Users/me/.claude/projects/x/memory/MEMORY.md", "/tmp/co")).toBe(
      "…/memory/MEMORY.md",
    );
  });
});
