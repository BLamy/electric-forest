import { isDurableConflict, isDurableExistsConflict, isDurableNotFound } from "@eforest/client";
import type { Event } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import type { StreamAdapter } from "../official.js";
import {
  isNamespaceDispatchEvent,
  isNamespaceEvent,
  isNamespaceName,
  stampNamespaceEvent,
} from "./events.js";
import { replayNamespaceStream } from "./reducer.js";

export type NamespaceRefusalReason =
  | "ns/name-taken"
  | "ns/invalid-name"
  | "ns/reserved-name"
  | "ns/org-not-found"
  | "ns/project-not-found";

export class NamespaceSchemaError extends Error {
  constructor() {
    super("namespace schema violation");
    this.name = "NamespaceSchemaError";
  }
}

export class NamespaceRefusalError extends Error {
  constructor(readonly reason: NamespaceRefusalReason) {
    super(reason);
    this.name = "NamespaceRefusalError";
  }
}

function validateName(name: string): void {
  if (!isNamespaceName(name)) throw new NamespaceRefusalError("ns/invalid-name");
  if (name === "main" || name === "ns" || name === "fs") {
    throw new NamespaceRefusalError("ns/reserved-name");
  }
}

async function ensureStream(streams: StreamAdapter, streamId: string): Promise<void> {
  try {
    await streams.create(streamId);
  } catch (error) {
    if (!isDurableExistsConflict(error)) throw error;
  }
}

async function readOrEmpty(streams: StreamAdapter, streamId: string): Promise<readonly unknown[]> {
  try {
    return await streams.read(streamId);
  } catch (error) {
    if (isDurableNotFound(error)) return [];
    throw error;
  }
}

export class NamespaceDispatcher {
  constructor(private readonly streams: StreamAdapter) {}

  /**
   * Rebuild the physical per-org stream set from the authoritative root log.
   *
   * Durable Streams does not offer a cross-stream transaction, so a process can
   * stop after the root event commits but before its empty per-org stream is
   * minted. Reconciliation is idempotent and derives every repair from ns:root;
   * an unrecorded org can therefore never acquire a stream through this path.
   */
  async reconcile(): Promise<void> {
    await ensureStream(this.streams, "ns:root");
    const root = replayNamespaceStream(await readOrEmpty(this.streams, "ns:root"));
    await Promise.all(
      Object.keys(root.orgs)
        .sort()
        .map((org) => ensureStream(this.streams, `ns:org:${org}`)),
    );
  }

  async dispatch(
    streamId: string,
    event: Event,
    sub: string,
    operationId?: string,
    assertActive?: () => Promise<void>,
  ): Promise<void> {
    if (!isNamespaceDispatchEvent(event)) throw new NamespaceSchemaError();
    const target = event.type === "ns.org.create" ? "ns:root" : streamId;
    if (event.type === "ns.org.create" && streamId !== "ns:root") throw new NamespaceSchemaError();
    if (event.type !== "ns.org.create" && !streamId.startsWith("ns:org:")) {
      throw new NamespaceSchemaError();
    }
    const payload = event.payload as Record<string, unknown>;
    const name = payload.name as string;
    validateName(name);
    if (event.type === "ns.repo.create") validateName(payload.project as string);
    await ensureStream(this.streams, "ns:root");

    for (let attempt = 0; attempt < 32; attempt += 1) {
      const rootEvents = await readOrEmpty(this.streams, "ns:root");
      const root = replayNamespaceStream(rootEvents);
      await Promise.all(
        Object.keys(root.orgs)
          .sort()
          .map((org) => ensureStream(this.streams, `ns:org:${org}`)),
      );
      let current: readonly unknown[];
      if (event.type === "ns.org.create") {
        if (Object.hasOwn(root.orgs, name)) throw new NamespaceRefusalError("ns/name-taken");
        current = rootEvents;
      } else {
        const org = streamId.slice("ns:org:".length);
        if (!Object.hasOwn(root.orgs, org)) throw new NamespaceRefusalError("ns/org-not-found");
        await ensureStream(this.streams, streamId);
        current = await readOrEmpty(this.streams, streamId);
        const local = replayNamespaceStream(current);
        if (
          event.type === "ns.repo.create" &&
          !Object.hasOwn(local.projects, payload.project as string)
        ) {
          throw new NamespaceRefusalError("ns/project-not-found");
        }
        if (
          (event.type === "ns.project.create" && Object.hasOwn(local.projects, name)) ||
          (event.type === "ns.repo.create" && Object.hasOwn(local.repos, name))
        ) {
          throw new NamespaceRefusalError("ns/name-taken");
        }
      }
      const appended = stampNamespaceEvent(event, sub);
      const offset = offsetForOrdinal(current.length);
      const record = { ...appended, offset };
      try {
        await assertActive?.();
        const result = await this.streams.append(target, record, {
          sequence: offset,
          ...(operationId === undefined ? {} : { idempotencyKey: operationId }),
        });
        if (result === "producer-duplicate-closed") await assertActive?.();
        if (event.type === "ns.org.create") await ensureStream(this.streams, `ns:org:${name}`);
        return;
      } catch (error) {
        if (isDurableConflict(error)) continue;
        throw error;
      }
    }
    throw new Error("namespace dispatch retry budget exhausted");
  }

  async recover(operationId: string, streamId: string, event: Event): Promise<void> {
    if (!isNamespaceEvent(event)) throw new NamespaceSchemaError();
    const { actor, ...payload } = event.payload;
    await this.dispatch(streamId, { ...event, payload }, actor.sub, operationId);
  }
}
