import { isDurableNotFound } from "@eforest/client";
import { stateDigest, type Event } from "@eforest/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  composeNamespaceView,
  namespaceViewDigest,
  type NamespaceVisibility,
} from "../src/index.js";
import {
  dispatch,
  namespaceHttpFixture,
  nsEvent,
  type NamespaceHttpFixture,
} from "./ns.helpers.js";

const SEEDS = [0x06e2_0001, 0x06e2_0002, 0x06e2_0003, 0x06e2_0004, 0x06e2_0005] as const;
const fuzzEvidencePath =
  ".eforest/tasks/epic-2-the-gates/E2-T06-stream-namespaces/evidence/e2-t06-fuzz.txt";
const fuzzEvidence = new Map(
  readFileSync(fuzzEvidencePath, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("seed="))
    .map((line) => [Number(line.match(/^seed=(\d+)/)?.[1]), line] as const),
);

const INVALID_NAMES = [
  { name: "", reason: "ns/invalid-name" },
  { name: "UPPER", reason: "ns/invalid-name" },
  { name: "a--b", reason: "ns/invalid-name" },
  { name: "-leading", reason: "ns/invalid-name" },
  { name: "trailing-", reason: "ns/invalid-name" },
  { name: "a/b", reason: "ns/invalid-name" },
  { name: "..", reason: "ns/invalid-name" },
  { name: "a b", reason: "ns/invalid-name" },
  { name: "a\u0000b", reason: "ns/invalid-name" },
  { name: "__x__", reason: "ns/invalid-name" },
  { name: "\u0430", reason: "ns/invalid-name" },
  { name: "\u03bfrg", reason: "ns/invalid-name" },
  { name: "x".repeat(41), reason: "ns/invalid-name" },
  { name: "main", reason: "ns/reserved-name" },
  { name: "ns", reason: "ns/reserved-name" },
  { name: "fs", reason: "ns/reserved-name" },
] as const;

interface ModelProject {
  readonly owner: string;
}

interface ModelRepo {
  readonly owner: string;
  readonly project: string;
  readonly visibility: NamespaceVisibility;
}

interface ModelOrg {
  readonly owner: string;
  readonly projects: Record<string, ModelProject>;
  readonly repos: Record<string, ModelRepo>;
}

interface ModelView {
  readonly orgs: Record<string, ModelOrg>;
}

interface FuzzContext {
  readonly fixture: NamespaceHttpFixture;
  readonly model: ModelView;
  readonly random: () => number;
  ordinal: number;
}

const fixtures: NamespaceHttpFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.stop()));
});

function xorshift(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function slug(prefix: string, seed: number, ordinal: number): string {
  return `${prefix}-${seed.toString(36)}-${ordinal.toString(36)}`;
}

async function readOrEmpty(
  fixture: NamespaceHttpFixture,
  streamId: string,
): Promise<readonly unknown[]> {
  try {
    return await fixture.streams.read(streamId);
  } catch (error) {
    if (isDurableNotFound(error)) return [];
    throw error;
  }
}

async function namespaceSnapshot(context: FuzzContext): Promise<Readonly<Record<string, unknown>>> {
  const streamIds = [
    "ns:root",
    ...Object.keys(context.model.orgs)
      .sort()
      .map((org) => `ns:org:${org}`),
  ];
  return Object.fromEntries(
    await Promise.all(
      streamIds.map(async (streamId) => [streamId, await readOrEmpty(context.fixture, streamId)]),
    ),
  );
}

async function send(
  context: FuzzContext,
  streamId: string,
  type: string,
  payload: unknown,
  sub: string,
): Promise<Response> {
  const response = await dispatch(
    context.fixture,
    streamId,
    nsEvent(type, payload, context.ordinal++),
    sub,
  );
  expect(response.status, `seed dispatch ${type} ${JSON.stringify(payload)}`).toBeLessThan(500);
  return response;
}

async function expectRefusal(
  context: FuzzContext,
  streamId: string,
  type: string,
  payload: unknown,
  sub: string,
  reason: string,
): Promise<void> {
  const before = await namespaceSnapshot(context);
  const response = await send(context, streamId, type, payload, sub);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: { class: "validator-rejected", reason } });
  expect(await namespaceSnapshot(context)).toEqual(before);
}

async function createOrg(context: FuzzContext, name: string, sub: string): Promise<void> {
  const response = await send(context, "ns:root", "ns.org.create", { v: 1, name }, sub);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ ok: true, actor: sub });
  context.model.orgs[name] = { owner: sub, projects: {}, repos: {} };
}

async function createProject(
  context: FuzzContext,
  org: string,
  name: string,
  sub: string,
): Promise<void> {
  const response = await send(context, `ns:org:${org}`, "ns.project.create", { v: 1, name }, sub);
  expect(response.status).toBe(202);
  context.model.orgs[org]!.projects[name] = { owner: sub };
}

