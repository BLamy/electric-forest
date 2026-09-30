import { createHash } from "node:crypto";
import type { ChatChannelState, ChatMessage } from "@eforest/reducers";
import {
  linkedPullRequest,
  markers,
  mirrorSource,
  parsePrStreamId,
  pullRequestUrl,
  threadUrl,
  type PullRequestPort,
} from "./pull-requests.js";

/**
 * Thread ⇄ pull request mirror. A thread is linked to a PR by the agent reply that
 * carries its `[eforest-pr]` marker. Every tick, by replay of both streams:
 *  - each PR review comment not itself a mirror is posted into the thread (deterministic
 *    chat id per PR offset, so it lands once);
 *  - each thread reply after the link — people's replies and the agents' later answers,
 *    not their status notes — is posted as a PR comment tagged with its chat message id
 *    (found again on the next replay, so it lands once).
 * Mirrors are authored by the agent that owns the PR — through the dispatch door, scoped
 * to that one PR stream — and name the original author in the text.
 */

interface RawRecord {
  readonly offset?: string;
  readonly type?: string;
  readonly payload?: Record<string, unknown>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export function prMirrorMessageId(prStreamId: string, offset: string): string {
  return `mirror-${hash(`${prStreamId}@${offset}`)}`;
}

function display(actor: string): string {
  if (actor.startsWith("agent:")) return `@${actor.slice("agent:".length)}`;
  return actor.replace(/^auth0\|/, "").split("@")[0] ?? actor;
}

function withoutMarkers(body: string): string {
  return body.replace(/^\[eforest-[a-z]+\]: eforest:\S+$/gm, "").trim();
}

export async function syncThreadPullRequests(
  port: PullRequestPort,
  input: {
    readonly org: string;
    readonly channel: string;
    readonly streamId: string;
    readonly state: ChatChannelState;
    readonly now: () => number;
  },
): Promise<void> {
  const { org, channel, streamId, state } = input;
  const ids = new Set(state.messages.map((message) => message.id));
  const links = state.messages.filter(
    (message) =>
      !message.deleted && message.actor.startsWith("agent:") && linkedPullRequest(message.body),
  );
  const seen = new Set<string>();
  for (const link of links) {
    const prStreamId = linkedPullRequest(link.body)!;
    const rootId = link.threadOf ?? link.id;
    const key = `${rootId}\0${prStreamId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pr = parsePrStreamId(prStreamId);
    if (pr === undefined || pr.org !== org) continue;
    const handle = link.actor.slice("agent:".length);
    const prUrl = pullRequestUrl(pr.org, pr.repo, pr.prId);
    const prRecords = (await port.readOrgStream(prStreamId)).filter(
      (item): item is RawRecord => item !== null && typeof item === "object",
    );
    if (!prRecords.some((record) => record.type === "pr.opened")) continue;

    // PR → thread.
    for (const record of prRecords) {
      if (record.type !== "pr.review-comment" || typeof record.offset !== "string") continue;
      const body = typeof record.payload?.body === "string" ? record.payload.body : "";
      if (mirrorSource(body) !== undefined) continue;
      const id = prMirrorMessageId(prStreamId, record.offset);
      if (ids.has(id)) continue;
      const author = typeof record.payload?.author === "string" ? record.payload.author : "someone";
      const where =
        typeof record.payload?.path === "string"
          ? ` on \`${record.payload.path}${typeof record.payload.line === "number" ? `:${String(record.payload.line)}` : ""}\``
          : "";
      const response = await port.dispatchAsAgent(org, handle, streamId, {
        type: "chat.message.post",
        payload: {
          v: 1,
          id,
          threadOf: rootId,
          body: `**${display(author)}** commented on the [pull request](${prUrl})${where}:\n\n${withoutMarkers(body)}\n\n${markers.mirror(`${prStreamId}@${record.offset}`)}`,
        },
        ts: input.now(),
      });
      if (response.ok) ids.add(id);
      else await response.body?.cancel();
    }

    // Thread → PR.
    const mirrored = new Set(
      prRecords
        .map((record) =>
          typeof record.payload?.body === "string" ? mirrorSource(record.payload.body) : undefined,
        )
        .filter((source): source is string => source?.startsWith("chat/") === true)
        .map((source) => source.slice("chat/".length)),
    );
    // People's replies, and the agents' own later answers (not their "working…" status
    // notes or the linking reply, whose content is already the PR description).
    const replies: ChatMessage[] = state.messages.filter(
      (message) =>
        !message.deleted &&
        message.threadOf === rootId &&
        message.offset > link.offset &&
        !message.id.includes("-status-") &&
        mirrorSource(message.body) === undefined &&
        !mirrored.has(message.id),
    );
    for (const reply of replies) {
      const response = await port.dispatchAsAgent(
        org,
        handle,
        prStreamId,
        {
          type: "pr.review-comment",
          payload: {
            v: 1,
            author: display(reply.actor),
            body: `**${display(reply.actor)}** replied in [\\#${channel}](${threadUrl(org, channel, rootId)}):\n\n${withoutMarkers(reply.body)}\n\n${markers.mirror(`chat/${reply.id}`)}`,
          },
          ts: input.now(),
        },
        { pullRequest: prStreamId },
      );
      if (!response.ok) await response.body?.cancel();
    }
  }
}
