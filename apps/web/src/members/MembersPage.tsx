import { useState } from "react";
import { Icon, List, ListRow, ListSection, PillButton, Segmented } from "@brett_lamy/ui";
import {
  AGENT_EFFORTS,
  AGENT_HARNESSES,
  type AgentConfig,
  type AgentEntry,
} from "@eforest/reducers";
import { ChatAvatar, KFONT } from "../vendor/chatkit/index.js";
import { MobileCredenza } from "../components/mobile/MobileOverlays.js";
import { DesktopTouchKit } from "../components/touchkit/DesktopTouchKit.js";
import {
  registerAgentEvent,
  seedDefaultAgents,
  useAgentRoster,
  useHumanRoster,
} from "./useRoster.js";

const AUTHOR_COLORS = ["#48b979", "#6eafff", "#bf5af2", "#ff9f0a", "#5ac8fa", "#ff6b6b"];

function color(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length]!;
}

function shortSub(sub: string): string {
  return sub.replace(/^auth0\|/, "");
}

const EMPTY_AGENT: AgentConfig = {
  name: "",
  harness: "claude-code",
  model: "claude-sonnet-5",
  effort: "medium",
  systemPrompt: "",
  tools: ["read", "edit", "bash"],
  mcpServers: [],
};

function AgentForm(props: {
  readonly initial?: AgentEntry;
  readonly onSubmit: (handle: string, config: AgentConfig) => Promise<void>;
  readonly onDone: () => void;
}): React.JSX.Element {
  const [handle, setHandle] = useState(props.initial?.handle ?? "");
  const [config, setConfig] = useState<AgentConfig>(
    props.initial === undefined
      ? EMPTY_AGENT
      : {
          name: props.initial.name,
          harness: props.initial.harness,
          model: props.initial.model,
          effort: props.initial.effort,
          systemPrompt: props.initial.systemPrompt,
          tools: props.initial.tools,
          mcpServers: props.initial.mcpServers,
        },
  );
  const [tools, setTools] = useState(config.tools.join(", "));
  const [mcp, setMcp] = useState(
    config.mcpServers.map((server) => `${server.name} ${server.url}`).join("\n"),
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const editing = props.initial !== undefined;
  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]): void =>
    setConfig((current) => ({ ...current, [key]: value }));
  const valid =
    /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(handle) &&
    config.name.trim().length > 0 &&
    config.model.trim().length > 0;
  const submit = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    const mcpServers = mcp
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [name, ...rest] = line.split(/\s+/);
        return { name: name ?? "", url: rest.join(" ") };
      })
      .filter((server) => server.name.length > 0 && server.url.length > 0);
    try {
      await props.onSubmit(handle, {
        ...config,
        name: config.name.trim(),
        model: config.model.trim(),
        tools: tools
          .split(",")
          .map((tool) => tool.trim())
          .filter((tool) => tool.length > 0),
        mcpServers,
      });
      props.onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The dispatch was refused.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="new-repository-form agent-form"
      data-testid="agent-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="agent-form-grid">
        <label>
          <span>Handle</span>
          <input
            autoFocus={!editing}
            value={handle}
            disabled={editing}
            onChange={(event) => setHandle(event.currentTarget.value.trim().toLowerCase())}
            placeholder="scout"
            data-testid="agent-handle"
          />
        </label>
        <label>
          <span>Display name</span>
          <input
            value={config.name}
            onChange={(event) => set("name", event.currentTarget.value)}
            placeholder="Scout"
            data-testid="agent-name"
          />
        </label>
        <label>
          <span>Harness</span>
          <select
            value={config.harness}
            onChange={(event) => set("harness", event.currentTarget.value)}
          >
            {[
              ...AGENT_HARNESSES,
              ...(AGENT_HARNESSES.includes(config.harness as never) ? [] : [config.harness]),
            ].map((harness) => (
              <option key={harness} value={harness}>
                {harness}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Model</span>
          <input
            value={config.model}
            onChange={(event) => set("model", event.currentTarget.value)}
            placeholder="claude-sonnet-5"
          />
        </label>
      </div>
      <label>
        <span>Effort</span>
        <Segmented
          aria-label="Effort"
          options={AGENT_EFFORTS.map((effort) => ({ id: effort, label: effort }))}
          value={config.effort}
          onChange={(id: string) => set("effort", id as AgentConfig["effort"])}
        />
      </label>
      <label>
        <span>System prompt</span>
        <textarea
          rows={4}
          value={config.systemPrompt}
          onChange={(event) => set("systemPrompt", event.currentTarget.value)}
          placeholder="Who this agent is and how it should work."
        />
      </label>
      <label>
        <span>Tools (comma separated)</span>
        <input value={tools} onChange={(event) => setTools(event.currentTarget.value)} />
      </label>
      <label>
        <span>MCP servers (one per line: name url)</span>
        <textarea
          rows={3}
          value={mcp}
          onChange={(event) => setMcp(event.currentTarget.value)}
          placeholder="replay https://mcp.replay.io"
        />
      </label>
      {error === undefined ? null : (
        <p role="alert" className="new-repository-error">
          {error}
        </p>
      )}
      <PillButton
        label={busy ? "Dispatching…" : editing ? "Save agent" : "Register agent"}
        tone={valid && !busy ? "tint" : "soft"}
        onPress={() => void submit()}
      />
      <small>
        {editing ? "Appends one `agent.update` event" : "Appends one `agent.register` event"} to the
        workspace agent stream.
      </small>
    </form>
  );
}

function InviteForm(props: {
  readonly onInvite: (
    email: string,
    role: "admin" | "member",
  ) => Promise<{ link: string; emailed: boolean }>;
  readonly emailDelivery: "resend" | "unconfigured";
  readonly onDone: () => void;
}): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<{ link: string; emailed: boolean } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const submit = async (): Promise<void> => {
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult(await props.onInvite(email.trim().toLowerCase(), role));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The invite was refused.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="new-repository-form"
      data-testid="invite-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        <span>Email</span>
        <input
          autoFocus
          type="email"
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
          placeholder="grace@example.test"
          data-testid="invite-email"
        />
      </label>
      <Segmented
        aria-label="Role"
        options={[
          { id: "member", label: "Member" },
          { id: "admin", label: "Admin" },
        ]}
        value={role}
        onChange={(id: string) => setRole(id === "admin" ? "admin" : "member")}
      />
      {error === undefined ? null : (
        <p role="alert" className="new-repository-error">
          {error}
        </p>
      )}
      {result === undefined ? (
        <PillButton
          label={busy ? "Inviting…" : "Send invite"}
          tone={valid && !busy ? "tint" : "soft"}
          onPress={() => void submit()}
        />
      ) : (
        <div className="invite-result" data-testid="invite-result">
          <p>
            {result.emailed
              ? `Invitation emailed to ${email.trim().toLowerCase()} through Resend.`
              : "Invitation recorded. Email delivery is not configured here, so share the link yourself:"}
          </p>
          <code>{result.link}</code>
          <PillButton label="Done" tone="soft" onPress={props.onDone} />
        </div>
      )}
      <small>
        Appends one `member.invite` event on the workspace member stream
        {props.emailDelivery === "resend" ? " and sends the email through Resend." : "."} The invite
        is bound to the email; membership is granted when that person signs in and accepts.
      </small>
    </form>
  );
}

export function MembersPage(props: { readonly org: string }): React.JSX.Element {
  const humans = useHumanRoster(props.org);
  const agents = useAgentRoster(props.org);
  const [sheet, setSheet] = useState<"none" | "add" | "edit">("none");
  const [kind, setKind] = useState<"human" | "agent">("human");
  const [editing, setEditing] = useState<AgentEntry | undefined>(undefined);
  const [seedError, setSeedError] = useState<string | undefined>(undefined);
  const roster = Object.values(agents.state.agents)
    .filter((agent) => !agent.removed)
    .sort((a, b) => a.handle.localeCompare(b.handle));
  const snapshot = humans.snapshot;
  const canManage =
    snapshot !== undefined && (snapshot.me.role === "owner" || snapshot.me.role === "admin");
  const pending = snapshot?.invites.filter((invite) => invite.status === "pending") ?? [];
  return (
    <section
      className="members-page"
      data-testid="members-page"
      data-ef-stream={agents.streamId}
      data-ef-offset={agents.checkpoint}
      data-stream-status={agents.status}
      style={{ fontFamily: KFONT }}
    >
      <header className="members-head">
        <div>
          <p className="site-kicker">Workspace</p>
          <h2>{props.org} · members</h2>
        </div>
        <div className="members-actions">
          {roster.length === 0 && agents.status !== "loading" ? (
            <button
              type="button"
              className="chat-edit-cancel members-button"
              data-testid="seed-agents"
              onClick={() =>
                void seedDefaultAgents(agents.dispatch, new Set(roster.map((a) => a.handle))).catch(
                  (cause: unknown) =>
                    setSeedError(cause instanceof Error ? cause.message : "seed refused"),
                )
              }
            >
              Seed default agents
            </button>
          ) : null}
          <button
            type="button"
            className="chat-edit-save members-button"
            data-testid="add-member"
            onClick={() => setSheet("add")}
          >
            + Add member
          </button>
        </div>
      </header>
      {seedError === undefined ? null : (
        <p role="alert" className="new-repository-error">
          {seedError}
        </p>
      )}

      <h3 className="members-section-title">
        Humans <small>{snapshot === undefined ? "" : String(snapshot.humans.length)}</small>
      </h3>
      {humans.status === "loading" ? (
        <p className="chat-channel-empty">Replaying identity…</p>
      ) : null}
      {humans.status.startsWith("error:") ? (
        <p role="alert" className="projection-refusal">
          Members could not be listed: {humans.status.slice("error:".length)}
        </p>
      ) : null}
      <ul className="members-list" data-testid="members-humans">
        {(snapshot?.humans ?? []).map((human) => (
          <li key={human.sub} className="members-row" data-sub={human.sub}>
            <ChatAvatar
              user={{ name: human.email ?? shortSub(human.sub), c: color(human.sub), role: "" }}
              size={32}
            />
            <div>
              <strong>{human.email ?? shortSub(human.sub)}</strong>
              <small>{shortSub(human.sub)}</small>
            </div>
            <span className={`members-role members-role-${human.role}`}>{human.role}</span>
          </li>
        ))}
        {pending.map((invite) => (
          <li
            key={invite.token}
            className="members-row members-row-pending"
            data-testid="members-invite"
          >
            <ChatAvatar user={{ name: invite.email, c: "#555b58", role: "" }} size={32} />
            <div>
              <strong>{invite.email}</strong>
              <small>invited · awaiting sign-in</small>
            </div>
            <span className="members-role members-role-pending">{invite.role} · pending</span>
          </li>
        ))}
      </ul>

      <h3 className="members-section-title">
        Agents <small>{roster.length}</small>
      </h3>
      {agents.status.startsWith("error:") ? (
        <p role="alert" className="projection-refusal">
          Agent roster refused: {agents.status.slice("error:".length)}
        </p>
      ) : null}
      {roster.length === 0 && agents.status !== "loading" ? (
        <p className="chat-channel-empty">
          No agents yet. Seed the default roster (@sol, @terra, @luna, @fable, @opus, @sonnet,
          @haiku) or register your own.
        </p>
      ) : null}
      <ul className="members-list agents-list" data-testid="members-agents">
        {roster.map((agent) => (
          <li key={agent.handle} className="members-row agent-row" data-handle={agent.handle}>
            <ChatAvatar
              user={{ name: agent.name, c: color(agent.handle), role: "", bot: true }}
              size={32}
              square
            />
            <div>
              <strong>
                {agent.name} <code>@{agent.handle}</code>
              </strong>
              <small>
                {agent.harness} · {agent.model} · effort {agent.effort} · {agent.tools.length} tools
                · {agent.mcpServers.length} MCP
              </small>
            </div>
            <span className="members-role members-role-agent">agent</span>
            {canManage ? (
              <button
                type="button"
                className="chat-edit-cancel members-button"
                data-testid={`edit-agent-${agent.handle}`}
                onClick={() => {
                  setEditing(agent);
                  setSheet("edit");
                }}
              >
                Configure
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      <DesktopTouchKit>
        <MobileCredenza
          open={sheet === "add"}
          onClose={() => setSheet("none")}
          label="Add member"
          compact
        >
          <div className="new-repository-form">
            <Segmented
              aria-label="Member kind"
              options={[
                { id: "human", label: "Human" },
                { id: "agent", label: "Agent" },
              ]}
              value={kind}
              onChange={(id: string) => setKind(id === "agent" ? "agent" : "human")}
            />
          </div>
          {sheet !== "add" ? null : kind === "human" ? (
            <InviteForm
              onInvite={humans.invite}
              emailDelivery={snapshot?.emailDelivery ?? "unconfigured"}
              onDone={() => setSheet("none")}
            />
          ) : (
            <AgentForm
              onSubmit={async (handle, config) => {
                await agents.dispatch(registerAgentEvent(handle, config));
              }}
              onDone={() => setSheet("none")}
            />
          )}
        </MobileCredenza>
        <MobileCredenza
          open={sheet === "edit"}
          onClose={() => setSheet("none")}
          label={editing === undefined ? "Configure agent" : `Configure @${editing.handle}`}
          compact
        >
          {sheet === "edit" && editing !== undefined ? (
            <>
              <AgentForm
                initial={editing}
                onSubmit={async (handle, config) => {
                  await agents.dispatch({
                    type: "agent.update",
                    payload: { v: 1, handle, config, expectedRevision: editing.revision },
                    ts: Date.now(),
                  });
                }}
                onDone={() => setSheet("none")}
              />
              <List inset>
                <ListSection title="Danger">
                  <ListRow
                    title={`Remove @${editing.handle}`}
                    leading={<Icon name="trash" />}
                    destructive
                    onPress={() =>
                      void agents
                        .dispatch({
                          type: "agent.remove",
                          payload: {
                            v: 1,
                            handle: editing.handle,
                            expectedRevision: editing.revision,
                          },
                          ts: Date.now(),
                        })
                        .then(() => setSheet("none"))
                    }
                  />
                </ListSection>
              </List>
            </>
          ) : null}
        </MobileCredenza>
      </DesktopTouchKit>
    </section>
  );
}
