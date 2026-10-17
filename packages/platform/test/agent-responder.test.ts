import { emptyView } from "@eforest/identity";
import { DEFAULT_AGENTS } from "@eforest/reducers";
import { describe, expect, it } from "vitest";
import {
  AgentCapabilities,
  AgentResponder,
  agentBranchName,
  referencedCodebases,
  withAgentCapabilities,
  agentReplyId,
  harnessRunner,
  linkedRun,
  classifyDispatchTarget,
  decideStreamAuthorization,
  mentionedHandles,
  type AgentReplyRequest,
  type AgentResponderPort,
  type NamespaceView,
} from "../src/index.js";

const OWNER = "auth0|owner";
const namespace: NamespaceView = {
  orgs: {
    asdf: { owner: OWNER, projects: {}, repos: {} },
    other: { owner: OWNER, projects: {}, repos: {} },
  },
};

function agentDecision(agentOf: string, streamId: string, operation: "read" | "dispatch") {
  return decideStreamAuthorization({
    operation,
    target: classifyDispatchTarget(streamId, "application"),
    principal: { kind: "identified", sub: "agent:luna", session: true, agentOf },
    ...(operation === "dispatch" ? { eventKind: "application" as const } : {}),
    identity: emptyView(),
    identityOffset: "-1",
    namespace,
  });
}

describe("agent authorization basis", () => {
  it("allows an agent to read and post only in its own org's chat channels", () => {
    expect(agentDecision("asdf", "chat:asdf/test", "dispatch")).toMatchObject({
      allowed: true,
      basis: "agent",
    });
    expect(agentDecision("asdf", "chat:asdf/test", "read")).toMatchObject({ allowed: true });
    for (const streamId of ["chat:other/test", "chat:asdf", "members:asdf", "agents:asdf"]) {
      expect(agentDecision("asdf", streamId, "dispatch")).toMatchObject({
        allowed: false,
        refusal: "authz/not-found",
      });
    }
  });

  it("gives an identified principal without agentOf no agent basis", () => {
    const decision = decideStreamAuthorization({
      operation: "dispatch",
      target: classifyDispatchTarget("chat:asdf/test", "application"),
      principal: { kind: "identified", sub: "agent:luna", session: true },
      eventKind: "application",
      identity: emptyView(),
      identityOffset: "-1",
      namespace,
    });
    expect(decision).toMatchObject({ allowed: false, refusal: "authz/not-found" });
  });
});

describe("mention parsing", () => {
  it("finds handles at word boundaries, first-mention order, no duplicates", () => {
    expect(mentionedHandles("@luna hey @sol and @luna again")).toEqual(["luna", "sol"]);
    expect(mentionedHandles("mail me@luna.dev or @@luna")).toEqual([]);
    expect(mentionedHandles("(@terra) ping")).toEqual(["terra"]);
  });

  it("derives a stable, valid chat message id per mention and handle", () => {
    const id = agentReplyId("msg_muczctkv_g4pgdh", "luna");
    expect(id).toBe(agentReplyId("msg_muczctkv_g4pgdh", "luna"));
    expect(id).not.toBe(agentReplyId("msg_muczctkv_g4pgdh", "sol"));
    expect(id).toMatch(/^[A-Za-z0-9._~-]{1,80}$/);
  });

  it("runs claude-code and roster placeholders on Claude Code, codex on Codex", () => {
    expect(harnessRunner("claude-code")).toBe("claude-code");
    expect(harnessRunner("luna")).toBe("claude-code");
    expect(harnessRunner("codex")).toBe("codex");
    expect(harnessRunner("gemini-cli")).toBeUndefined();
  });
});

/** An in-memory stand-in for the gateway: streams are arrays, posts append with the agent actor. */
class FakePort implements AgentResponderPort {
  readonly streams = new Map<string, unknown[]>();
  readonly posts: { org: string; handle: string; streamId: string; payload: unknown }[] = [];
  refuse = false;

  constructor() {
    this.append("ns:root", "ns.org.create", { v: 1, name: "asdf", actor: { sub: OWNER } });
    for (const agent of DEFAULT_AGENTS) {
      const { handle, ...config } = agent;
      this.append("agents:asdf", "agent.register", { v: 1, handle, config, actor: OWNER });
    }
    this.append("chat:asdf", "chat.channel.create", {
      v: 1,
      name: "test",
      topic: "",
      actor: OWNER,
    });
  }

