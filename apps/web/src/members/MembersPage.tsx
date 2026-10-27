import { useState } from "react";
import { Button, Icon, List, ListRow, ListSection, Segmented, cn } from "@brett_lamy/ui";
import {
  AGENT_EFFORTS,
  AGENT_HARNESSES,
  type AgentConfig,
  type AgentEntry,
} from "@eforest/reducers";
import { ChatAvatar } from "../blocks/chat/components/chat-avatar.js";
import { MemberGroup, MemberItem, MemberList } from "../blocks/chat/components/member-list.js";
import { AppSheet } from "../components/overlay.js";
import { Box, ghButton, ghField, ghTextarea } from "../blocks/github/parts.js";
import { agentsDisabled, isPreview } from "../preview.js";
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
  readonly hostedClaude?: boolean;
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
        tools: props.hostedClaude
          ? ["read", "edit"]
          : tools
              .split(",")
              .map((tool) => tool.trim())
              .filter((tool) => tool.length > 0),
        mcpServers: props.hostedClaude ? [] : mcpServers,
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
      className="grid gap-3"
      data-testid="agent-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-[13px] font-semibold">
          <span>Handle</span>
          <input
            className={ghField}
            autoFocus={!editing}
            value={handle}
            disabled={editing}
            onChange={(event) => setHandle(event.currentTarget.value.trim().toLowerCase())}
            placeholder="scout"
            data-testid="agent-handle"
          />
        </label>
        <label className="grid gap-1 text-[13px] font-semibold">
          <span>Display name</span>
          <input
            className={ghField}
            value={config.name}
            onChange={(event) => set("name", event.currentTarget.value)}
            placeholder="Scout"
            data-testid="agent-name"
          />
        </label>
        <label className="grid gap-1 text-[13px] font-semibold">
          <span>Harness</span>
          <select
            className={ghField}
            value={config.harness}
            onChange={(event) => set("harness", event.currentTarget.value)}
          >
            {[
              ...(props.hostedClaude ? ["claude-code"] : AGENT_HARNESSES),
              ...((
                props.hostedClaude
                  ? config.harness === "claude-code"
                  : AGENT_HARNESSES.includes(config.harness as never)
              )
                ? []
                : [config.harness]),
            ].map((harness) => (
              <option key={harness} value={harness}>
                {harness}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[13px] font-semibold">
          <span>Model</span>
          <input
            className={ghField}
            value={config.model}
            onChange={(event) => set("model", event.currentTarget.value)}
            placeholder="claude-sonnet-5"
          />
        </label>
      </div>
      <label className="grid gap-1 text-[13px] font-semibold">
        <span>Effort</span>
        <Segmented
          aria-label="Effort"
          options={AGENT_EFFORTS.map((effort) => ({ id: effort, label: effort }))}
          value={config.effort}
          onChange={(id: string) => set("effort", id as AgentConfig["effort"])}
        />
      </label>
      <label className="grid gap-1 text-[13px] font-semibold">
        <span>System prompt</span>
        <textarea
          className={ghTextarea}
          rows={4}
          value={config.systemPrompt}
          onChange={(event) => set("systemPrompt", event.currentTarget.value)}
          placeholder="Who this agent is and how it should work."
        />
      </label>
      {props.hostedClaude ? (
        <small>
          Hosted Claude uses restricted file tools only; shell, web and MCP tools are unavailable.
        </small>
      ) : (
        <>
          <label className="grid gap-1 text-[13px] font-semibold">
            <span>Tools (comma separated)</span>
            <input
              className={ghField}
              value={tools}
              onChange={(event) => setTools(event.currentTarget.value)}
            />
          </label>
          <label className="grid gap-1 text-[13px] font-semibold">
            <span>MCP servers (one per line: name url)</span>
            <textarea
              className={ghTextarea}
              rows={3}
              value={mcp}
              onChange={(event) => setMcp(event.currentTarget.value)}
              placeholder="replay https://mcp.replay.io"
            />
          </label>
        </>
      )}
      {error === undefined ? null : (
        <p role="alert" className="m-0 text-destructive">
          {error}
        </p>
      )}
      <Button
        className={ghButton((valid && !busy ? "tint" : "soft") === "tint")}
        onPress={() => void submit()}
      >
        {busy ? "Dispatching…" : editing ? "Save agent" : "Register agent"}
      </Button>
      <small className="text-muted-foreground">
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
      className="grid gap-3"
      data-testid="invite-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="grid gap-1 text-[13px] font-semibold">
        <span>Email</span>
        <input
          className={ghField}
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
        <p role="alert" className="m-0 text-destructive">
          {error}
        </p>
      )}
      {result === undefined ? (
        <Button
          className={ghButton((valid && !busy ? "tint" : "soft") === "tint")}
          onPress={() => void submit()}
        >
          {busy ? "Inviting…" : "Send invite"}
        </Button>
      ) : (
        <div className="grid gap-2" data-testid="invite-result">
          <p>
            {result.emailed
              ? `Invitation emailed to ${email.trim().toLowerCase()} through Resend.`
              : "Invitation recorded. Email delivery is not configured here, so share the link yourself:"}
          </p>
          <code className="break-all">{result.link}</code>
          <Button className={ghButton()} onPress={props.onDone}>
            Done
          </Button>
        </div>
      )}
      <small className="text-muted-foreground">
        Appends one `member.invite` event on the workspace member stream
        {props.emailDelivery === "resend" ? " and sends the email through Resend." : "."} The invite
        is bound to the email; membership is granted when that person signs in and accepts.
      </small>
    </form>
  );
}

