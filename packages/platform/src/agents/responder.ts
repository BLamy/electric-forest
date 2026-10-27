import { createHash } from "node:crypto";
import type { Event } from "@eforest/protocol";
import {
  agentsInitialState,
  agentsReducer,
  agentsStreamId,
  chatCatalogStreamId,
  chatChannelInitialState,
  chatChannelReducer,
  chatChannelStreamId,
  CHAT_BODY_MAX_CODE_UNITS,
  type AgentEntry,
  type ChatMessage,
} from "@eforest/reducers";
import { chatEventWithoutWriter, reduceChatCatalog } from "../chat/validators.js";
import {
  ensureAgentPullRequest,
  markers,
  mirrorSource,
  pullRequestTitle,
} from "./pull-requests.js";
import { isPrMirrorMessage, syncThreadPullRequests, withoutMarkers } from "./bridge.js";
import { AgentRunLog } from "./run-log.js";

/**
 * Stopgap agent runtime (ahead of E6-T07): answers @mentions of registered workspace
 * agents in chat threads. It holds no state of its own — every tick replays the
 * namespace, roster, catalog, and channel streams, and a mention is "answered" exactly
 * when the channel already contains the agent's deterministic reply id. Replies go
 * through the gateway's dispatch door as `agent:<handle>`, never as a side-channel write.
 */

export interface AgentReplyRequest {
  readonly org: string;
  readonly channel: string;
  /** The chat channel stream the mention was posted on. */
  readonly streamId: string;
  readonly agent: AgentEntry;
  /** The thread (root first) up to and including the mentioning message. */
  readonly thread: readonly ChatMessage[];
  readonly mention: ChatMessage;
  readonly signal?: AbortSignal;
  /**
   * Post an interim reply in the thread (e.g. "working on branch …") before the final
   * answer. Idempotent per mention: a repeat announcement is refused as a duplicate.
   */
  readonly announce?: (body: string) => Promise<void>;
  /** The run's durable log: the generator starts it and streams harness output into it. */
  readonly runLog?: AgentRunLog;
}

export interface AgentReplyResult {
  readonly body: string;
  /** Present when the run edited a codebase on an agent branch. */
  readonly workspace?: { readonly org: string; readonly repo: string; readonly branch: string };
}

export type AgentReplyGenerator = (
  request: AgentReplyRequest,
) => Promise<string | AgentReplyResult>;

export interface AgentResponderPort {
  readOrgStream(streamId: string): Promise<readonly unknown[]>;
  dispatchAsAgent(
    org: string,
    handle: string,
    streamId: string,
    event: { readonly type: string; readonly payload: unknown; readonly ts: number },
    scope?: { readonly pullRequest?: string },
  ): Promise<Response>;
}

export interface AgentResponderOptions {
  readonly gateway: AgentResponderPort;
  readonly generate: AgentReplyGenerator;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly maxConcurrent?: number;
  readonly log?: (line: string) => void;
}

const MENTION_RE = /(?:^|[^A-Za-z0-9_@.-])@([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)(?![A-Za-z0-9-])/g;

/** Handles mentioned in a body, in first-mention order, without duplicates. */
export function mentionedHandles(body: string): readonly string[] {
  const handles: string[] = [];
  for (const match of body.matchAll(MENTION_RE)) {
    const handle = match[1]!;
    if (!handles.includes(handle)) handles.push(handle);
  }
  return handles;
}

/** The reply id is a pure function of the mention, so replay decides "already answered". */
export function agentReplyId(mentionId: string, handle: string): string {
  const digest = createHash("sha256").update(`${mentionId}\0${handle}`).digest("hex").slice(0, 20);
  return `agent-${handle}-${digest}`.slice(0, 80);
}

/** The interim status reply's id: distinct from the final answer, still deterministic. */
export function agentStatusReplyId(mentionId: string, handle: string): string {
  const digest = createHash("sha256")
    .update(`${mentionId}\0${handle}\0status`)
    .digest("hex")
    .slice(0, 20);
  return `agent-${handle}-status-${digest}`.slice(0, 80);
}

function records(items: readonly unknown[]): Event[] {
  return items.map(chatEventWithoutWriter);
}

function orgsFromNamespace(items: readonly unknown[]): readonly string[] {
  const orgs = new Set<string>();
  for (const item of items) {
    const record = item as { type?: unknown; payload?: { name?: unknown } };
    if (record.type === "ns.org.create" && typeof record.payload?.name === "string") {
      orgs.add(record.payload.name);
    }
  }
  return [...orgs].sort();
}

function clampBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= CHAT_BODY_MAX_CODE_UNITS) return trimmed;
  const marker = "\n\n…(truncated)";
  return trimmed.slice(0, CHAT_BODY_MAX_CODE_UNITS - marker.length) + marker;
}

