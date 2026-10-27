import { emptyView } from "@eforest/identity";
import { DEFAULT_AGENTS } from "@eforest/reducers";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { restrictedClaudeProcess } from "../src/agents/harness.js";
import {
  AgentCapabilities,
  AgentResponder,
  agentBranchName,
  referencedCodebases,
  withAgentCapabilities,
  withAgentWorkspace,
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
  it("runs hosted Claude with restricted file tools and no inherited app credentials", () => {
    const token = `synthetic-${"x".repeat(40)}`;
    const child = restrictedClaudeProcess(token, "/tmp/isolated-claude");
    expect(child.command).toBe("/usr/local/bin/claude");
    expect(child.args).toContain("--restricted");
    expect(child.args).toContain("--safe-mode");
    expect(child.args).toContain("--strict-mcp-config");
    expect(child.args).toContain("mcp__*");
    expect(child.args).toContain("none");
    expect(child.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(child.env.CLAUDE_CONFIG_DIR).toBe("/tmp/isolated-claude/.claude");
    expect(Object.keys(child.env).sort()).toEqual(
      [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CONFIG_DIR",
        "DISABLE_AUTOUPDATER",
        "HOME",
        "NO_COLOR",
        "PATH",
        "TMPDIR",
        "XDG_CONFIG_HOME",
      ].sort(),
    );
    expect(JSON.stringify(child.args)).not.toContain(token);
  });
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
      serverReceivedAt: 2,
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
  it("aborts an active run and drains without posting a shutdown reply", async () => {
    const port = new FakePort();
    port.post("active", "@sol wait for shutdown");
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const responder = new AgentResponder({
      gateway: port,
      generate: (request) =>
        new Promise<string>((resolve) => {
          request.signal?.addEventListener("abort", () => resolve("too late"), { once: true });
          started();
        }),
      pollMs: 10,
      log: () => {},
    });
    responder.start();
    await running;
    responder.stop();
    expect(await responder.drain(1_000)).toBe(true);
    expect(port.posts).toEqual([]);
  });

  it("does not answer pre-registration or legacy mentions with forged future timestamps", async () => {
    const port = new FakePort();
    port.post("historical", "@sol from before registration");
    const channel = port.streams.get("chat:asdf/test")!;
    channel[0] = {
      ...(channel[0] as object),
      ts: Number.MAX_SAFE_INTEGER,
      payload: {
        ...(channel[0] as { payload: Record<string, unknown> }).payload,
        serverReceivedAt: 0,
      },
    };
    port.post("legacy", "@sol legacy future timestamp");
    const legacy = channel[1] as { payload: Record<string, unknown> };
    const { serverReceivedAt: _serverReceivedAt, ...oldPayload } = legacy.payload;
    channel[1] = { ...legacy, ts: Number.MAX_SAFE_INTEGER, payload: oldPayload };
    port.post("fresh", "@sol after registration");
    const seen: string[] = [];
    const responder = new AgentResponder({
      gateway: port,
      generate: (request) => {
        seen.push(request.mention.id);
        return Promise.resolve("ready");
      },
      log: () => {},
    });
    await responder.tick();
    expect(seen).toEqual(["fresh"]);
  });

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
  it("stops and flushes the watcher after a run is aborted", async () => {
    const workshop = resolve(
      ".eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work",
    );
    await mkdir(workshop, { recursive: true });
    const fixture = await mkdtemp(resolve(workshop, "agent-cleanup-"));
    const logPath = resolve(fixture, "cli.log");
    const cliBin = resolve(fixture, "cli.mjs");
    await writeFile(
      cliBin,
      `import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, args.join(" ") + "\\n");
if (args[0] === "clone") {
  mkdirSync(resolve(args[3], ".ef"), { recursive: true });
}
if (args[0] === "watch" && args[1] === "start") {
  await new Promise((done) => setTimeout(done, 250));
}
`,
    );
    const capabilities = new AgentCapabilities();
    const abort = new AbortController();
    try {
      await expect(
        withAgentWorkspace(
          {
            capabilities,
            platformUrl: () => "http://127.0.0.1:9999",
            streamUrl: "http://127.0.0.1:9998",
            cliBin,
          },
          {
            codebase: { org: "maple", repo: "notes" },
            handle: "luna",
            branch: "agent-luna-1234abcd",
          },
          async ({ dir }) => {
            await writeFile(resolve(dir, "README.md"), "saved before shutdown\n");
            abort.abort();
            throw new Error("run stopped");
          },
          abort.signal,
        ),
      ).rejects.toThrow("run stopped");
      const commands = await readFile(logPath, "utf8");
      expect(commands).toContain("watch start --dir");
      expect(commands).toContain("watch stop --dir");
      expect(commands).toContain("watch --up --quiesce");
      const startupAbort = new AbortController();
      let workRan = false;
      const startup = withAgentWorkspace(
        {
          capabilities,
          platformUrl: () => "http://127.0.0.1:9999",
          streamUrl: "http://127.0.0.1:9998",
          cliBin,
        },
        {
          codebase: { org: "maple", repo: "notes" },
          handle: "luna",
          branch: "agent-luna-1234abcd",
        },
        () => {
          workRan = true;
          return Promise.resolve();
        },
        startupAbort.signal,
      );
      const deadline = Date.now() + 5_000;
      while (!(await readFile(logPath, "utf8")).slice(commands.length).includes("watch start")) {
        if (Date.now() > deadline) throw new Error("watch start was not attempted");
        await new Promise((done) => setTimeout(done, 10));
      }
      startupAbort.abort();
      await expect(startup).rejects.toThrow("agent run aborted before workspace became ready");
      expect(workRan).toBe(false);
      const startupCommands = (await readFile(logPath, "utf8")).slice(commands.length);
      expect(startupCommands).toContain("watch stop --dir");
      expect(startupCommands).toContain("watch --up --quiesce");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  const repoNamespace: NamespaceView = {
    orgs: {
      maple: {
        owner: OWNER,
        projects: {},
        repos: {
          "docstream-demo": { owner: OWNER, visibility: "private" },
          ledger: { owner: OWNER, visibility: "private" },
        },
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
        agentRepo: "docstream-demo",
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
    expect(repoDecision("fs:maple/ledger:main:meta", "read")).toMatchObject({
      allowed: false,
      refusal: "authz/not-found",
    });
    expect(repoDecision("fs:maple/ledger:agent-luna-1234abcd:meta", "dispatch")).toMatchObject({
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
    const issued = capabilities.issue({
      org: "maple",
      repo: "docstream-demo",
      handle: "luna",
      branch: "agent-luna-1",
    });
    const header = `Bearer ${issued.token}`;
    await expect(verifier.verifyAuthorization(header)).resolves.toEqual({ sub: "agent:luna" });
    await expect(verifier.authorizationContext!(header)).resolves.toMatchObject({
      principal: {
        sub: "agent:luna",
        agentOf: "maple",
        agentRepo: "docstream-demo",
        agentBranch: "agent-luna-1",
      },
    });
    issued.revoke();
    await expect(verifier.verifyAuthorization(header)).rejects.toThrow("not a user token");
  });
});
