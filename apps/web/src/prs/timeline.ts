export interface ThreadablePrRecord {
  readonly offset: string;
  readonly type: string;
  readonly payload: unknown;
}

export interface PrTimelineNode<RecordType extends ThreadablePrRecord> {
  readonly record: RecordType;
  readonly replies: readonly PrTimelineNode<RecordType>[];
}

/**
 * Arrange review comments beneath the earlier event offset named by `replyTo`
 * while preserving the stream's canonical order. Invalid, forward, or
 * dangling targets remain roots so the UI never hides a durable event.
 */
export function threadPrTimeline<RecordType extends ThreadablePrRecord>(
  records: readonly RecordType[],
): readonly PrTimelineNode<RecordType>[] {
  const nodes = new Map<string, { record: RecordType; replies: PrTimelineNode<RecordType>[] }>();
  const roots: PrTimelineNode<RecordType>[] = [];
  for (const record of records) {
    const node = { record, replies: [] as PrTimelineNode<RecordType>[] };
    const payload = record.payload as Record<string, unknown>;
    const replyTo = record.type === "pr.review-comment" ? payload.replyTo : undefined;
    const parent = typeof replyTo === "string" ? nodes.get(replyTo) : undefined;
    if (parent !== undefined && parent.record.type === "pr.review-comment") {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
    nodes.set(record.offset, node);
  }
  return roots;
}
