export function branchNameFromStream(streamId: string): string {
  const match = /^fs:([^/]+)\/([^:]+):([^:]+):meta$/.exec(streamId);
  return match?.[3] ?? streamId;
}

export function openedEvent(input: {
  readonly org: string;
  readonly repo: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly forkOffset: string;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly closes: readonly string[];
}): {
  readonly type: "pr.opened";
  readonly payload: Record<string, unknown>;
  readonly ts: number;
} {
  const closes = input.closes
    .map((issueId) => issueId.trim())
    .filter((issueId) => issueId !== "")
    .map((issueId) => ({
      entity: "issue" as const,
      stream: issueId.startsWith("issue:")
        ? issueId
        : `issue:${input.org}/${input.repo}/${issueId}`,
    }));
  return {
    type: "pr.opened",
    payload: {
      v: 1,
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      forkOffset: input.forkOffset,
      title: input.title,
      body: input.body,
      author: input.author,
      ...(closes.length === 0 ? {} : { closes }),
    },
    ts: Date.now(),
  };
}
