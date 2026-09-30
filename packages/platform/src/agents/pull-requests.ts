import { createHash } from "node:crypto";

/**
 * Agent pull requests and the thread ⇄ PR bridge.
 *
 * When an agent finishes editing on its branch it opens one PR per (agent, thread,
 * codebase) — deterministic id, so follow-up mentions in the thread keep pushing to the
 * same branch and PR. The PR body links the thread; the agent's chat reply links the PR.
 * Both carry an invisible Markdown link definition (`[eforest-…]: eforest:…`) so the
 * pairing, and every mirrored comment, is recovered from the streams by replay — there
 * is no side table.
 */

export interface PullRequestPort {
  readOrgStream(streamId: string): Promise<readonly unknown[]>;
  dispatchAsAgent(
    org: string,
    handle: string,
    streamId: string,
    event: { readonly type: string; readonly payload: unknown; readonly ts: number },
    scope?: { readonly pullRequest?: string },
  ): Promise<Response>;
}

export interface AgentPullRequest {
  readonly streamId: string;
  readonly url: string;
  readonly created: boolean;
}

interface RawRecord {
  readonly offset?: string;
  readonly type?: string;
  readonly payload?: Record<string, unknown>;
}

const PR_LINK_RE = /^\[eforest-pr\]: eforest:(pr:[^\s]+)$/m;
const THREAD_LINK_RE = /^\[eforest-thread\]: eforest:chat:([a-z0-9-]+)\/([^#\s]+)#([^\s]+)$/m;
const MIRROR_RE = /^\[eforest-mirror\]: eforest:([^\s]+)$/m;

function hash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function agentPullRequestId(handle: string, rootId: string, repo: string): string {
  return `agent-${handle}-${hash(`${rootId}\0${repo}`, 10)}`;
}

export function pullRequestUrl(org: string, repo: string, prId: string): string {
  return `/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prId)}`;
}

export function threadUrl(org: string, channel: string, rootId: string): string {
  return `/chat/${encodeURIComponent(org)}/${encodeURIComponent(channel)}?thread=${encodeURIComponent(rootId)}`;
}

/** Marker lines. Link reference definitions render as nothing in Markdown. */
export const markers = {
  pr: (prStreamId: string) => `[eforest-pr]: eforest:${prStreamId}`,
  thread: (org: string, channel: string, rootId: string) =>
    `[eforest-thread]: eforest:chat:${org}/${channel}#${rootId}`,
  mirror: (source: string) => `[eforest-mirror]: eforest:${source}`,
  run: (runStreamId: string) => `[eforest-run]: eforest:${runStreamId}`,
};

/** The run log (`agent-run:<org>/<runId>`) an agent reply was produced by. */
export function linkedRun(body: string): string | undefined {
  return /^\[eforest-run\]: eforest:(agent-run:\S+)$/m.exec(body)?.[1];
}

export function linkedPullRequest(body: string): string | undefined {
  return PR_LINK_RE.exec(body)?.[1];
}

export function linkedThread(
  body: string,
): { readonly org: string; readonly channel: string; readonly rootId: string } | undefined {
  const match = THREAD_LINK_RE.exec(body);
  return match === null ? undefined : { org: match[1]!, channel: match[2]!, rootId: match[3]! };
}

/** The mirror source (`chat/<msgId>` or `pr:<stream>@<offset>`) a message was copied from. */
export function mirrorSource(body: string): string | undefined {
  return MIRROR_RE.exec(body)?.[1];
}

export function parsePrStreamId(
  streamId: string,
): { readonly org: string; readonly repo: string; readonly prId: string } | undefined {
  const match = /^pr:([a-z0-9-]+)\/([a-z0-9-]+)\/([A-Za-z0-9._~-]+)$/.exec(streamId);
  return match === null ? undefined : { org: match[1]!, repo: match[2]!, prId: match[3]! };
}

function records(items: readonly unknown[]): RawRecord[] {
  return items.filter((item): item is RawRecord => item !== null && typeof item === "object");
}

/**
 * Open (or find) the agent's PR from `branch` into main. Returns undefined when the
 * branch has no changes past its fork — nothing to review.
 */
export async function ensureAgentPullRequest(
  port: PullRequestPort,
  input: {
    readonly org: string;
    readonly repo: string;
    readonly branch: string;
    readonly handle: string;
    readonly rootId: string;
    readonly channel: string;
    readonly title: string;
    readonly summary: string;
    readonly now: () => number;
  },
): Promise<AgentPullRequest | undefined> {
  const { org, repo, branch, handle, rootId, channel } = input;
  const prId = agentPullRequestId(handle, rootId, repo);
  const streamId = `pr:${org}/${repo}/${prId}`;
  const url = pullRequestUrl(org, repo, prId);
  const existing = records(await port.readOrgStream(streamId));
  if (existing.some((record) => record.type === "pr.opened")) {
    return { streamId, url, created: false };
  }
  const sourceBranch = `fs:${org}/${repo}:${branch}:meta`;
  const branchRecords = records(await port.readOrgStream(sourceBranch));
  const forkIndex = branchRecords.findIndex((record) => record.type === "fs.branch.fork");
  const forkOffset = branchRecords[forkIndex]?.payload?.forkOffset;
  if (forkIndex === -1 || typeof forkOffset !== "string") return undefined;
  if (branchRecords.length <= forkIndex + 1) return undefined;
  const body = [
    input.summary.trim(),
    "",
    `Requested in [\\#${channel}](${threadUrl(org, channel, rootId)}) — comments here and replies in that thread are mirrored both ways.`,
    "",
    markers.thread(org, channel, rootId),
  ].join("\n");
  const response = await port.dispatchAsAgent(
    org,
    handle,
    streamId,
    {
      type: "pr.opened",
      payload: {
        v: 1,
        sourceBranch,
        targetBranch: `fs:${org}/${repo}:main:meta`,
        forkOffset,
        title: input.title,
        body,
        author: `agent:${handle}`,
      },
      ts: input.now(),
    },
    { pullRequest: streamId },
  );
  if (!response.ok) {
    throw new Error(
      `could not open a pull request: ${String(response.status)} ${await response.text()}`,
    );
  }
  return { streamId, url, created: true };
}

/** A short PR title from the request text, chips and markup stripped. */
export function pullRequestTitle(handle: string, texts: readonly string[]): string {
  for (const text of texts) {
    const plain = text
      .replace(/^\[eforest-[a-z]+\]: .*$/gm, "")
      .replace(/[@#$]([A-Za-z_][\w./-]*)/g, "$1")
      .replace(/[`*_>#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain.length > 0) {
      return plain.length <= 72 ? plain : `${plain.slice(0, 71).trimEnd()}…`;
    }
  }
  return `Changes from @${handle}`;
}
