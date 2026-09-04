import { stateDigest, type Event } from "@eforest/protocol";

/**
 * Agent roster for a workspace (`agents:<org>`). An agent is a member that is a program:
 * a handle people @mention, plus the configuration a runner needs to boot it — harness,
 * model, effort, system prompt, tools, MCP servers. Registering an agent here is the
 * whole of what the platform knows; running one is the agent-run protocol (E6-T07).
 */
export const AGENTS_EVENT_VERSION = 1 as const;
export const AGENTS_REDUCER = "agent-registry" as const;
export const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];
export const AGENT_HARNESSES = [
  "claude-code",
  "codex",
  "gemini-cli",
  "opencode",
  "custom",
] as const;
export const AGENT_PROMPT_MAX_CODE_UNITS = 32 * 1024;

const ORG_PATTERN = "[a-z0-9](?:-?[a-z0-9])*";
const AGENTS_RE = new RegExp(`^agents:(${ORG_PATTERN})$`);
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const NAME_RE = /^\S(?:.{0,78}\S)?$/;

export type AgentsActionType = "agent.register" | "agent.update" | "agent.remove";

export function isAgentsActionType(type: string): type is AgentsActionType {
  return type === "agent.register" || type === "agent.update" || type === "agent.remove";
}

export function agentsStreamId(org: string): string {
  return `agents:${org}`;
}

export function isAgentsStreamId(streamId: string): boolean {
  return AGENTS_RE.test(streamId);
}

export function parseAgentsStreamId(streamId: string): string | undefined {
  return AGENTS_RE.exec(streamId)?.[1];
}

export function isAgentHandle(value: string): boolean {
  return HANDLE_RE.test(value);
}

export interface AgentMcpServer {
  readonly name: string;
  readonly url: string;
}

export interface AgentConfig {
  readonly name: string;
  readonly harness: string;
  readonly model: string;
  readonly effort: AgentEffort;
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  readonly mcpServers: readonly AgentMcpServer[];
}

export interface AgentEntry extends AgentConfig {
  readonly handle: string;
  readonly registeredBy: string;
  readonly registeredAt: number;
  readonly revision: number;
  readonly removed: boolean;
}

export interface AgentsState {
  readonly agents: Readonly<Record<string, AgentEntry>>;
}

export const agentsInitialState: AgentsState = Object.freeze({ agents: Object.freeze({}) });

/** The roster every workspace starts with; seeded through the ordinary dispatch door. */
export const DEFAULT_AGENTS: readonly (AgentConfig & { readonly handle: string })[] = [
  {
    handle: "sol",
    name: "Sol",
    harness: "sol",
    model: "sol",
    effort: "medium",
    systemPrompt:
      "You are Sol, a workspace agent. Work on the branch you are given and report evidence.",
    tools: ["read", "edit", "bash", "web-search"],
    mcpServers: [],
  },
  {
    handle: "terra",
    name: "Terra",
    harness: "terra",
    model: "terra",
    effort: "medium",
    systemPrompt:
      "You are Terra, a workspace agent. Work on the branch you are given and report evidence.",
    tools: ["read", "edit", "bash", "web-search"],
    mcpServers: [],
  },
  {
    handle: "luna",
    name: "Luna",
    harness: "luna",
    model: "luna",
    effort: "max",
    systemPrompt:
      "You are Luna, a workspace agent. Work on the branch you are given and report evidence.",
    tools: ["read", "edit", "bash", "web-search"],
    mcpServers: [],
  },
  {
    handle: "fable",
    name: "Fable",
    harness: "claude-code",
    model: "claude-fable-5",
    effort: "medium",
    systemPrompt:
      "You are Fable, a workspace agent running in Claude Code. Work on the branch you are given and report evidence.",
    tools: ["read", "edit", "bash", "web-search"],
    mcpServers: [],
  },
  {
    handle: "opus",
    name: "Opus",
    harness: "claude-code",
    model: "claude-opus-5",
    effort: "high",
    systemPrompt:
      "You are Opus, a workspace agent running in Claude Code. Work on the branch you are given and report evidence.",
    tools: ["read", "edit", "bash", "web-search"],
    mcpServers: [],
  },
  {
    handle: "sonnet",
    name: "Sonnet",
    harness: "claude-code",
    model: "claude-sonnet-5",
    effort: "xhigh",
    systemPrompt:
      "You are Sonnet, a workspace agent running in Claude Code. Work on the branch you are given and report evidence.",
    tools: ["read", "edit", "bash", "web-search"],
    mcpServers: [],
  },
  {
    handle: "haiku",
    name: "Haiku",
    harness: "claude-code",
    model: "claude-haiku-4-5-20251001",
    effort: "medium",
    systemPrompt:
      "You are Haiku, a workspace agent running in Claude Code. Work on the branch you are given and report evidence.",
    tools: ["read", "edit", "bash"],
    mcpServers: [],
  },
];

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isAgentConfig(value: unknown): value is AgentConfig {
  if (
    !exactObject(value, [
      "name",
      "harness",
      "model",
      "effort",
      "systemPrompt",
      "tools",
      "mcpServers",
    ])
  ) {
    return false;
  }
  return (
    typeof value.name === "string" &&
    NAME_RE.test(value.name) &&
    shortString(value.harness, 40) &&
    /^[a-z0-9][a-z0-9-]*$/.test(value.harness) &&
    shortString(value.model, 80) &&
    AGENT_EFFORTS.includes(value.effort as AgentEffort) &&
    typeof value.systemPrompt === "string" &&
    value.systemPrompt.length <= AGENT_PROMPT_MAX_CODE_UNITS &&
    Array.isArray(value.tools) &&
    value.tools.length <= 64 &&
    value.tools.every((tool) => shortString(tool, 64)) &&
    Array.isArray(value.mcpServers) &&
    value.mcpServers.length <= 32 &&
    value.mcpServers.every(
      (server) =>
        exactObject(server, ["name", "url"]) &&
        shortString(server.name, 64) &&
        shortString(server.url, 512),
    )
  );
}