  append(streamId: string, type: string, payload: Record<string, unknown>): void {
    const items = this.streams.get(streamId) ?? [];
    const ordinal = String(items.length).padStart(16, "0");
    items.push({ offset: `0000000000000000_${ordinal}`, type, payload, ts: 1 });
    this.streams.set(streamId, items);
  }

  post(id: string, body: string, actor = OWNER, threadOf?: string): void {
    this.append("chat:asdf/test", "chat.message.post", {
      v: 1,
      id,
      body,
      ...(threadOf === undefined ? {} : { threadOf }),
      actor,
    });
  }

  readOrgStream(streamId: string): Promise<readonly unknown[]> {
    return Promise.resolve(this.streams.get(streamId) ?? []);
  }

  dispatchAsAgent(
    org: string,
    handle: string,
    streamId: string,
    event: { readonly type: string; readonly payload: unknown },
  ): Promise<Response> {
    if (event.type !== "chat.message.post") {
      // Run-log and PR events: record them on their stream like the gateway would.
      this.append(streamId, event.type, {
        ...(event.payload as object),
        actor: `agent:${handle}`,
      });
      return Promise.resolve(new Response("{}", { status: 202 }));
    }
    this.posts.push({ org, handle, streamId, payload: event.payload });
    if (this.refuse) return Promise.resolve(new Response("{}", { status: 404 }));
    this.append(streamId, event.type, { ...(event.payload as object), actor: `agent:${handle}` });
    return Promise.resolve(new Response("{}", { status: 202 }));
  }
}

describe("AgentResponder", () => {
  it("answers a root mention once, in that message's thread", async () => {
    const port = new FakePort();
    const seen: AgentReplyRequest[] = [];
    port.post("m1", "@luna hey");
    const responder = new AgentResponder({
      gateway: port,
      generate: (request) => {
        seen.push(request);
        return Promise.resolve(`hi from ${request.agent.handle}`);
      },
      log: () => {},
    });
    await responder.tick();
    await responder.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.thread.map((message) => message.id)).toEqual(["m1"]);
    expect(port.posts).toHaveLength(1);
    const post = port.posts[0]!;
    expect(post).toMatchObject({
      org: "asdf",
      handle: "luna",
      streamId: "chat:asdf/test",
      payload: { v: 1, id: agentReplyId("m1", "luna"), threadOf: "m1" },
    });
    const body = (post.payload as { body: string }).body;
    expect(body.startsWith("hi from luna\n\n")).toBe(true);
    // Every answer links its complete run log.
    expect(linkedRun(body)).toMatch(/^agent-run:asdf\/luna-/);
  });

  it("replies to a mention inside a thread on the thread root, with the thread as context", async () => {
    const port = new FakePort();
    port.post("root", "planning the release");
    port.post("r1", "what do we think?", OWNER, "root");
    port.post("r2", "@sol can you weigh in?", OWNER, "root");
    const seen: AgentReplyRequest[] = [];
    const responder = new AgentResponder({
      gateway: port,
      generate: (request) => {
        seen.push(request);
        return Promise.resolve("sure");
      },
      log: () => {},
    });
    await responder.tick();
    expect(seen.map((request) => request.thread.map((message) => message.id))).toEqual([
      ["root", "r1", "r2"],
    ]);
    expect(port.posts[0]!.payload).toMatchObject({ threadOf: "root" });
  });

  it("ignores unregistered handles and mentions written by agents", async () => {
    const port = new FakePort();
    port.post("m1", "@nobody hello");
    port.post("m2", "@sol loop?", "agent:luna");
    const responder = new AgentResponder({
      gateway: port,
      generate: () => Promise.resolve("never"),
      log: () => {},
    });
    await responder.tick();
    expect(port.posts).toEqual([]);
  });

  it("posts the failure reason when the model call fails, so the thread is never silent", async () => {
    const port = new FakePort();
    port.post("m1", "@luna hey");
    const responder = new AgentResponder({
      gateway: port,
      generate: () => Promise.reject(new Error("no credentials")),
      log: () => {},
    });
    await responder.tick();
    expect(port.posts[0]!.payload).toMatchObject({ threadOf: "m1" });
    expect((port.posts[0]!.payload as { body: string }).body).toMatch(
      /^⚠️ @luna could not respond: no credentials\n\n\[eforest-run\]: eforest:agent-run:/,
    );
  });

  it("does not re-run the model on every tick after a refused post", async () => {
    const port = new FakePort();
    port.refuse = true;
    port.post("m1", "@luna hey");
    let calls = 0;
    const responder = new AgentResponder({
      gateway: port,
      generate: () => {
        calls += 1;
        return Promise.resolve("hi");
      },
      log: () => {},
    });
    await responder.tick();
    await responder.tick();
    expect(calls).toBe(1);
  });
});

