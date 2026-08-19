import type { Event } from "@eforest/protocol";
export { ISSUE_EVENT_VERSION, type IssueActionType } from "@eforest/reducers";
import { ISSUE_EVENT_VERSION, isIssueActionType, type IssueActionType } from "@eforest/reducers";

const fields: Readonly<Record<IssueActionType, readonly string[]>> = {
  "issue.opened": ["v", "title", "body"],
  "issue.commented": ["v", "commentId", "body"],
  "issue.labeled": ["v", "label"],
  "issue.unlabeled": ["v", "label"],
  "issue.state-changed": ["v", "to"],
  "issue.closed": ["v", "reason"],
  "issue.reopened": ["v"],
};
function exact(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const want = [...expected].sort();
  return keys.length === want.length && keys.every((key, i) => key === want[i]);
}
export function isIssueEvent(event: Event): boolean {
  if (!isIssueActionType(event.type)) return false;
  const p = event.payload as Record<string, unknown>;
  const expected =
    event.type === "issue.closed" && Object.prototype.hasOwnProperty.call(p, "reason")
      ? fields[event.type]
      : fields[event.type].filter((key) => key !== "reason");
  if (!exact(p, expected) || p.v !== ISSUE_EVENT_VERSION) return false;
  if (event.type === "issue.opened")
    return typeof p.title === "string" && typeof p.body === "string";
  if (event.type === "issue.commented")
    return typeof p.commentId === "string" && typeof p.body === "string";
  if (event.type === "issue.labeled" || event.type === "issue.unlabeled")
    return typeof p.label === "string";
  if (event.type === "issue.state-changed")
    return p.to === "open" || p.to === "in-progress" || p.to === "done" || p.to === "wont-do";
  if (event.type === "issue.closed") {
    return p.reason === undefined || typeof p.reason === "string";
  }
  return event.type === "issue.reopened";
}
