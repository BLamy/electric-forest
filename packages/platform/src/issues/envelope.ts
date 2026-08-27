import type { Event } from "@eforest/protocol";
export {
  ISSUE_EVENT_VERSION,
  ISSUE_STRING_MAX_CODE_UNITS,
  isIssueString,
  type IssueActionType,
} from "@eforest/reducers";
import { isIssueActionType, isIssueEventShape, isIssueStreamId } from "@eforest/reducers";
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
  return (
    source.requestBytes <= ISSUE_MAX_DISPATCH_BYTES &&
    (source.versionToken === "1" || source.versionToken === "2")
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isIssueEvent(event: Event): boolean {
  return isIssueEventShape(event);
}
