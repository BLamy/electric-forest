import { describe, expect, it } from "vitest";
import {
  agentRunInitialState,
  agentRunReducer,
  agentRunRefusal,
  isAgentRunDispatchPayload,
  type ChatChannelState,
} from "@eforest/reducers";
import type { Event } from "@eforest/protocol";
import {
  AgentRunLog,
  claudeStreamResult,
  linkedPullRequest,
  mirrorSource,
  prMirrorMessageId,
  syncThreadPullRequests,
} from "../src/index.js";

const started = (actor = "agent:luna"): Event => ({
  type: "agent.run.started",
  payload: {
    v: 1,
    handle: "luna",
    harness: "claude-code",
    model: "claude-opus-5",
    trigger: { streamId: "chat:maple/general", messageId: "m1" },
    actor,
  },
  ts: 1,
});
const output = (seq: number, lines: string[]): Event => ({
  type: "agent.run.output",
  payload: { v: 1, seq, channel: "stdout", lines, actor: "agent:luna" },
  ts: 2,
});

describe("agent run log", () => {
  it("accepts start → gap-free output → finish and refuses anything else", () => {
    let state = agentRunReducer(agentRunInitialState, started());
    expect(agentRunRefusal(state, started())).toBe("agent-run/already-started");
    expect(agentRunRefusal(agentRunInitialState, started("agent:sol"))).toBe(
      "agent-run/not-the-agent",
    );
    state = agentRunReducer(state, output(0, ['{"type":"system"}', '{"type":"assistant"}']));
    expect(state.lines).toBe(2);
    expect(agentRunRefusal(state, output(5, ["x"]))).toBe("agent-run/sequence-gap");
    state = agentRunReducer(state, {
      type: "agent.run.finished",
      payload: { v: 1, status: "succeeded", summary: "done", actor: "agent:luna" },
      ts: 3,
    });
    expect(state).toMatchObject({ status: "succeeded", summary: "done", lines: 2 });
    expect(agentRunRefusal(state, output(2, ["late"]))).toBe("agent-run/finished");
    expect(
      isAgentRunDispatchPayload("agent.run.output", { v: 1, seq: 0, channel: "stdout", lines: [] }),
    ).toBe(false);
  });

  it("records every line verbatim, in order, splitting partial chunks at newlines", async () => {
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    const port = {
      dispatchAsAgent: (
        _org: string,
        _handle: string,
        _stream: string,
        event: { type: string; payload: unknown },
      ) => {
        sent.push({ type: event.type, payload: event.payload as Record<string, unknown> });
        return Promise.resolve(new Response("{}", { status: 202 }));
      },
    };
    const log = new AgentRunLog(port, "maple", "luna");
    await log.start({
      harness: "claude-code",
      model: "m",
      trigger: { streamId: "s", messageId: "m" },
    });
    log.write("stdout", '{"a":1}\n{"b"');
    log.write("stdout", ':2}\n{"c":3}');
    log.write("stderr", "warn\n");
    await log.finish({ status: "succeeded", summary: "ok" });
    const outputs = sent.filter((event) => event.type === "agent.run.output");
    expect(
      outputs.map((event) => [event.payload.seq, event.payload.channel, event.payload.lines]),
    ).toEqual([
      [0, "stdout", ['{"a":1}', '{"b":2}']],
      [2, "stderr", ["warn"]],
      [3, "stdout", ['{"c":3}']],
    ]);
    expect(sent.at(-1)).toMatchObject({
      type: "agent.run.finished",
      payload: { status: "succeeded" },
    });
    expect(log.streamId).toMatch(/^agent-run:maple\/luna-/);
  });

  it("reads the reply from Claude Code's closing stream-json result event", () => {
    const transcript = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"Added hello"}',
    ].join("\n");
    expect(claudeStreamResult(transcript)).toEqual({
      isError: false,
      subtype: "success",
      result: "Added hello",
    });
    expect(claudeStreamResult("not json")).toBeUndefined();
  });
});

describe("thread ⇄ PR bridge", () => {
  const pr = "pr:maple/docstream-demo/agent-luna-abc";
  function message(
    id: string,
    actor: string,
    body: string,
    offset: string,
    threadOf: string | null = "root",
  ) {
    return {
      id,
      actor,
      body,
      ts: 1,
      offset,
      threadOf,
      revision: 1,
      editedAt: null,
      deleted: false,
    };
  }

  it("mirrors PR comments into the thread and thread replies into the PR, once", async () => {
    const streams = new Map<string, unknown[]>([
      [
        pr,
        [
          { offset: "o0", type: "pr.opened", payload: { title: "t" } },
          {
            offset: "o1",
            type: "pr.review-comment",
            payload: { author: "sol", body: "Looks good @luna" },
          },
        ],
      ],
    ]);
    const posts: { stream: string; type: string; payload: Record<string, unknown> }[] = [];
    const port = {
      readOrgStream: (id: string) => Promise.resolve(streams.get(id) ?? []),
      dispatchAsAgent: (
        _org: string,
        _handle: string,
        stream: string,
        event: { type: string; payload: unknown },
      ) => {
        posts.push({ stream, type: event.type, payload: event.payload as Record<string, unknown> });
        return Promise.resolve(new Response("{}", { status: 202 }));
      },
    };
    const link = message(
      "reply",
      "agent:luna",
      `Opened the PR.\n\n[eforest-pr]: eforest:${pr}`,
      "0002",
    );
    expect(linkedPullRequest(link.body)).toBe(pr);
    const state: ChatChannelState = {
      messages: [
        message("root", "auth0|brett", "$docstream-demo add hello", "0000", null),
        link,
        message("human", "auth0|brett", "also add a title", "0003"),
      ],
    };
    await syncThreadPullRequests(port, {
      org: "maple",
      channel: "general",
      streamId: "chat:maple/general",
      state,
      now: () => 5,
    });
    const toThread = posts.find((post) => post.type === "chat.message.post");
    const toPr = posts.find((post) => post.type === "pr.review-comment");
    expect(toThread).toMatchObject({
      stream: "chat:maple/general",
      payload: { id: prMirrorMessageId(pr, "o1"), threadOf: "root" },
    });
    expect(mirrorSource(toThread!.payload.body as string)).toBe(`${pr}@o1`);
    expect(toPr).toMatchObject({ stream: pr });
    expect(mirrorSource(toPr!.payload.body as string)).toBe("chat/human");

    // Next replay: both mirrors are now in the streams, so nothing is posted again.
    streams.get(pr)!.push({ offset: "o2", type: "pr.review-comment", payload: toPr!.payload });
    posts.length = 0;
    await syncThreadPullRequests(port, {
      org: "maple",
      channel: "general",
      streamId: "chat:maple/general",
      state: {
        messages: [
          ...state.messages,
          message(
            prMirrorMessageId(pr, "o1"),
            "agent:luna",
            toThread!.payload.body as string,
            "0004",
          ),
        ],
      },
      now: () => 6,
    });
    expect(posts).toEqual([]);
  });
});
