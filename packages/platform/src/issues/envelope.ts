import type { Event } from "@eforest/protocol";
export {
  ISSUE_EVENT_VERSION,
  ISSUE_STRING_MAX_CODE_UNITS,
  isIssueString,
  type IssueActionType,
} from "@eforest/reducers";
import {
  ISSUE_EVENT_VERSION,
  isIssueActionType,
  isIssueString,
  isIssueStreamId,
  type IssueActionType,
} from "@eforest/reducers";
import { jsonTokenAtPath } from "./json-source.js";

export const ISSUE_MAX_DISPATCH_BYTES = 10 * 1024 * 1024;

export interface IssueEnvelopeSource {
  readonly requestBytes: number;
  readonly versionToken?: string;
}

/**
 * Parse with the standard ES2022 JSON grammar while retaining the exact token
 * for event.payload.v through a portable structural source scan. The scanner
 * follows object paths and JSON's last-duplicate-key behavior, so decoy text,
 * nested v keys, escaped property names, and whitespace stay unambiguous.
 */
export function parseJsonWithIssueEnvelopeSource(
  source: string,
  requestBytes: number,
): { readonly value: unknown; readonly issueSource: IssueEnvelopeSource } {
  const value: unknown = JSON.parse(source);
  const root = objectRecord(value);
  const event = objectRecord(root?.event);
  const versionToken =
    typeof root?.streamId === "string" &&
    isIssueStreamId(root.streamId) &&
    typeof event?.type === "string" &&
    isIssueActionType(event.type)
      ? jsonTokenAtPath(source, ["event", "payload", "v"])
      : undefined;
  return {
    value,
    issueSource: {
      requestBytes,
      ...(versionToken === undefined ? {} : { versionToken }),
    },
  };
}

export function isIssueEnvelopeSourceValid(source: IssueEnvelopeSource): boolean {
  return source.requestBytes <= ISSUE_MAX_DISPATCH_BYTES && source.versionToken === "1";
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

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
  if (event.type === "issue.opened") return isIssueString(p.title) && isIssueString(p.body);
  if (event.type === "issue.commented") return isIssueString(p.commentId) && isIssueString(p.body);
  if (event.type === "issue.labeled" || event.type === "issue.unlabeled")
    return isIssueString(p.label);
  if (event.type === "issue.state-changed")
    return (
      p.to === "open" ||
      p.to === "in-progress" ||
      p.to === "done" ||
      p.to === "closed" ||
      p.to === "wont-do"
    );
  if (event.type === "issue.closed") {
    return p.reason === undefined || isIssueString(p.reason);
  }
  return event.type === "issue.reopened";
}
