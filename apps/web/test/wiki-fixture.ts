import type { StreamRecord } from "@eforest/client";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import {
  BASE_NONE,
  branchContentStreamPrefix,
  fileCreateEvent,
  fileDeleteEvent,
  filePatchEvent,
  fileRenameEvent,
  fileWriteEvent,
} from "@eforest/streamfs";

export const WIKI_ORG = "maple";
export const WIKI_REPO = "reading-room";
export const WIKI_STREAM = `fs:${WIKI_ORG}/${WIKI_REPO}:wiki:meta`;
export const WIKI_NOW = 1_700_000_800_000;
export const HOME_UUID = "00000000-0000-4000-8000-000000000001";
export const DISPOSABLE_UUID = "00000000-0000-4000-8000-000000000002";
export const HOME_CONTENT_STREAM = `${branchContentStreamPrefix(
  `${WIKI_ORG}/${WIKI_REPO}`,
  "wiki",
)}${HOME_UUID}`;
export const DISPOSABLE_CONTENT_STREAM = `${branchContentStreamPrefix(
  `${WIKI_ORG}/${WIKI_REPO}`,
  "wiki",
)}${DISPOSABLE_UUID}`;
export const HOSTILE_CONTENT_STREAM = `${branchContentStreamPrefix(
  `${WIKI_ORG}/${WIKI_REPO}`,
  "wiki",
)}hostile-proof`;

export const HOME_BASE = `# Home

${Array.from({ length: 180 }, (_, index) => `Line ${String(index).padStart(3, "0")}: stable wiki proof.\n`).join("")}`;
export const HOME_PATCH_TARGET = `${HOME_BASE}A live patch reached session B.\n`;
export const HOME_STALE_TARGET = `${HOME_BASE}A stale session B draft.\n`;
export const HOME_REBASED_TARGET = `${HOME_PATCH_TARGET}A reviewed patch landed from session B.\n`;
export const HOME_FULL_TARGET = `# Guide

Canonical full-write bytes came through the browser dispatch door.

Both sessions replay this exact source.
`;

export const HOSTILE_MARKDOWN = `# Hostile but inert

<script>globalThis.__wikiPwned = true</script>
<img src="data:image/svg+xml,<svg onload='globalThis.__wikiPwned=true'>" onerror="globalThis.__wikiPwned=true">
<iframe srcdoc="<script>globalThis.__wikiPwned=true</script>"></iframe>
<object data="javascript:globalThis.__wikiPwned=true"></object>
[javascript](javascript:globalThis.__wikiPwned=true)
[data](data:text/html,pwned)
<a href="vbscript:globalThis.__wikiPwned=true" onclick="globalThis.__wikiPwned=true">bad</a>

Safe text survives.
`;

const encoder = new TextEncoder();

function record(ordinal: number, event: Omit<StreamRecord, "offset">): StreamRecord {
  return { offset: offsetForOrdinal(ordinal), ...event };
}

export function expectedWikiRecords(): readonly StreamRecord[] {
  return [
    record(0, {
      type: "fs.branch.genesis",
      payload: { v: 1, branch: "wiki" },
      ts: WIKI_NOW,
    }),
    record(1, fileCreateEvent("home.md", HOME_CONTENT_STREAM, WIKI_NOW)),
    record(2, fileWriteEvent(encoder.encode(HOME_BASE), "home.md", BASE_NONE, WIKI_NOW + 1)),
    record(
      3,
      filePatchEvent(
        encoder.encode(HOME_BASE),
        encoder.encode(HOME_PATCH_TARGET),
        "home.md",
        offsetForOrdinal(2),
        WIKI_NOW,
      ),
    ),
    record(
      4,
      filePatchEvent(
        encoder.encode(HOME_PATCH_TARGET),
        encoder.encode(HOME_REBASED_TARGET),
        "home.md",
        offsetForOrdinal(3),
        WIKI_NOW,
      ),
    ),
    record(
      5,
      fileWriteEvent(
        encoder.encode(HOME_FULL_TARGET),
        "home.md",
        offsetForOrdinal(4),
        WIKI_NOW,
      ),
    ),
    record(6, fileRenameEvent("home.md", "guide.md", WIKI_NOW)),
    record(7, fileCreateEvent("disposable.md", DISPOSABLE_CONTENT_STREAM, WIKI_NOW)),
    record(8, fileDeleteEvent("disposable.md", WIKI_NOW)),
    record(9, fileCreateEvent("hostile.md", HOSTILE_CONTENT_STREAM, WIKI_NOW + 2)),
    record(
      10,
      fileWriteEvent(encoder.encode(HOSTILE_MARKDOWN), "hostile.md", BASE_NONE, WIKI_NOW + 3),
    ),
  ];
}