export class AgentResponder {
  private readonly gateway: AgentResponderPort;
  private readonly generate: AgentReplyGenerator;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly maxConcurrent: number;
  private readonly log: (line: string) => void;
  private readonly inFlight = new Set<string>();
  private readonly active = new Set<Promise<void>>();
  private runAbort = new AbortController();
  private scanInProgress: Promise<void> | undefined;
  /** Rate guard only (not state): a refused post is not retried until this time. */
  private readonly retryAfter = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;

  constructor(options: AgentResponderOptions) {
    this.gateway = options.gateway;
    this.generate = options.generate;
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 1_500;
    this.maxConcurrent = options.maxConcurrent ?? Number.MAX_SAFE_INTEGER;
    if (this.maxConcurrent <= 0 || !Number.isSafeInteger(this.maxConcurrent))
      throw new TypeError("maxConcurrent must be a positive integer");
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  start(): void {
    if (!this.stopped) return;
    if (this.runAbort.signal.aborted) this.runAbort = new AbortController();
    this.stopped = false;
    const loop = async (): Promise<void> => {
      try {
        // Runs are scheduled, not awaited: a long agent run never stalls the loop.
        this.scanInProgress = this.scan().then(() => undefined);
        await this.scanInProgress;
      } catch (error) {
        this.log(
          `agent-responder: tick failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.scanInProgress = undefined;
      if (!this.stopped) this.timer = setTimeout(() => void loop(), this.pollMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.runAbort.abort();
  }

  async drain(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          await this.scanInProgress?.catch(() => undefined);
          await Promise.allSettled([...this.active]);
          return true;
        })(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** One replay pass that also waits for every run it started (for tests). */
  async tick(): Promise<void> {
    await Promise.all(await this.scan());
  }

  /**
   * One replay pass: mirror thread ⇄ PR comments, and start a run for every unanswered
   * mention. Returns the started runs without waiting for them.
   */
  async scan(): Promise<Promise<void>[]> {
    const pending: Promise<void>[] = [];
    if (this.runAbort.signal.aborted) return pending;
    for (const org of orgsFromNamespace(await this.gateway.readOrgStream("ns:root"))) {
      if (this.runAbort.signal.aborted) break;
      const roster = records(await this.gateway.readOrgStream(agentsStreamId(org))).reduce(
        agentsReducer,
        agentsInitialState,
      );
      const agents = Object.values(roster.agents).filter((agent) => !agent.removed);
      if (agents.length === 0) continue;
      const catalog = reduceChatCatalog(await this.gateway.readOrgStream(chatCatalogStreamId(org)));
      for (const channel of Object.keys(catalog.channels).sort()) {
        if (this.runAbort.signal.aborted) break;
        const streamId = chatChannelStreamId(org, channel);
        const state = records(await this.gateway.readOrgStream(streamId)).reduce(
          chatChannelReducer,
          chatChannelInitialState,
        );
        if (this.runAbort.signal.aborted) break;
        const ids = new Set(state.messages.map((message) => message.id));
        try {
          await syncThreadPullRequests(this.gateway, {
            org,
            channel,
            streamId,
            state,
            now: this.now,
          });
        } catch (error) {
          this.log(
            `agent-responder: PR bridge failed in ${streamId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        for (const mention of state.messages) {
          if (this.runAbort.signal.aborted) break;
          if (mention.deleted) continue;
          // Agents never trigger agents — except a PR comment a person wrote, mirrored
          // into the thread by the bridge, which speaks for that person.
          const source = mirrorSource(mention.body);
          if (mention.actor.startsWith("agent:") && !isPrMirrorMessage(mention.id, source, org)) {
            continue;
          }
          for (const handle of mentionedHandles(mention.body)) {
            const agent = agents.find((candidate) => candidate.handle === handle);
            if (agent === undefined) continue;
            if (
              mention.serverReceivedAt === undefined ||
              mention.serverReceivedAt < agent.registeredAt
            ) {
              continue;
            }
            const replyId = agentReplyId(mention.id, handle);
            const key = `${streamId}#${replyId}`;
            if (ids.has(replyId) || this.inFlight.has(key)) continue;
            if ((this.retryAfter.get(key) ?? 0) > Date.now()) continue;
            if (this.inFlight.size >= this.maxConcurrent) continue;
            this.inFlight.add(key);
            const rootId = mention.threadOf ?? mention.id;
            const thread = state.messages.filter(
              (message) =>
                !message.deleted &&
                (message.id === rootId || message.threadOf === rootId) &&
                message.offset <= mention.offset,
            );
            const answer = this.answer(
              { org, channel, streamId, agent, thread, mention, signal: this.runAbort.signal },
              streamId,
              replyId,
              rootId,
            )
              .then((posted) => {
                if (!posted) this.retryAfter.set(key, Date.now() + 60_000);
              })
              .finally(() => this.inFlight.delete(key));
            this.active.add(answer);
            void answer.then(
              () => this.active.delete(answer),
              () => this.active.delete(answer),
            );
            pending.push(answer);
          }
        }
      }
    }
    return pending;
  }

  private async answer(
    request: AgentReplyRequest,
    streamId: string,
    replyId: string,
    rootId: string,
  ): Promise<boolean> {
    const handle = request.agent.handle;
    const runLog = new AgentRunLog(this.gateway, request.org, handle, this.now, this.log);
    const announce = async (text: string): Promise<void> => {
      const response = await this.gateway.dispatchAsAgent(request.org, handle, streamId, {
        type: "chat.message.post",
        payload: {
          v: 1,
          id: agentStatusReplyId(request.mention.id, handle),
          // The status note links the live run log, so its steps can be watched as they land.
          body: `${clampBody(text).slice(0, CHAT_BODY_MAX_CODE_UNITS - 200)}\n\n${markers.run(runLog.streamId)}`,
          threadOf: rootId,
        },
        ts: this.now(),
      });
      if (!response.ok) await response.body?.cancel();
    };
    let body: string;
    try {
      const result = await this.generate({ ...request, announce, runLog });
      if (request.signal?.aborted) return false;
      const reply = typeof result === "string" ? { body: result } : result;
      body = withoutMarkers(reply.body) || "_(no reply)_";
      let pullRequest: string | undefined;
      if (reply.workspace !== undefined) {
        const { org, repo, branch } = reply.workspace;
        const pr = await ensureAgentPullRequest(this.gateway, {
          org,
          repo,
          branch,
          handle,
          rootId,
          channel: request.channel,
          title: pullRequestTitle(
            handle,
            request.thread.map((message) => message.body),
          ),
          summary: body,
          now: this.now,
        });
        const branchUrl = `/${encodeURIComponent(org)}/${encodeURIComponent(repo)}/tree/${encodeURIComponent(branch)}/`;
        body = pr
          ? `${body}\n\n${pr.created ? "Opened" : "Updated"} [pull request](${pr.url}) from [\`${branch}\`](${branchUrl}) into \`main\` on $${repo}.\n\n${markers.pr(pr.streamId)}`
          : `${body}\n\nNo file changes on [\`${branch}\`](${branchUrl}), so no pull request.`;
        pullRequest = pr?.streamId;
      }
      await runLog.finish({
        status: "succeeded",
        summary: body,
        ...(pullRequest === undefined ? {} : { pullRequest }),
      });
    } catch (error) {
      if (request.signal?.aborted) return false;
      // A failed run still answers, so the thread shows why instead of silence, and the
      // deterministic id stops the responder from retrying the model call every tick.
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`agent-responder: @${handle} failed in ${streamId}: ${reason}`);
      body = `⚠️ @${handle} could not respond: ${withoutMarkers(reason)}`;
      await runLog.finish({ status: "failed", error: reason }).catch(() => undefined);
    }
    if (request.signal?.aborted) return false;
    // Every answer points at its complete run log (invisible link definition).
    body = `${clampBody(body).slice(0, CHAT_BODY_MAX_CODE_UNITS - 200)}\n\n${markers.run(runLog.streamId)}`;
    const response = await this.gateway.dispatchAsAgent(request.org, handle, streamId, {
      type: "chat.message.post",
      payload: { v: 1, id: replyId, body, threadOf: rootId },
      ts: this.now(),
    });
    if (response.ok) return true;
    this.log(
      `agent-responder: @${handle} reply refused in ${streamId}: ${response.status} ${await response.text()}`,
    );
    return false;
  }
}