/** Client-authored payload shape (before the gateway stamps `actor`). */
export function isAgentsDispatchPayload(type: string, payload: unknown): boolean {
  if (type === "agent.register") {
    if (!exactObject(payload, ["v", "handle", "config"])) return false;
    return (
      payload.v === AGENTS_EVENT_VERSION &&
      typeof payload.handle === "string" &&
      isAgentHandle(payload.handle) &&
      isAgentConfig(payload.config)
    );
  }
  if (type === "agent.update") {
    if (!exactObject(payload, ["v", "handle", "config", "expectedRevision"])) return false;
    return (
      payload.v === AGENTS_EVENT_VERSION &&
      typeof payload.handle === "string" &&
      isAgentHandle(payload.handle) &&
      isAgentConfig(payload.config) &&
      Number.isSafeInteger(payload.expectedRevision) &&
      (payload.expectedRevision as number) >= 1
    );
  }
  if (type === "agent.remove") {
    if (!exactObject(payload, ["v", "handle", "expectedRevision"])) return false;
    return (
      payload.v === AGENTS_EVENT_VERSION &&
      typeof payload.handle === "string" &&
      isAgentHandle(payload.handle) &&
      Number.isSafeInteger(payload.expectedRevision) &&
      (payload.expectedRevision as number) >= 1
    );
  }
  return false;
}

export function isAgentsEvent(event: Event): boolean {
  if (!isAgentsActionType(event.type)) return false;
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return false;
  }
  const { actor, ...rest } = Object.fromEntries(
    Object.entries(event.payload as Record<string, unknown>).filter(([key]) => key !== "writer"),
  );
  return typeof actor === "string" && actor.length > 0 && isAgentsDispatchPayload(event.type, rest);
}

export function agentsReducer(state: AgentsState, event: Event): AgentsState {
  if (!isAgentsEvent(event)) return state;
  const payload = event.payload as {
    actor: string;
    handle: string;
    config?: AgentConfig;
    expectedRevision?: number;
  };
  const existing = state.agents[payload.handle];
  if (event.type === "agent.register") {
    if (existing !== undefined && !existing.removed) return state;
    return {
      agents: {
        ...state.agents,
        [payload.handle]: {
          ...payload.config!,
          handle: payload.handle,
          registeredBy: payload.actor,
          registeredAt: event.ts,
          revision: existing === undefined ? 1 : existing.revision + 1,
          removed: false,
        },
      },
    };
  }
  if (
    existing === undefined ||
    existing.removed ||
    existing.revision !== payload.expectedRevision
  ) {
    return state;
  }
  const next: AgentEntry =
    event.type === "agent.update"
      ? { ...existing, ...payload.config!, revision: existing.revision + 1 }
      : { ...existing, revision: existing.revision + 1, removed: true };
  return { agents: { ...state.agents, [payload.handle]: next } };
}

export const agentsReducerDefinition = Object.freeze({
  id: AGENTS_REDUCER,
  version: AGENTS_EVENT_VERSION,
  initialState: agentsInitialState,
  reduce: agentsReducer as (state: unknown, event: Event) => unknown,
  digest: stateDigest,
  matchesStream: isAgentsStreamId,
});
