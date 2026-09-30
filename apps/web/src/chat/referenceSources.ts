import { useEffect, useMemo, useRef } from "react";
import { useStreamReducer } from "@eforest/web-hooks";
import type { RegistryState } from "@eforest/reducers";
import type { ReferenceOption, ReferenceSources } from "@brett_lamy/docstream-editor";
import { useAgentRoster, useHumanRoster, type HumanMember } from "../members/useRoster.js";
import { useChatCatalog } from "./useChat.js";

/**
 * Autocomplete sources for the chat composer: `@` people and agents, `#` channels,
 * `$` codebases — all replayed from the workspace's own streams (members door, agents
 * roster, chat catalog, registry). The editor builds its pickers once at mount, so the
 * sources are stable functions reading the latest options through a ref.
 */

const HANDLE_RE = /^[A-Za-z_][\w.-]*$/;

/** A human's @handle: their email's local part when it is a valid chip id. */
export function humanHandle(member: Pick<HumanMember, "sub" | "email">): string {
  const local =
    member.email
      ?.split("@")[0]
      ?.toLowerCase()
      .replace(/[^\w.-]/g, "") ?? "";
  if (HANDLE_RE.test(local)) return local;
  const tail = member.sub.split("|").pop() ?? member.sub;
  return `u_${tail.replace(/[^\w.-]/g, "").slice(0, 24)}`;
}

export interface ReferenceData {
  readonly mentions: readonly ReferenceOption[];
  readonly tags: readonly ReferenceOption[];
  readonly codebases: readonly ReferenceOption[];
}

export function filterReferenceOptions(
  options: readonly ReferenceOption[],
  query: string,
): ReferenceOption[] {
  const q = query.toLowerCase();
  return options.filter(
    (option) =>
      q.length === 0 ||
      option.id.toLowerCase().includes(q) ||
      (option.label ?? "").toLowerCase().includes(q),
  );
}

/** Codebases in this workspace by bare name; other workspaces' as `org/repo`. */
export function codebaseOptions(registry: RegistryState, org: string): ReferenceOption[] {
  const local = Object.keys(registry.orgs[org]?.repos ?? {})
    .sort()
    .map((repo) => ({ id: repo, description: org, group: "This workspace" }));
  const others = Object.entries(registry.orgs)
    .filter(([name]) => name !== org)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, state]) =>
      Object.keys(state.repos)
        .sort()
        .map((repo) => ({ id: `${name}/${repo}`, group: "Other workspaces" })),
    );
  return [...local, ...others];
}

export function useChatReferenceSources(org: string): ReferenceSources {
  const humans = useHumanRoster(org);
  const agents = useAgentRoster(org);
  const catalog = useChatCatalog(org);
  const registry = useStreamReducer<RegistryState>({
    apiPath: "/registry/me",
    streamId: "__registry__",
    reducerId: "registry",
    followWaitMs: 10_000,
  });

  const data = useMemo<ReferenceData>(() => {
    const people = (humans.snapshot?.humans ?? [])
      .filter((member) => member.status === "active")
      .map((member) => ({
        id: humanHandle(member),
        label: member.email ?? member.sub,
        group: "People",
      }));
    const bots = Object.values(agents.state.agents)
      .filter((agent) => !agent.removed)
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .map((agent) => ({
        id: agent.handle,
        label: agent.name,
        description: `agent · ${agent.harness}`,
        group: "Agents",
      }));
    const channels = Object.entries(catalog.projection.state.channels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, channel]) => ({
        id: name,
        ...(channel.topic ? { description: channel.topic } : {}),
      }));
    return {
      mentions: [...people, ...bots],
      tags: channels,
      codebases: codebaseOptions(registry.state, org),
    };
  }, [humans.snapshot, agents.state, catalog.projection.state, registry.state, org]);

  const latest = useRef(data);
  useEffect(() => {
    latest.current = data;
  }, [data]);

  return useMemo<ReferenceSources>(
    () => ({
      mentions: (query) => filterReferenceOptions(latest.current.mentions, query),
      tags: (query) => filterReferenceOptions(latest.current.tags, query),
      codebases: (query) => filterReferenceOptions(latest.current.codebases, query),
    }),
    [],
  );
}
