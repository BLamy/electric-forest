import { useEffect, useMemo, useState } from "react";
import {
  PR_INDEX_REDUCER,
  computeSinceForkDiff,
  parseBranchStreamId,
  prDiffDigest,
  prStreamId,
  repoPrIndexStreamId,
  type PrDiff,
  type PrIndexRow,
  type PrIndexState,
} from "@eforest/pr";
import { OFFSET_BEFORE_FIRST, type Event } from "@eforest/protocol";
import type { RepositoryBranch, RepositoryBranchesState } from "@eforest/reducers";
import { emptyTree, type FsTree } from "@eforest/streamfs";
import {
  useDispatch,
  useStreamReducer,
  type ApplicationRecord,
  type DispatchFunction,
  type StreamReducerResult,
} from "@eforest/web-hooks";
import type { MeadowPrState } from "@eforest/meadow";

export { branchNameFromStream, openedEvent } from "./model.js";

const EMPTY_DIFF: PrDiff = Object.freeze({ files: Object.freeze([]) });

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function branchEventsPath(org: string, repo: string, branch: string, until?: string): string {
  const base = `/api/repos/${encoded(org)}/${encoded(repo)}/${encoded(branch)}/events`;
  return until === undefined ? base : `${base}?until=${encoded(until)}`;
}

function branchStreamId(org: string, repo: string, branch: string): string {
  return `fs:${org}/${repo}:${branch}:meta`;
}

function useActor(): string {
  const [actor, setActor] = useState("current-user");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/whoami", { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => (response.ok ? (response.json() as Promise<unknown>) : undefined))
      .then((value) => {
        if (value === undefined || value === null || typeof value !== "object") return;
        const user = (value as { readonly user?: unknown }).user;
        if (user === null || typeof user !== "object") return;
        const candidate = user as { readonly email?: unknown; readonly sub?: unknown };
        if (typeof candidate.email === "string" && candidate.email !== "") {
          setActor(candidate.email);
        } else if (typeof candidate.sub === "string" && candidate.sub !== "") {
          setActor(candidate.sub);
        }
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          setActor("current-user");
      });
    return () => controller.abort();
  }, []);
  return actor;
}

export interface PrListBinding {
  readonly streamId: string;
  readonly reducerId: typeof PR_INDEX_REDUCER;
  readonly projection: StreamReducerResult<PrIndexState>;
  readonly rows: readonly PrIndexRow[];
  readonly branches: StreamReducerResult<RepositoryBranchesState>;
  readonly actor: string;
}

export function usePrList(org: string, repo: string): PrListBinding {
  const streamId = repoPrIndexStreamId(org, repo);
  const projection = useStreamReducer<PrIndexState>({
    apiPath: `/api/repos/${encoded(org)}/${encoded(repo)}/pulls`,
    streamId,
    reducerId: PR_INDEX_REDUCER,
    followWaitMs: 500,
    reconnectDelayMs: 100,
  });
  const branches = useStreamReducer<RepositoryBranchesState>({
    apiPath: `/api/repos/${encoded(org)}/${encoded(repo)}/home/branches`,
    streamId: `repo-home:${org}/${repo}:branches`,
    reducerId: "repo-branches",
    followWaitMs: 1_000,
    reconnectDelayMs: 200,
  });
  const actor = useActor();
  return {
    streamId,
    reducerId: PR_INDEX_REDUCER,
    projection,
    rows: projection.state.rows,
    branches,
    actor,
  };
}

export function usePrCreator(org: string, repo: string, prId: string): DispatchFunction {
  return useDispatch(prStreamId(org, repo, prId));
}

