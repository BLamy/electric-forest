import { readFileSync } from "node:fs";
import { canonicalJson, type Event, type Offset } from "@eforest/protocol";
import { expect } from "vitest";
import type { RefusalScenario } from "./golden.js";

export const EVIDENCE_DIR = new URL(
  "../../../.eforest/tasks/epic-6-the-loop/E6-T01-task-event-model/evidence/",
  import.meta.url,
);

export function artifact(name: string): string {
  return readFileSync(new URL(name, EVIDENCE_DIR), "utf8");
}

/** Read a frozen canonical JSONL log: every line must already be canonical JSON. */
export function readCanonicalJsonl<T = unknown>(name: string): readonly T[] {
  const source = artifact(name);
  expect(source.endsWith("\n"), `${name}: trailing newline`).toBe(true);
  expect(source.includes("\r"), `${name}: CRLF`).toBe(false);
  return source
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      const parsed = JSON.parse(line) as T;
      expect(canonicalJson(parsed), `${name}:${index + 1} canonical`).toBe(line);
      return parsed;
    });
}

export type FrozenEvent = Event & { readonly offset: Offset };

export function frozenTaskLog(): readonly FrozenEvent[] {
  return readCanonicalJsonl<FrozenEvent>("e6-t01-task.jsonl");
}

export function frozenDigest(): string {
  const digest = artifact("e6-t01-task.digest").trim();
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  return digest;
}

export function frozenRefusals(): readonly RefusalScenario[] {
  return readCanonicalJsonl<RefusalScenario>("e6-t01-invalid.jsonl");
}
