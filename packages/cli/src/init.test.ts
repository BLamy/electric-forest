import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import type { StreamRecord } from "@eforest/client";
import { createDurableStreamTestServer } from "@eforest/server";
import { OfficialStreamAdapter, RegistryProjector, tokenHash } from "@eforest/platform";
import { streamFsReducerDefinition } from "@eforest/reducers";
import { load as loadWorkspace } from "@eforest/workspace";
import { worktreeDigest } from "@eforest/streamfs";
import {
  awaitRegistryLength,
  registryHttpFixture,
  SUBJECTS,
} from "../../platform/test/registry.helpers.js";
import { runInit } from "./init-command.js";
import { storeCredentials } from "./credentials.js";

describe("ef init", () => {
  it("uploads through the dispatch seam and writes a digest-verified workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-init-"));
    const directory = join(root, "fixture");
    const secondDirectory = join(root, "fixture-second");
    const faultDirectory = join(root, "fixture-fault");
    const sameCollisionDirectory = join(root, "fixture-same-collision");
    const freshCollisionDirectory = join(root, "fixture-fresh-collision");
    const revokedDirectory = join(root, "fixture-revoked");
    const home = join(root, "home");
    const official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const streamUrl = await official.start();
    const streams = new OfficialStreamAdapter({ baseUrl: streamUrl });
    await streams.create("ns:root");
    await streams.create("ns:org:acme");
    await streams.append(
      "ns:root",
      {
        type: "ns.org.create",
        payload: { v: 1, name: "acme", actor: { sub: "auth0|owner" } },
        ts: 0,
      },
      { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
    );
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "nested", "hello.txt"), "hello\n");
    await writeFile(join(directory, "empty.bin"), Buffer.alloc(0));
    await storeCredentials(
      {
        accessToken: "token",
        tokenType: "Bearer",
        issuer: "https://issuer.test/",
        clientId: "eforest",
        scopes: ["repo:write"],
      },
      { EF_HOME: home },
    );
    const requests: string[] = [];
    const dispatches: Array<{ readonly streamId: string; readonly type: string }> = [];
    let namespaceLookups = 0;
    let refuseNextNamespace = false;
    let refuseRepo = false;
    let corruptWrite = false;
    let writerSequence = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.startsWith("/api/namespaces/")) {
        namespaceLookups += 1;
        if (refuseNextNamespace) {
          refuseNextNamespace = false;
          return Response.json({ error: { class: "token-revoked" } }, { status: 401 });
        }
        return Response.json({
          ok: true,
          resolution: {
            org: "acme",
            projects: namespaceLookups === 1 ? [] : ["forest"],
            repos: [],
          },
        });
      }
      if (url.pathname === "/api/dispatch") {
        const request = JSON.parse(String(init?.body)) as {
          readonly streamId: string;
          readonly event: {
            readonly type: string;
            readonly payload: Record<string, unknown>;
            readonly ts: number;
          };
        };
        if (refuseRepo && request.event.type === "ns.repo.create") {
          return Response.json({ error: { class: "ns/name-taken" } }, { status: 409 });
        }
        dispatches.push({ streamId: request.streamId, type: request.event.type });
        const existing = (await streams
          .read(request.streamId)
          .catch(() => [])) as readonly StreamRecord[];
        const event = request.streamId.startsWith("ns:")
          ? {
              ...request.event,
              payload: { ...request.event.payload, actor: { sub: "auth0|owner" } },
            }
          : {
              ...request.event,
              payload: {
                ...request.event.payload,
                actor: "auth0|owner",
                writer: { v: 1, sub: "auth0|owner", seq: (writerSequence += 1) },
              },
            };
        const persistedEvent =
          corruptWrite && request.event.type === "fs.file.write"
            ? {
                ...event,
                payload: { ...event.payload, contentSha256: "0".repeat(64) },
              }
            : event;
        await streams.append(request.streamId, persistedEvent, {
          sequence: offsetForOrdinal(existing.length),
          applicationOffset: offsetForOrdinal(existing.length),
        });
        return Response.json({ ok: true }, { status: 202 });
      }
      return fetch(input, init);
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const code = await runInit(
        ["--org", "acme", "--project", "forest", "--repo", "garden", directory],
        { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
        { EF_HOME: home, EF_SERVER_URL: "http://platform.test", EF_STREAM_SERVER_URL: streamUrl },
        fetcher,
      );
      expect(code, stderr.join("")).toBe(0);
      expect(stderr).toEqual([]);
      const metadata = (await streams.read("fs:acme/garden:main:meta")) as readonly StreamRecord[];
      expect(metadata[0]).toMatchObject({
        type: "fs.branch.genesis",
        payload: { branch: "main", v: 1 },
      });
      const state = metadata.reduce(
        (current, record) => streamFsReducerDefinition.reduce(current, record),
        streamFsReducerDefinition.initialState,
      ) as Parameters<typeof worktreeDigest>[0];
      expect(stdout).toEqual([`${worktreeDigest(state)}\n`]);
      const workspace = loadWorkspace(directory);
      expect(workspace.identity).toMatchObject({
        project: "forest",
        repo: "garden",
        branch: "main",
        metadataStreamId: "fs:acme/garden:main:meta",
      });
      expect(workspace.headOffset).toBe(metadata.at(-1)!.offset);
      expect(Object.keys(workspace.files)).toEqual(["empty.bin", "nested/hello.txt"]);
      expect(metadata.some((record) => canonicalJson(record).includes(".ef/"))).toBe(false);
      await mkdir(secondDirectory, { recursive: true });
      await writeFile(join(secondDirectory, "second.txt"), "second\n");
      const second = await runInit(
        ["--org", "acme", "--project", "forest", "--repo", "second", secondDirectory],
        { stdout: () => undefined, stderr: (text) => stderr.push(text) },
        { EF_HOME: home, EF_SERVER_URL: "http://platform.test", EF_STREAM_SERVER_URL: streamUrl },
        fetcher,
      );
      expect(second, stderr.join("")).toBe(0);
      expect(dispatches.filter(({ type }) => type === "ns.project.create")).toHaveLength(1);
      expect(dispatches.filter(({ type }) => type === "ns.repo.create")).toHaveLength(2);
      const projector = new RegistryProjector(streams);
      await projector.syncOnce();
      const registry = (await streams.read("__registry__")) as readonly StreamRecord[];
      const prefixes = registry
        .filter((record) => record.type === "registry.repo-added")
        .map(
          (record) => (record.payload as { readonly repoStreamPrefix: string }).repoStreamPrefix,
        );
      expect(new Set(prefixes)).toEqual(new Set(["fs:acme/garden", "fs:acme/second"]));
      await mkdir(faultDirectory, { recursive: true });
      await writeFile(join(faultDirectory, "corrupt.txt"), "must mismatch\n");
      corruptWrite = true;
      const fault = await runInit(
        ["--org", "acme", "--project", "forest", "--repo", "fault", faultDirectory],
        { stdout: () => undefined, stderr: (text) => stderr.push(text) },
        { EF_HOME: home, EF_SERVER_URL: "http://platform.test", EF_STREAM_SERVER_URL: streamUrl },
        fetcher,
      );
      corruptWrite = false;
      expect(fault).toBe(15);
      expect(existsSync(join(faultDirectory, ".ef"))).toBe(false);

      await mkdir(sameCollisionDirectory, { recursive: true });
      await writeFile(join(sameCollisionDirectory, "same.txt"), "collision\n");
      const sameNamespaceBefore = await streams.read("ns:org:acme");
      const sameDispatchCount = dispatches.length;
      const sameRequestCount = requests.length;
      refuseRepo = true;
      const sameCollision = await runInit(
        ["--org", "acme", "--project", "forest", "--repo", "garden", sameCollisionDirectory],
        { stdout: () => undefined, stderr: (text) => stderr.push(text) },
        { EF_HOME: home, EF_SERVER_URL: "http://platform.test", EF_STREAM_SERVER_URL: streamUrl },
        fetcher,
      );
      refuseRepo = false;
      expect(sameCollision).toBe(1);
      expect(requests.length - sameRequestCount).toBe(2);
      expect(dispatches.length).toBe(sameDispatchCount);
      expect(await streams.read("ns:org:acme")).toEqual(sameNamespaceBefore);
      expect(existsSync(join(sameCollisionDirectory, ".ef"))).toBe(false);

      await mkdir(freshCollisionDirectory, { recursive: true });
      await writeFile(join(freshCollisionDirectory, "fresh.txt"), "collision\n");
      const freshNamespaceBefore = await streams.read("ns:org:acme");
      const freshProjectCount = dispatches.filter(
        ({ type }) => type === "ns.project.create",
      ).length;
      const freshRepoCount = dispatches.filter(({ type }) => type === "ns.repo.create").length;
      refuseRepo = true;
      const freshCollision = await runInit(
        [
          "--org",
          "acme",
          "--project",
          "fresh-project",
          "--repo",
          "garden",
          freshCollisionDirectory,
        ],
        { stdout: () => undefined, stderr: (text) => stderr.push(text) },
        { EF_HOME: home, EF_SERVER_URL: "http://platform.test", EF_STREAM_SERVER_URL: streamUrl },
        fetcher,
      );
      refuseRepo = false;
      expect(freshCollision).toBe(1);
      expect(dispatches.filter(({ type }) => type === "ns.project.create")).toHaveLength(
        freshProjectCount + 1,
      );
      expect(dispatches.filter(({ type }) => type === "ns.repo.create")).toHaveLength(
        freshRepoCount,
      );
      const freshNamespaceAfter = await streams.read("ns:org:acme");
      expect(freshNamespaceAfter.length).toBe(freshNamespaceBefore.length + 1);
      expect(freshNamespaceAfter.at(-1)).toMatchObject({ type: "ns.project.create" });
      expect(existsSync(join(freshCollisionDirectory, ".ef"))).toBe(false);
      await mkdir(revokedDirectory, { recursive: true });
      await writeFile(join(revokedDirectory, "revoked.txt"), "refused\n");
      refuseNextNamespace = true;
      const revoked = await runInit(
        ["--org", "acme", "--project", "forest", "--repo", "revoked", revokedDirectory],
        { stdout: () => undefined, stderr: (text) => stderr.push(text) },
        { EF_HOME: home, EF_SERVER_URL: "http://platform.test", EF_STREAM_SERVER_URL: streamUrl },
        fetcher,
      );
      expect(revoked).toBe(13);
      expect(existsSync(join(revokedDirectory, ".ef"))).toBe(false);
      expect(dispatches.filter(({ type }) => type === "ns.repo.create")).toHaveLength(3);
      const before = requests.length;
      const already = await runInit(
        ["--org", "acme", directory],
        { stdout: () => undefined, stderr: (text) => stderr.push(text) },
        { EF_HOME: home, EF_SERVER_URL: "http://platform.test", EF_STREAM_SERVER_URL: streamUrl },
        fetcher,
      );
      expect(already).toBe(14);
      expect(requests.length).toBe(before);
    } finally {
      await official.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes an adopted repo through the real gateway and registry door", async () => {
    const fixture = await registryHttpFixture();
    const root = await mkdtemp(join(tmpdir(), "eforest-init-gateway-"));
    const directory = join(root, "gateway-fixture");
    const home = join(root, "home");
    const subject = SUBJECTS.alice;
    try {
      await fixture.identity.ensureUser(subject, "alice@example.test");
      await fixture.identity.createOrg("acme", "acme", subject);
      const token = fixture.grantlessToken(subject);
      await fixture.identity.issueCliGrant({
        grantId: "init-gateway-grant",
        sub: subject,
        tokenKind: "device",
        tokenHash: tokenHash(token),
        scopes: ["repo:write:acme/adopted:main"],
      });
      const org = await fetch(`${fixture.baseUrl}/api/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: canonicalJson({
          streamId: "ns:root",
          event: { type: "ns.org.create", payload: { v: 1, name: "acme" }, ts: 1 },
        }),
      });
      expect(org.status).toBe(202);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "gateway.txt"), "gateway\n");
      await storeCredentials(
        {
          accessToken: token,
          tokenType: "Bearer",
          issuer: "https://registry.test/",
          clientId: "eforest-api",
          scopes: ["repo:write"],
        },
        { EF_HOME: home },
      );
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runInit(
        ["--org", "acme", "--project", "gateway", "--repo", "adopted", directory],
        { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
        {
          EF_HOME: home,
          EF_SERVER_URL: fixture.baseUrl,
          EF_STREAM_SERVER_URL: fixture.officialUrl,
        },
      );
      expect(code, stderr.join("")).toBe(0);
      expect(stdout).toHaveLength(1);
      await awaitRegistryLength(fixture, 3);
      const listing = await fetch(`${fixture.baseUrl}/registry/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listing.status).toBe(200);
      const body = (await listing.json()) as {
        readonly entries: readonly {
          readonly repo: string;
          readonly repoStreamPrefix: string;
        }[];
      };
      expect(body.entries).toContainEqual({
        org: "acme",
        project: "gateway",
        repo: "adopted",
        visibility: "private",
        owner: subject,
        repoStreamPrefix: "fs:acme/adopted",
      });
      const revoked = await fetch(`${fixture.baseUrl}/registry/me`, {
        headers: { authorization: `Bearer ${fixture.grantlessToken(subject)}` },
      });
      expect(revoked.status).toBe(401);
    } finally {
      await fixture.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
