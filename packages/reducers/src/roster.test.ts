import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS,
  agentsInitialState,
  agentsReducer,
  isAgentsDispatchPayload,
  isMembersDispatchPayload,
  membersInitialState,
  membersReducer,
  requireReducer,
} from "./index.js";

const ts = 1_780_000_000_000;

describe("org roster streams", () => {
  it("resolves reducers only for well-formed org stream ids", () => {
    expect(requireReducer("org-members", "members:maple").id).toBe("org-members");
    expect(requireReducer("agent-registry", "agents:maple").id).toBe("agent-registry");
    expect(() => requireReducer("org-members", "members:Maple")).toThrow();
    expect(() => requireReducer("agent-registry", "agents:maple/x")).toThrow();
  });

  it("tracks invitations from pending to accepted or revoked, once", () => {
    const token = "tok_0123456789abcdef";
    const state = membersReducer(membersInitialState, {
      type: "member.invite",
      payload: { v: 1, email: "grace@example.test", role: "member", token, actor: "auth0|ada" },
      ts,
    });
    expect(state.invites[token]).toMatchObject({ status: "pending", invitedBy: "auth0|ada" });
    const accepted = membersReducer(state, {
      type: "member.invite.accepted",
      payload: { v: 1, token, sub: "auth0|grace", actor: "auth0|grace" },
      ts: ts + 1,
    });
    expect(accepted.invites[token]).toMatchObject({ status: "accepted", sub: "auth0|grace" });
    // A resolved invite is final.
    expect(
      membersReducer(accepted, {
        type: "member.invite.revoke",
        payload: { v: 1, token, actor: "auth0|ada" },
        ts: ts + 2,
      }),
    ).toBe(accepted);
    expect(
      isMembersDispatchPayload("member.invite", {
        v: 1,
        email: "Grace@Example.test",
        role: "member",
        token,
      }),
    ).toBe(false);
    expect(
      isMembersDispatchPayload("member.invite", {
        v: 1,
        email: "grace@example.test",
        role: "owner",
        token,
      }),
    ).toBe(false);
  });

  it("registers the default roster and guards updates by revision", () => {
    let state = agentsInitialState;
    for (const { handle, ...config } of DEFAULT_AGENTS) {
      const payload = { v: 1, handle, config };
      expect(isAgentsDispatchPayload("agent.register", payload)).toBe(true);
      state = agentsReducer(state, {
        type: "agent.register",
        payload: { ...payload, actor: "auth0|ada" },
        ts,
      });
    }
    expect(Object.keys(state.agents).sort()).toEqual([
      "fable",
      "haiku",
      "luna",
      "opus",
      "sol",
      "sonnet",
      "terra",
    ]);
    expect(state.agents["luna"]).toMatchObject({ effort: "max", revision: 1 });
    expect(state.agents["sonnet"]).toMatchObject({ effort: "xhigh", harness: "claude-code" });
    const opus = state.agents["opus"]!;
    const agentConfig = {
      name: opus.name,
      harness: opus.harness,
      model: opus.model,
      effort: "max" as const,
      systemPrompt: opus.systemPrompt,
      tools: opus.tools,
      mcpServers: opus.mcpServers,
    };
    const stale = agentsReducer(state, {
      type: "agent.update",
      payload: {
        v: 1,
        handle: "opus",
        config: agentConfig,
        expectedRevision: 2,
        actor: "auth0|ada",
      },
      ts,
    });
    expect(stale).toBe(state);
    const updated = agentsReducer(state, {
      type: "agent.update",
      payload: {
        v: 1,
        handle: "opus",
        config: agentConfig,
        expectedRevision: 1,
        actor: "auth0|ada",
      },
      ts,
    });
    expect(updated.agents["opus"]).toMatchObject({ effort: "max", revision: 2 });
    const removed = agentsReducer(updated, {
      type: "agent.remove",
      payload: { v: 1, handle: "opus", expectedRevision: 2, actor: "auth0|ada" },
      ts,
    });
    expect(removed.agents["opus"]).toMatchObject({ removed: true, revision: 3 });
    expect(
      isAgentsDispatchPayload("agent.register", {
        v: 1,
        handle: "Bad Handle",
        config: agentConfig,
      }),
    ).toBe(false);
  });
});
