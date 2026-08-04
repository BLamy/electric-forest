import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";
import type { StreamRecord } from "@eforest/client";
import { createDurableStreamTestServer } from "@eforest/server";
import { OfficialStreamAdapter, RegistryProjector } from "@eforest/platform";
import { streamFsReducerDefinition } from "@eforest/reducers";
import { load as loadWorkspace } from "@eforest/workspace";
import { worktreeDigest } from "@eforest/streamfs";
import { runInit } from "./init-command.js";
import { storeCredentials } from "./credentials.js";

describe("ef init", () => {
  it("uploads through the dispatch seam and writes a digest-verified workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-init-"));
    const directory = join(root, "fixture");
    const secondDirectory = join(root, "fixture-second");
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
        await streams.append(request.streamId, event, {
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
      expect(metadata.some((record) => JSON.stringify(record).includes(".ef/"))).toBe(false);
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
      expect(
        registry
          .filter((record) => record.type === "registry.repo-added")
          .map(
            (record) => (record.payload as { readonly repoStreamPrefix: string }).repoStreamPrefix,
          )
          .sort(),
      ).toEqual(["fs:acme/garden", "fs:acme/second"]);
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
      expect(dispatches.filter(({ type }) => type === "ns.repo.create")).toHaveLength(2);
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
});