export function MembersPage(props: { readonly org: string }): React.JSX.Element {
  const preview = isPreview();
  const disabled = agentsDisabled();
  const hostedClaude =
    document.querySelector('meta[name="ef-agents"][content="restricted-claude"]') !== null;
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
      className="grid gap-4"
      data-testid="members-page"
      data-ef-stream={agents.streamId}
      data-ef-offset={agents.checkpoint}
      data-stream-status={agents.status}
    >
      <header className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <p className="m-0 text-muted-foreground">Workspace</p>
          <h1 className="m-0 text-[20px] font-semibold">{props.org} · members</h1>
        </div>
        {!disabled && roster.length === 0 && agents.status !== "loading" ? (
          <Button
            className={ghButton()}
            data-testid="seed-agents"
            onPress={() =>
              void seedDefaultAgents(agents.dispatch, new Set(roster.map((a) => a.handle))).catch(
                (cause: unknown) =>
                  setSeedError(cause instanceof Error ? cause.message : "seed refused"),
              )
            }
          >
            Seed default agents
          </Button>
        ) : null}
        <Button className={ghButton(true)} data-testid="add-member" onPress={() => setSheet("add")}>
          + Add member
        </Button>
      </header>
      {disabled ? (
        <p data-testid={preview ? "preview-agents-off" : "hosted-agents-off"}>
          Agent execution and external integrations are disabled
          {preview ? " in this public preview" : " on this deployment"}. Agent configuration is
          unavailable.
        </p>
      ) : null}
      {seedError === undefined ? null : (
        <p role="alert" className="m-0 text-destructive">
          {seedError}
        </p>
      )}

      <Box
        header={
          <h2 className="m-0 text-[14px] font-semibold">
            Humans{" "}
            <small className="font-normal text-muted-foreground">
              {snapshot === undefined ? "" : String(snapshot.humans.length)}
            </small>
          </h2>
        }
      >
        {humans.status === "loading" ? (
          <p className="m-0 px-4 py-3 text-muted-foreground">Replaying identity…</p>
        ) : null}
        {humans.status.startsWith("error:") ? (
          <p role="alert" className="m-0 px-4 py-3 text-destructive">
            Members could not be listed: {humans.status.slice("error:".length)}
          </p>
        ) : null}
        <MemberList className="h-auto" data-testid="members-humans">
          <MemberGroup label="Members" count={snapshot?.humans.length ?? 0}>
            {(snapshot?.humans ?? []).map((human) => (
              <MemberItem
                key={human.sub}
                data-sub={human.sub}
                user={{
                  name: human.email ?? shortSub(human.sub),
                  c: color(human.sub),
                  role: color(human.sub),
                }}
                status="online"
                badge={human.role}
              >
                {human.email ?? shortSub(human.sub)}
              </MemberItem>
            ))}
          </MemberGroup>
          {pending.length === 0 ? null : (
            <MemberGroup label="Invited · awaiting sign-in" count={pending.length}>
              {pending.map((invite) => (
                <MemberItem
                  key={invite.token}
                  data-testid="members-invite"
                  user={{ name: invite.email, c: "#555b58", role: "#a9adaa" }}
                  status="offline"
                  badge={`${invite.role} · pending`}
                >
                  {invite.email}
                </MemberItem>
              ))}
            </MemberGroup>
          )}
        </MemberList>
      </Box>

      <Box
        header={
          <h2 className="m-0 text-[14px] font-semibold">
            Agents <small className="font-normal text-muted-foreground">{roster.length}</small>
          </h2>
        }
      >
        {agents.status.startsWith("error:") ? (
          <p role="alert" className="m-0 px-4 py-3 text-destructive">
            Agent roster refused: {agents.status.slice("error:".length)}
          </p>
        ) : null}
        {roster.length === 0 && agents.status !== "loading" ? (
          <p className="m-0 px-4 py-3 text-muted-foreground">
            {disabled
              ? "Agent execution is off on this deployment."
              : "No agents yet. Seed the default roster (@sol, @terra, @luna, @fable, @opus, @sonnet, @haiku) or register your own."}
          </p>
        ) : null}
        <ul className="m-0 list-none p-0" data-testid="members-agents">
          {roster.map((agent) => (
            <li
              key={agent.handle}
              data-handle={agent.handle}
              className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3 first:border-t-0"
            >
              <ChatAvatar
                user={{ name: agent.name, c: color(agent.handle), role: "", bot: true }}
                size={32}
                square
              />
              <div className="min-w-0 flex-1">
                <strong>
                  {agent.name}{" "}
                  <code className="font-normal text-muted-foreground">@{agent.handle}</code>
                </strong>
                <div className="text-[12px] text-muted-foreground">
                  {agent.harness} · {agent.model} · effort {agent.effort} ·{" "}
                  {hostedClaude
                    ? "restricted file tools"
                    : `${agent.tools.length} tools · ${agent.mcpServers.length} MCP`}
                </div>
              </div>
              <span className="rounded-full border border-border px-2 text-[12px] text-muted-foreground">
                agent
              </span>
              {canManage && !disabled ? (
                <Button
                  className={ghButton()}
                  data-testid={`edit-agent-${agent.handle}`}
                  onPress={() => {
                    setEditing(agent);
                    setSheet("edit");
                  }}
                >
                  Configure
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </Box>

      <AppSheet open={sheet === "add"} onClose={() => setSheet("none")} title="Add member">
        <div className="grid gap-3">
          <Segmented
            aria-label="Member kind"
            options={[
              { id: "human", label: "Human" },
              ...(disabled ? [] : [{ id: "agent", label: "Agent" }]),
            ]}
            value={kind}
            onChange={(id: string) => setKind(!disabled && id === "agent" ? "agent" : "human")}
          />
          {kind === "human" ? (
            <InviteForm
              onInvite={humans.invite}
              emailDelivery={snapshot?.emailDelivery ?? "unconfigured"}
              onDone={() => setSheet("none")}
            />
          ) : (
            <AgentForm
              hostedClaude={hostedClaude}
              onSubmit={async (handle, config) => {
                await agents.dispatch(registerAgentEvent(handle, config));
              }}
              onDone={() => setSheet("none")}
            />
          )}
        </div>
      </AppSheet>
      <AppSheet
        open={sheet === "edit" && editing !== undefined}
        onClose={() => setSheet("none")}
        title={editing === undefined ? "Configure agent" : `Configure @${editing.handle}`}
      >
        {editing === undefined ? null : (
          <div className="grid gap-3">
            <AgentForm
              initial={editing}
              hostedClaude={hostedClaude}
              onSubmit={async (handle, config) => {
                await agents.dispatch({
                  type: "agent.update",
                  payload: { v: 1, handle, config, expectedRevision: editing.revision },
                  ts: Date.now(),
                });
              }}
              onDone={() => setSheet("none")}
            />
            <List className={cn("overflow-hidden rounded-xl border border-border")}>
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
          </div>
        )}
      </AppSheet>
    </section>
  );
}