describe("agent codebase runs", () => {
  const repoNamespace: NamespaceView = {
    orgs: {
      maple: {
        owner: OWNER,
        projects: {},
        repos: { "docstream-demo": { owner: OWNER, visibility: "private" } },
      },
      willow: {
        owner: OWNER,
        projects: {},
        repos: { garden: { owner: OWNER, visibility: "private" } },
      },
    },
  } as unknown as NamespaceView;

  function repoDecision(streamId: string, operation: "read" | "dispatch") {
    return decideStreamAuthorization({
      operation,
      target: classifyDispatchTarget(streamId, "application"),
      principal: {
        kind: "identified",
        sub: "agent:luna",
        session: true,
        agentOf: "maple",
        agentBranch: "agent-luna-1234abcd",
      },
      ...(operation === "dispatch" ? { eventKind: "application" as const } : {}),
      identity: emptyView(),
      identityOffset: "-1",
      namespace: repoNamespace,
    });
  }

  it("lets a run read its org's repos and write only its own branch", () => {
    expect(repoDecision("fs:maple/docstream-demo:main:meta", "read")).toMatchObject({
      allowed: true,
      basis: "agent",
    });
    expect(
      repoDecision("fs:maple/docstream-demo:agent-luna-1234abcd:meta", "dispatch"),
    ).toMatchObject({ allowed: true, basis: "agent" });
    expect(
      repoDecision("fs:maple/docstream-demo:agent-luna-1234abcd:file:README.md", "dispatch"),
    ).toMatchObject({ allowed: true });
    expect(repoDecision("fs:maple/docstream-demo:main:meta", "dispatch")).toMatchObject({
      allowed: false,
      refusal: "authz/write-grant-required",
    });
    expect(
      repoDecision("fs:maple/docstream-demo:agent-sol-99999999:meta", "dispatch"),
    ).toMatchObject({ allowed: false });
    expect(repoDecision("fs:willow/garden:main:meta", "read")).toMatchObject({
      allowed: false,
      refusal: "authz/not-found",
    });
  });

  it("finds $codebase chips, mention first, and names branches deterministically", () => {
    expect(
      referencedCodebases(
        ["add hello to $docstream-demo.", "and $willow/garden, costs $5"],
        "maple",
      ),
    ).toEqual([
      { org: "maple", repo: "docstream-demo" },
      { org: "willow", repo: "garden" },
    ]);
    expect(agentBranchName("luna", "msg_1")).toBe(agentBranchName("luna", "msg_1"));
    expect(agentBranchName("luna", "msg_1")).toMatch(/^agent-luna-[0-9a-f]{8}$/);
  });

  it("resolves live capability tokens to the agent principal until revoked", async () => {
    const capabilities = new AgentCapabilities();
    const base = {
      verifyAuthorization: () => Promise.reject(new Error("not a user token")),
    };
    const verifier = withAgentCapabilities(base, capabilities);
    const issued = capabilities.issue({ org: "maple", handle: "luna", branch: "agent-luna-1" });
    const header = `Bearer ${issued.token}`;
    await expect(verifier.verifyAuthorization(header)).resolves.toEqual({ sub: "agent:luna" });
    await expect(verifier.authorizationContext!(header)).resolves.toMatchObject({
      principal: { sub: "agent:luna", agentOf: "maple", agentBranch: "agent-luna-1" },
    });
    issued.revoke();
    await expect(verifier.verifyAuthorization(header)).rejects.toThrow("not a user token");
  });
});
