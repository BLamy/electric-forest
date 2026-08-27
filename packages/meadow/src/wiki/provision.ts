import type { Event } from "@eforest/protocol";
import {
  BRANCH_EVENT_VERSION,
  branchMetadataStreamId,
  type FsBranchGenesisEvent,
} from "@eforest/streamfs";

export const WIKI_BRANCH_NAME = "wiki" as const;
export const WIKI_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const WIKI_ROUTE_CONTRACT = Object.freeze({
  index: "/orgs/:org/repos/:repo/wiki",
  page: "/orgs/:org/repos/:repo/wiki/:slug",
  edit: "/orgs/:org/repos/:repo/wiki/:slug/edit",
} as const);

export interface WikiBranchInspection {
  /** Undefined means that the branch stream does not exist. */
  readonly events: readonly Event[] | undefined;
}

/**
 * The capability supplied by the authenticated browser or platform composition.
 * Implementations inspect through the existing authorized read surface and dispatch
 * through the existing E0-T11 `/api/dispatch` door. Meadow owns neither transport.
 */
export interface WikiDispatchDoor {
  inspect(streamId: string): Promise<WikiBranchInspection>;
  dispatch(streamId: string, event: Event): Promise<unknown>;
}

export interface EnsureWikiBranchResult {
  readonly streamId: string;
  /** True only for the call that dispatched the branch genesis action. */
  readonly created: boolean;
}

export interface WikiProvisioner {
  ensureWikiBranch(org: string, repo: string): Promise<EnsureWikiBranchResult>;
}

function wikiGenesis(now: () => number): FsBranchGenesisEvent {
  return {
    type: "fs.branch.genesis",
    payload: { v: BRANCH_EVENT_VERSION, branch: WIKI_BRANCH_NAME },
    ts: now(),
  };
}

function payloadRecord(event: Event): Readonly<Record<string, unknown>> | undefined {
  return event.payload !== null &&
    typeof event.payload === "object" &&
    !Array.isArray(event.payload)
    ? (event.payload as Readonly<Record<string, unknown>>)
    : undefined;
}

function isWikiGenesis(event: Event | undefined): boolean {
  const payload = event === undefined ? undefined : payloadRecord(event);
  return (
    event?.type === "fs.branch.genesis" &&
    payload?.v === BRANCH_EVENT_VERSION &&
    payload.branch === WIKI_BRANCH_NAME
  );
}

function assertOrdinaryWikiBranch(streamId: string, events: readonly Event[]): void {
  if (!isWikiGenesis(events[0])) {
    throw new Error(`wiki branch ${streamId} is missing its frozen genesis event`);
  }
  if (events.some((event) => event.type === "fs.branch.fork")) {
    throw new Error(`wiki branch ${streamId} must not fork from another branch`);
  }
}

function assertNewWikiIsEmpty(streamId: string, events: readonly Event[]): void {
  assertOrdinaryWikiBranch(streamId, events);
  if (events.length !== 1) {
    throw new Error(`new wiki branch ${streamId} was not created empty`);
  }
}

async function inspectConcurrentWinner(
  streamId: string,
  door: WikiDispatchDoor,
): Promise<readonly Event[] | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const raced = await door.inspect(streamId);
    if (raced.events !== undefined) return raced.events;
    if (attempt < 19) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

/** The E2-T06 repo stream prefix narrowed to E1-T08's frozen branch stream formula. */
export function wikiBranchStreamId(org: string, repo: string): string {
  return branchMetadataStreamId(`${org}/${repo}`, WIKI_BRANCH_NAME);
}

export function isWikiSlug(value: unknown): value is string {
  return typeof value === "string" && WIKI_SLUG_PATTERN.test(value);
}

export function wikiPagePath(slug: string): string {
  if (!isWikiSlug(slug)) throw new TypeError(`invalid wiki slug ${JSON.stringify(slug)}`);
  return `${slug}.md`;
}

function routeBase(org: string, repo: string): string {
  return `/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/wiki`;
}

export function wikiIndexRoute(org: string, repo: string): string {
  return routeBase(org, repo);
}

export function wikiPageRoute(org: string, repo: string, slug: string): string {
  wikiPagePath(slug);
  return `${routeBase(org, repo)}/${encodeURIComponent(slug)}`;
}

export function wikiEditRoute(org: string, repo: string, slug: string): string {
  return `${wikiPageRoute(org, repo, slug)}/edit`;
}

/**
 * Provision through an injected authenticated door. Existing streams are only
 * inspected; no dispatch occurs, so repeated calls cannot append another genesis.
 */
export async function ensureWikiBranch(
  org: string,
  repo: string,
  door: WikiDispatchDoor,
  now: () => number = Date.now,
): Promise<EnsureWikiBranchResult> {
  const streamId = wikiBranchStreamId(org, repo);
  const before = await door.inspect(streamId);
  if (before.events !== undefined) {
    assertOrdinaryWikiBranch(streamId, before.events);
    return { streamId, created: false };
  }

  try {
    await door.dispatch(streamId, wikiGenesis(now));
  } catch (error) {
    // Two first-open callers may both observe absence before either dispatch
    // commits. The dispatch door arbitrates that race: the loser accepts the
    // winner's canonical genesis, but never hides an unrelated refusal.
    const raced = await inspectConcurrentWinner(streamId, door);
    if (raced === undefined) throw error;
    assertOrdinaryWikiBranch(streamId, raced);
    return { streamId, created: false };
  }
  const after = await door.inspect(streamId);
  if (after.events === undefined) {
    throw new Error(`wiki branch ${streamId} was not visible after dispatch`);
  }
  assertNewWikiIsEmpty(streamId, after.events);
  return { streamId, created: true };
}

/** Bind the door once so browser/platform consumers call ensureWikiBranch(org, repo). */
export function bindWikiProvisioningDoor(
  door: WikiDispatchDoor,
  options: { readonly now?: () => number } = {},
): WikiProvisioner {
  return {
    ensureWikiBranch: (org, repo) => ensureWikiBranch(org, repo, door, options.now ?? Date.now),
  };
}