export function branchRows(binding: PrListBinding): readonly RepositoryBranch[] {
  return Object.values(binding.branches.state.branches).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export interface PrDetailBinding {
  readonly streamId: string;
  readonly projection: StreamReducerResult<MeadowPrState>;
  readonly dispatch: DispatchFunction;
  readonly actor: string;
  readonly base: StreamReducerResult<FsTree>;
  readonly baseStreamId: string;
  readonly source: StreamReducerResult<FsTree>;
  readonly sourceStreamId: string;
  readonly diff: PrDiff;
  readonly diffDigest: string;
}

export function usePrDetail(org: string, repo: string, prId: string): PrDetailBinding {
  const streamId = prStreamId(org, repo, prId);
  const projection = useStreamReducer<MeadowPrState>({
    apiPath: `/api/repos/${encoded(org)}/${encoded(repo)}/main/events?stream=pr&prId=${encoded(prId)}`,
    streamId,
    reducerId: "pr",
    followWaitMs: 500,
    reconnectDelayMs: 100,
  });
  const dispatch = useDispatch(streamId, { replayedOffset: projection.checkpoint });
  const state = projection.state;
  const fallbackTargetStream = branchStreamId(org, repo, "main");
  const baseStreamId = state.targetBranch || fallbackTargetStream;
  const sourceStreamId = state.sourceBranch || baseStreamId;
  const targetBranch = parseBranchStreamId(baseStreamId)?.branch ?? "main";
  const sourceBranch = parseBranchStreamId(sourceStreamId)?.branch ?? targetBranch;
  const base = useStreamReducer<FsTree>({
    apiPath: branchEventsPath(org, repo, targetBranch, state.forkOffset),
    streamId: baseStreamId,
    reducerId: "streamfs",
    followWaitMs: 750,
    reconnectDelayMs: 150,
    cacheKey: `pr-base:${org}/${repo}:${targetBranch}:${state.forkOffset}`,
  });
  const source = useStreamReducer<FsTree>({
    apiPath: branchEventsPath(org, repo, sourceBranch),
    streamId: sourceStreamId,
    reducerId: "streamfs",
    followWaitMs: 500,
    reconnectDelayMs: 100,
    cacheKey: `pr-source:${org}/${repo}:${sourceBranch}`,
  });
  const diff = useMemo(
    () =>
      state.openedAtOffset === OFFSET_BEFORE_FIRST
        ? EMPTY_DIFF
        : computeSinceForkDiff(base.state ?? emptyTree(), source.state ?? emptyTree()),
    [base.state, source.state, state.openedAtOffset],
  );
  const diffDigest = useMemo(() => prDiffDigest(diff), [diff]);
  const actor = useActor();
  return {
    streamId,
    projection,
    dispatch,
    actor,
    base,
    baseStreamId,
    source,
    sourceStreamId,
    diff,
    diffDigest,
  };
}

function prEvent(type: string, payload: Record<string, unknown>): Event {
  return { type, payload, ts: Date.now() };
}

export const prActions = Object.freeze({
  comment: (author: string, body: string, path?: string, line?: number, replyTo?: string): Event =>
    prEvent("pr.review-comment", {
      v: 2,
      author,
      body,
      ...(path === undefined || path === "" ? {} : { path }),
      ...(line === undefined ? {} : { line }),
      ...(replyTo === undefined || replyTo === "" ? {} : { replyTo }),
    }),
  approve: (reviewer: string): Event => prEvent("pr.approved", { v: 1, reviewer }),
  requestChanges: (reviewer: string, body: string): Event =>
    prEvent("pr.changes-requested", { v: 1, reviewer, body }),
  merge: (): Event => prEvent("pr.merge", { v: 1 }),
  close: (closedBy: string, reason?: string): Event =>
    prEvent("pr.closed", {
      v: 1,
      closedBy,
      ...(reason === undefined || reason === "" ? {} : { reason }),
    }),
});

export function prTimeline(binding: PrDetailBinding): readonly ApplicationRecord[] {
  return binding.projection.records;
}

export function issueIdFromStream(streamId: string): string | undefined {
  const match = /^issue:[^/]+\/[^/]+\/(.+)$/.exec(streamId);
  return match?.[1];
}

export function prIdFromStream(streamId: string): string | undefined {
  const match = /^pr:[^/]+\/[^/]+\/(.+)$/.exec(streamId);
  return match?.[1];
}