async function createRepo(
  context: FuzzContext,
  org: string,
  name: string,
  project: string,
  visibility: NamespaceVisibility,
  sub: string,
): Promise<void> {
  const response = await send(
    context,
    `ns:org:${org}`,
    "ns.repo.create",
    { v: 1, name, project, visibility },
    sub,
  );
  expect(response.status).toBe(202);
  context.model.orgs[org]!.repos[name] = { owner: sub, project, visibility };
}

async function actualView(context: FuzzContext) {
  const root = (await context.fixture.streams.read("ns:root")) as readonly Event[];
  const orgStreams = Object.fromEntries(
    await Promise.all(
      Object.keys(context.model.orgs).map(async (org) => [
        `ns:org:${org}`,
        await context.fixture.streams.read(`ns:org:${org}`),
      ]),
    ),
  );
  return composeNamespaceView(root, orgStreams);
}

describe("namespace seeded fuzz differential", () => {
  it.each(SEEDS)("survives seed %s with refusal neutrality and oracle parity", async (seed) => {
    const fixture = await namespaceHttpFixture();
    fixtures.push(fixture);
    const context: FuzzContext = {
      fixture,
      model: { orgs: {} },
      random: xorshift(seed),
      ordinal: 0,
    };
    const ownerA = `auth0|fuzz-${seed}-a`;
    const ownerB = `auth0|fuzz-${seed}-b`;
    const orgs = [slug("org", seed, 0), slug("org", seed, 1)] as const;

    for (const [index, org] of orgs.entries()) {
      const owner = index === 0 ? ownerA : ownerB;
      await createOrg(context, org, owner);
      const projects = [slug("project", seed, index * 2), slug("project", seed, index * 2 + 1)];
      for (const project of projects) await createProject(context, org, project, owner);
      for (let repoIndex = 0; repoIndex < 4; repoIndex += 1) {
        const project = projects[context.random() % projects.length]!;
        const visibility = (context.random() & 1) === 0 ? "public" : "private";
        await createRepo(
          context,
          org,
          slug("repo", seed, index * 4 + repoIndex),
          project,
          visibility,
          repoIndex % 2 === 0 ? ownerA : ownerB,
        );
      }
    }

    // A 40-byte boundary slug is valid; the adjacent 41-byte candidate is in the
    // invalid corpus below.
    const boundary = "z".repeat(40);
    await createOrg(context, boundary, ownerA);

    await expectRefusal(
      context,
      "ns:root",
      "ns.org.create",
      { v: 1, name: orgs[0] },
      ownerB,
      "ns/name-taken",
    );
    const firstProject = Object.keys(context.model.orgs[orgs[0]]!.projects)[0]!;
    const firstRepo = Object.keys(context.model.orgs[orgs[0]]!.repos)[0]!;
    await expectRefusal(
      context,
      `ns:org:${orgs[0]}`,
      "ns.project.create",
      { v: 1, name: firstProject },
      ownerA,
      "ns/name-taken",
    );
    await expectRefusal(
      context,
      `ns:org:${orgs[0]}`,
      "ns.repo.create",
      { v: 1, name: firstRepo, project: firstProject, visibility: "private" },
      ownerA,
      "ns/name-taken",
    );
    await expectRefusal(
      context,
      `ns:org:${orgs[0]}`,
      "ns.repo.create",
      { v: 1, name: slug("missing-project", seed, 0), project: "absent", visibility: "public" },
      ownerA,
      "ns/project-not-found",
    );
    await expectRefusal(
      context,
      `ns:org:${slug("missing-org", seed, 0)}`,
      "ns.project.create",
      { v: 1, name: "valid-name" },
      ownerA,
      "ns/org-not-found",
    );

    const rotatedInvalid = INVALID_NAMES.map(
      (_, index) =>
        INVALID_NAMES[(index + (context.random() % INVALID_NAMES.length)) % INVALID_NAMES.length]!,
    );
    for (const candidate of rotatedInvalid) {
      await expectRefusal(
        context,
        "ns:root",
        "ns.org.create",
        { v: 1, name: candidate.name },
        ownerA,
        candidate.reason,
      );
    }

    const actual = await actualView(context);
    expect(actual).toEqual(context.model);
    const viewDigest = namespaceViewDigest(actual);
    const oracleDigest = stateDigest(context.model);
    expect(viewDigest).toBe(oracleDigest);
    expect(viewDigest).toMatch(/^[0-9a-f]{64}$/);
    const evidenceLine = `seed=${seed} accepted=15 refusals=21 zero-5xx=true view-digest=${viewDigest} oracle-digest=${oracleDigest}`;
    if (process.env.PRINT_E2_T06_EVIDENCE === "1") process.stdout.write(`${evidenceLine}\n`);
    expect(evidenceLine).toBe(fuzzEvidence.get(seed));
  });
});
import { readFileSync } from "node:fs";
