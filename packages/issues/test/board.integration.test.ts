import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  boardCachePath,
  IssueBoardMaterializer,
  OfficialStreamAdapter,
  PlatformGateway,
  type AuthzInput,
  type AuthorizationVerifier,
} from "@eforest/platform";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  boardDigest,
  deriveBoard,
  ISSUE_CATALOG_EVENT,
  repoIssuesStreamId,
  repoLabelsStreamId,
  replayIssueCatalog,
  type IssueLog,
} from "../src/index.js";
import {
  canonicalJson,
  OFFSET_BEFORE_FIRST,
  stateDigest,
  type Event,
  type Offset,
} from "@eforest/protocol";
import { offsetForOrdinal } from "@eforest/protocol/offset-allocation";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

const verifier: AuthorizationVerifier = {
  verifyAuthorization: async () => ({ sub: "alice" }),
};

function allow(input: AuthzInput) {
  return {
    allowed: true as const,
    operation: input.operation,
    identityOffset: input.identityOffset,
    basis: "grant:write" as const,
    streamId: "streamId" in input.target ? input.target.streamId : "",
  };
}

function event(type: string, payload: Record<string, unknown>, ts: number): Event {
  return { type, payload, ts };
}

class FailOnceIssueAppendAdapter extends OfficialStreamAdapter {
  private armed = true;

  constructor(
    baseUrl: string,
    private readonly failingStreamId: string,
  ) {
    super({ baseUrl });
  }

  override async append(
    streamId: string,
    current: Event,
    options?: Parameters<OfficialStreamAdapter["append"]>[2],
  ) {
    if (this.armed && streamId === this.failingStreamId) {
      this.armed = false;
      throw new Error("injected issue append failure");
    }
    return super.append(streamId, current, options);
  }
}

async function coldBoard(
  streams: OfficialStreamAdapter,
  org: string,
  repo: string,
): Promise<ReturnType<typeof deriveBoard>> {
  const catalogStream = repoIssuesStreamId(org, repo);
  const catalogRecords = (await streams.exists(catalogStream))
    ? ((await streams.read(catalogStream)) as Event[])
    : [];
  const catalog = replayIssueCatalog(catalogStream, catalogRecords);
  const labelRecords = (await streams.read(repoLabelsStreamId(org, repo))) as Event[];
  const issueLogs: IssueLog[] = [];
  for (const streamId of Object.keys(catalog.issues).sort()) {
    issueLogs.push({ streamId, events: (await streams.read(streamId)) as Event[] });
  }
  return deriveBoard(labelRecords, issueLogs);
}

describe("issue board server integration", () => {
  it("keeps incremental output equal to cold replay across a mixed 61-event run", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "eforest-e5-t03-store-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "eforest-e5-t03-cache-"));
    scratch.push(dataDir, cacheDir);
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0, dataDir });
    const baseUrl = await server.start();
    const streams = new OfficialStreamAdapter({ baseUrl });
    const materializer = new IssueBoardMaterializer({ streams, cacheDir });
    const gateway = new PlatformGateway({
      verifier,
      streams,
      decideAuthorization: allow,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      issueBoards: materializer,
    });
    const org = "maple";
    const repo = "reading-room";
    const labelStream = repoLabelsStreamId(org, repo);
    const issueStreams = Array.from(
      { length: 12 },
      (_, index) => `issue:${org}/${repo}/i-${String(index).padStart(2, "0")}`,
    );
    await streams.create(labelStream);
    for (const streamId of issueStreams) await streams.create(streamId);

    let acceptedDispatches = 0;
    const dispatch = async (streamId: string, current: Event) => {
      const activityBefore = materializer.materializationActivity(org, repo);
      const response = await gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
            "x-eforest-dispatch-receipt": "offset",
          },
          body: JSON.stringify({ streamId, event: current }),
        }),
      );
      const receiptSource = await response.text();
      expect(response.status, receiptSource).toBe(202);
      const receipt = JSON.parse(receiptSource) as { readonly offset: Offset };
      const maintained = materializer.materializedCopy(org, repo);
      expect(maintained, "post-append hook must maintain a copy before GET").toBeDefined();
      const activityAfterDispatch = materializer.materializationActivity(org, repo);
      if (acceptedDispatches === 0) {
        expect(activityAfterDispatch).toEqual({ coldRebuilds: 1, incrementalUpdates: 0 });
      } else {
        expect(activityAfterDispatch).toEqual({
          coldRebuilds: activityBefore.coldRebuilds,
          incrementalUpdates: activityBefore.incrementalUpdates + 1,
        });
      }
      acceptedDispatches += 1;
      const cold = await coldBoard(streams, org, repo);
      expect(maintained?.digest).toBe(boardDigest(cold));
      expect(
        maintained?.provenance.inputs.find((input) => input.streamId === streamId)?.offset,
      ).toBe(receipt.offset);
      const boardResponse = await gateway.handle(
        new Request(`https://platform.test/api/repos/${org}/${repo}/board`, {
          headers: { authorization: "Bearer test" },
        }),
      );
      expect(boardResponse.status).toBe(200);
      const source = await boardResponse.text();
      expect(source).toBe(canonicalJson(JSON.parse(source)));
      const body = JSON.parse(source) as { readonly digest: string };
      expect(Object.keys(JSON.parse(source) as object).sort()).toEqual([
        "board",
        "digest",
        "provenance",
      ]);
      expect(body.digest).toBe(boardDigest(cold));
      expect(materializer.materializationActivity(org, repo)).toEqual(activityAfterDispatch);
      return {
        receipt,
        source,
        body,
      };
    };

    let ts = 1;
    try {
      for (let index = 0; index < 5; index += 1) {
        await dispatch(
          labelStream,
          event(
            "label.created",
            {
              v: 1,
              labelId: `label-${index}`,
              name: index === 0 ? "B" : index === 1 ? "a" : `Label ${index}`,
              color: `#00000${index}`,
            },
            ts++,
          ),
        );
      }
      await dispatch(
        labelStream,
        event("label.renamed", { v: 1, labelId: "label-0", name: "Defect" }, ts++),
      );
      await dispatch(
        labelStream,
        event("label.recolored", { v: 1, labelId: "label-1", color: "#abcdef" }, ts++),
      );
      for (const [index, streamId] of issueStreams.entries()) {
        await dispatch(
          streamId,
          event("issue.opened", { v: 1, title: `Issue ${index}`, body: "" }, ts++),
        );
      }
      for (const [index, streamId] of issueStreams.entries()) {
        await dispatch(
          streamId,
          event("issue.labeled", { v: 1, label: `label-${index % 5}` }, ts++),
        );
      }
      const destinations = ["in-progress", "done", "wont-do"] as const;
      for (const [index, streamId] of issueStreams.entries()) {
        await dispatch(
          streamId,
          event(
            "issue.state-changed",
            { v: 1, to: destinations[index % destinations.length] },
            ts++,
          ),
        );
      }
      for (const [index, streamId] of issueStreams.entries()) {
        const before = await gateway.handle(
          new Request(`https://platform.test/api/repos/${org}/${repo}/board`, {
            headers: { authorization: "Bearer test" },
          }),
        );
        const beforeDigest = ((await before.json()) as { digest: string }).digest;
        const result = await dispatch(
          streamId,
          event(
            "issue.commented",
            { v: 1, commentId: `comment-${index}`, body: "board-neutral" },
            ts++,
          ),
        );
        expect(result.body.digest).toBe(beforeDigest);
      }
      for (const [index, streamId] of issueStreams.entries()) {
        if (index % 2 === 0) {
          await dispatch(
            streamId,
            event("issue.unlabeled", { v: 1, label: `label-${index % 5}` }, ts++),
          );
        }
      }

      expect(acceptedDispatches).toBe(61);
      expect(materializer.materializationActivity(org, repo)).toEqual({
        coldRebuilds: 1,
        incrementalUpdates: 60,
      });
      const memoryPoison = materializer.materializedCopy(org, repo)!;
      const healthyDigest = memoryPoison.digest;
      (memoryPoison.board.labels["label-0"] as { name: string }).name = "Poisoned";
      (memoryPoison as { digest: string }).digest = boardDigest(memoryPoison.board);
      expect(memoryPoison.digest).toBe(boardDigest(memoryPoison.board));
      expect(memoryPoison.digest).not.toBe(healthyDigest);
      const afterMemoryPoison = await gateway.handle(
        new Request(`https://platform.test/api/repos/${org}/${repo}/board`, {
          headers: { authorization: "Bearer test" },
        }),
      );
      expect(((await afterMemoryPoison.json()) as { digest: string }).digest).toBe(healthyDigest);
      expect(materializer.materializedCopy(org, repo)?.digest).toBe(healthyDigest);
      expect(materializer.materializationActivity(org, repo)).toEqual({
        coldRebuilds: 2,
        incrementalUpdates: 60,
      });

      const path = boardCachePath(cacheDir, org, repo);
      const beforeBytes = readFileSync(path, "utf8");
      const beforeBody = JSON.parse(beforeBytes) as { digest: string };
      expect(materializer.materializedCopy(org, repo)?.digest).toBe(beforeBody.digest);
      materializer.dropMaterializedCopy(org, repo);
      expect(materializer.materializedCopy(org, repo)).toBeUndefined();
      rmSync(path);
      const rebuilt = await gateway.handle(
        new Request(`https://platform.test/api/repos/${org}/${repo}/board`, {
          headers: { authorization: "Bearer test" },
        }),
      );
      expect(((await rebuilt.json()) as { digest: string }).digest).toBe(beforeBody.digest);
      expect(materializer.materializedCopy(org, repo)?.digest).toBe(beforeBody.digest);
      expect(materializer.materializationActivity(org, repo).coldRebuilds).toBe(3);

      writeFileSync(path, "{garbage", "utf8");
      materializer.dropMaterializedCopy(org, repo);
      expect(materializer.materializedCopy(org, repo)).toBeUndefined();
      const afterGarbage = await gateway.handle(
        new Request(`https://platform.test/api/repos/${org}/${repo}/board`, {
          headers: { authorization: "Bearer test" },
        }),
      );
      expect(((await afterGarbage.json()) as { digest: string }).digest).toBe(beforeBody.digest);
      expect(materializer.materializedCopy(org, repo)?.digest).toBe(beforeBody.digest);
      expect(materializer.materializationActivity(org, repo).coldRebuilds).toBe(4);

      const poison = {
        board: { poisoned: true },
        digest: stateDigest({ poisoned: true }),
        provenance: { inputs: [] },
      };
      writeFileSync(path, `${canonicalJson(poison)}\n`, "utf8");
      materializer.dropMaterializedCopy(org, repo);
      expect(materializer.materializedCopy(org, repo)).toBeUndefined();
      const afterPoison = await gateway.handle(
        new Request(`https://platform.test/api/repos/${org}/${repo}/board`, {
          headers: { authorization: "Bearer test" },
        }),
      );
      const replayed = (await afterPoison.json()) as {
        digest: string;
        provenance: { inputs: Array<{ streamId: string; offset: string }> };
      };
      expect(replayed.digest).toBe(beforeBody.digest);
      expect(materializer.materializedCopy(org, repo)?.digest).toBe(beforeBody.digest);
      expect(materializer.materializationActivity(org, repo)).toEqual({
        coldRebuilds: 5,
        incrementalUpdates: 60,
      });
      expect(replayed.provenance.inputs).toHaveLength(issueStreams.length + 2);
      for (const input of replayed.provenance.inputs) {
        const records = await streams.read(input.streamId);
        expect(input.offset).toBe(
          records.length === 0 ? "-1" : offsetForOrdinal(records.length - 1),
        );
      }
    } finally {
      gateway.terminate();
      await server.stop();
    }
  });

  it("reconciles catalog provenance after discovery commits but the issue append fails", async () => {
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const baseUrl = await server.start();
    const org = "maple";
    const repo = "failed-open";
    const labelStream = repoLabelsStreamId(org, repo);
    const catalogStream = repoIssuesStreamId(org, repo);
    const issueStream = `issue:${org}/${repo}/i`;
    const streams = new FailOnceIssueAppendAdapter(baseUrl, issueStream);
    const materializer = new IssueBoardMaterializer({ streams });
    const gateway = new PlatformGateway({
      verifier,
      streams,
      decideAuthorization: allow,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      issueBoards: materializer,
    });
    const post = (streamId: string, current: Event) =>
      gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify({ streamId, event: current }),
        }),
      );

    try {
      await streams.create(labelStream);
      await streams.create(issueStream);
      expect(
        (
          await post(
            labelStream,
            event("label.created", { v: 1, labelId: "bug", name: "Bug", color: "red" }, 1),
          )
        ).status,
      ).toBe(202);
      expect(materializer.materializationActivity(org, repo)).toEqual({
        coldRebuilds: 1,
        incrementalUpdates: 0,
      });

      const failed = await post(
        issueStream,
        event("issue.opened", { v: 1, title: "Not committed", body: "" }, 2),
      );
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({
        error: { code: "dispatch_failed", reason: "official_stream_append_failed" },
      });
      expect(await streams.read(issueStream)).toEqual([]);
      expect(await streams.read(catalogStream)).toHaveLength(1);
      expect(
        materializer
          .materializedCopy(org, repo)
          ?.provenance.inputs.find((input) => input.streamId === catalogStream)?.offset,
      ).toBe(OFFSET_BEFORE_FIRST);

      const recovered = await post(
        labelStream,
        event("label.created", { v: 1, labelId: "docs", name: "Docs", color: "blue" }, 3),
      );
      expect(recovered.status).toBe(202);
      expect(materializer.materializationActivity(org, repo)).toEqual({
        coldRebuilds: 2,
        incrementalUpdates: 0,
      });
      const maintained = materializer.materializedCopy(org, repo)!;
      expect(
        maintained.provenance.inputs.find((input) => input.streamId === catalogStream)?.offset,
      ).toBe(offsetForOrdinal(0));
      expect(maintained.digest).toBe(boardDigest(await coldBoard(streams, org, repo)));

      expect(
        (
          await post(
            issueStream,
            event("issue.opened", { v: 1, title: "Committed retry", body: "" }, 4),
          )
        ).status,
      ).toBe(202);
      expect(materializer.materializationActivity(org, repo)).toEqual({
        coldRebuilds: 2,
        incrementalUpdates: 1,
      });
      expect(
        materializer
          .materializedCopy(org, repo)
          ?.provenance.inputs.find((input) => input.streamId === issueStream)?.offset,
      ).toBe(offsetForOrdinal(0));
    } finally {
      gateway.terminate();
      await server.stop();
    }
  });

  it("refuses unknown labelId before the issue stream append", async () => {
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const baseUrl = await server.start();
    const streams = new OfficialStreamAdapter({ baseUrl });
    const gateway = new PlatformGateway({
      verifier,
      streams,
      decideAuthorization: allow,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const streamId = "issue:maple/reading-room/unknown-label";
    try {
      await streams.create(repoLabelsStreamId("maple", "reading-room"));
      await streams.create(streamId);
      const post = (current: Event) =>
        gateway.handle(
          new Request("https://platform.test/api/dispatch", {
            method: "POST",
            headers: { authorization: "Bearer test", "content-type": "application/json" },
            body: JSON.stringify({ streamId, event: current }),
          }),
        );
      expect((await post(event("issue.opened", { v: 1, title: "x", body: "" }, 1))).status).toBe(
        202,
      );
      const before = await streams.read(streamId);
      const refused = await post(event("issue.labeled", { v: 1, label: "missing" }, 2));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error: { class: "validator-rejected", reason: "issue/unknown-label" },
      });
      expect(await streams.read(streamId)).toEqual(before);
    } finally {
      gateway.terminate();
      await server.stop();
    }
  });

  it("preserves the E5-T01 close/reopen/refusal lifecycle through the default real-provider gateway", async () => {
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const baseUrl = await server.start();
    const streams = new OfficialStreamAdapter({ baseUrl });
    const gateway = new PlatformGateway({
      verifier,
      streams,
      decideAuthorization: allow,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const org = "maple";
    const repo = "default-lifecycle";
    const labelStream = repoLabelsStreamId(org, repo);
    const issueStream = `issue:${org}/${repo}/i`;
    const post = (streamId: string, current: Event) =>
      gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify({ streamId, event: current }),
        }),
      );
    try {
      await streams.create(labelStream);
      await streams.create(issueStream);
      expect(
        (
          await post(
            labelStream,
            event("label.created", { v: 1, labelId: "bug", name: "Bug", color: "red" }, 1),
          )
        ).status,
      ).toBe(202);
      expect(
        (await post(issueStream, event("issue.opened", { v: 1, title: "Lifecycle", body: "" }, 2)))
          .status,
      ).toBe(202);

      const refuseWithoutAppend = async (current: Event, reason: string) => {
        const before = await streams.read(issueStream);
        const response = await post(issueStream, current);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: { class: "validator-rejected", reason },
        });
        expect(await streams.read(issueStream)).toEqual(before);
      };
      await refuseWithoutAppend(
        event("issue.opened", { v: 1, title: "Again", body: "" }, 3),
        "issue/already-opened",
      );
      expect(
        (await post(issueStream, event("issue.labeled", { v: 1, label: "bug" }, 4))).status,
      ).toBe(202);
      expect((await post(issueStream, event("issue.closed", { v: 1 }, 5))).status).toBe(202);
      await refuseWithoutAppend(event("issue.closed", { v: 1 }, 6), "issue/illegal-transition");
      expect((await post(issueStream, event("issue.reopened", { v: 1 }, 7))).status).toBe(202);
      expect(
        (await post(issueStream, event("issue.unlabeled", { v: 1, label: "bug" }, 8))).status,
      ).toBe(202);
      await refuseWithoutAppend(
        event("issue.unlabeled", { v: 1, label: "bug" }, 9),
        "issue/missing-label",
      );
      await refuseWithoutAppend(
        event("issue.labeled", { v: 1, label: "unknown" }, 10),
        "issue/unknown-label",
      );

      const body = (await (
        await gateway.handle(
          new Request(`https://platform.test/api/repos/${org}/${repo}/board`, {
            headers: { authorization: "Bearer test" },
          }),
        )
      ).json()) as { board: { columns: { open: { issues: string[] } } } };
      expect(body.board.columns.open.issues).toEqual(["i"]);
      expect((await streams.read(repoIssuesStreamId(org, repo))).length).toBe(1);
      expect((await streams.read(issueStream)).map((record) => (record as Event).type)).toEqual([
        "issue.opened",
        "issue.labeled",
        "issue.closed",
        "issue.reopened",
        "issue.unlabeled",
      ]);
    } finally {
      gateway.terminate();
      await server.stop();
    }
  });

  it("keeps repo issue catalogs gateway-internal and log-neutral on public dispatch", async () => {
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const baseUrl = await server.start();
    const streams = new OfficialStreamAdapter({ baseUrl });
    const gateway = new PlatformGateway({
      verifier,
      streams,
      decideAuthorization: allow,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const streamId = repoIssuesStreamId("maple", "internal-catalog");
    const post = (current: Event) =>
      gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify({ streamId, event: current }),
        }),
      );
    try {
      await streams.create(streamId);
      const before = await streams.read(streamId);
      for (const current of [
        event(
          ISSUE_CATALOG_EVENT,
          {
            v: 1,
            issueStreamId: "issue:maple/internal-catalog/i",
            sourceOffset: offsetForOrdinal(0),
          },
          1,
        ),
        event(ISSUE_CATALOG_EVENT, { v: 1, issueStreamId: 42, sourceOffset: "garbage" }, 2),
      ]) {
        const response = await post(current);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: {
            code: "authz_refused",
            reason: "authz/not-found",
            identityOffset: "-1",
          },
        });
        expect(await streams.read(streamId)).toEqual(before);
      }
    } finally {
      gateway.terminate();
      await server.stop();
    }
  });

  it("enforces every label refusal log-neutrally through the real gateway and accepts case variants", async () => {
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const baseUrl = await server.start();
    const streams = new OfficialStreamAdapter({ baseUrl });
    const gateway = new PlatformGateway({
      verifier,
      streams,
      decideAuthorization: allow,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
    });
    const streamId = repoLabelsStreamId("maple", "label-refusals");
    const post = (current: Event) =>
      gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify({ streamId, event: current }),
        }),
      );
    let ts = 1;
    try {
      await streams.create(streamId);
      expect(
        (
          await post(
            event("label.created", { v: 1, labelId: "bug", name: "Bug", color: "red" }, ts++),
          )
        ).status,
      ).toBe(202);

      const refuseWithoutAppend = async (current: Event, reason: string) => {
        const before = await streams.read(streamId);
        const response = await post(current);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: { class: "validator-rejected", reason },
        });
        expect(await streams.read(streamId)).toEqual(before);
      };
      await refuseWithoutAppend(
        event("label.created", { v: 1, labelId: "bug", name: "Defect", color: "blue" }, ts++),
        "label/duplicate-id",
      );
      await refuseWithoutAppend(
        event("label.created", { v: 1, labelId: "same-name", name: "Bug", color: "blue" }, ts++),
        "label/duplicate-name",
      );
      await refuseWithoutAppend(
        event("label.renamed", { v: 1, labelId: "missing", name: "Missing" }, ts++),
        "label/unknown-id",
      );
      await refuseWithoutAppend(
        event("label.recolored", { v: 1, labelId: "missing", color: "gray" }, ts++),
        "label/unknown-id",
      );
      expect(
        (
          await post(
            event("label.created", { v: 1, labelId: "docs", name: "Docs", color: "blue" }, ts++),
          )
        ).status,
      ).toBe(202);
      await refuseWithoutAppend(
        event("label.renamed", { v: 1, labelId: "docs", name: "Bug" }, ts++),
        "label/duplicate-name",
      );

      const caseVariant = await post(
        event("label.created", { v: 1, labelId: "lowercase", name: "bug", color: "green" }, ts++),
      );
      expect(caseVariant.status).toBe(202);
      expect((await streams.read(streamId)).map((record) => (record as Event).type)).toEqual([
        "label.created",
        "label.created",
        "label.created",
      ]);
    } finally {
      gateway.terminate();
      await server.stop();
    }
  });

  it("fails closed on cross-repo and source-offset catalog corruption while ignoring pending entries", async () => {
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const baseUrl = await server.start();
    const streams = new OfficialStreamAdapter({ baseUrl });
    const materializer = new IssueBoardMaterializer({ streams });
    const catalogStream = repoIssuesStreamId("maple", "reading-room");
    const issueStream = "issue:maple/reading-room/pending";
    try {
      await streams.create(catalogStream);
      await streams.create(issueStream);
      await streams.append(
        catalogStream,
        event(
          ISSUE_CATALOG_EVENT,
          { v: 1, issueStreamId: issueStream, sourceOffset: offsetForOrdinal(0) },
          1,
        ),
        { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
      );
      const pending = await materializer.materialize("maple", "reading-room");
      expect(pending.board.columns.open.count).toBe(0);

      await streams.append(
        issueStream,
        event("issue.opened", { v: 1, title: "Pending", body: "" }, 2),
        { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
      );
      await expect(materializer.materialize("maple", "reading-room")).resolves.toMatchObject({
        board: { columns: { open: { count: 1, issues: ["pending"] } } },
      });

      const badOffsetCatalog = repoIssuesStreamId("maple", "bad-offset");
      const badOffsetIssue = "issue:maple/bad-offset/i";
      await streams.create(badOffsetCatalog);
      await streams.create(badOffsetIssue);
      await streams.append(
        badOffsetCatalog,
        event(
          ISSUE_CATALOG_EVENT,
          { v: 1, issueStreamId: badOffsetIssue, sourceOffset: offsetForOrdinal(1) },
          1,
        ),
        { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
      );
      await streams.append(
        badOffsetIssue,
        event("issue.opened", { v: 1, title: "Wrong", body: "" }, 2),
        { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
      );
      await expect(materializer.materialize("maple", "bad-offset")).rejects.toThrow(
        "repo-issues/source-offset-mismatch",
      );

      const malformedCatalog = repoIssuesStreamId("maple", "malformed-catalog");
      await streams.create(malformedCatalog);
      await streams.append(
        malformedCatalog,
        event(
          ISSUE_CATALOG_EVENT,
          {
            v: 1,
            issueStreamId: "issue:maple/malformed-catalog/i",
            sourceOffset: "not-an-offset",
          },
          1,
        ),
        { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
      );
      await expect(materializer.materialize("maple", "malformed-catalog")).rejects.toThrow(
        "repo-issues/corrupt-event",
      );

      const malformedOpenCatalog = repoIssuesStreamId("maple", "malformed-open");
      const malformedOpenIssue = "issue:maple/malformed-open/i";
      await streams.create(malformedOpenCatalog);
      await streams.create(malformedOpenIssue);
      await streams.append(
        malformedOpenCatalog,
        event(
          ISSUE_CATALOG_EVENT,
          {
            v: 1,
            issueStreamId: malformedOpenIssue,
            sourceOffset: offsetForOrdinal(0),
          },
          1,
        ),
        { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
      );
      await streams.append(
        malformedOpenIssue,
        event("issue.opened", { v: 1, title: "Missing body" }, 2),
        { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
      );
      await expect(materializer.materialize("maple", "malformed-open")).rejects.toThrow(
        "repo-issues/target-does-not-open",
      );

      const crossCatalog = repoIssuesStreamId("maple", "cross");
      await streams.create(crossCatalog);
      await streams.append(
        crossCatalog,
        event(
          ISSUE_CATALOG_EVENT,
          {
            v: 1,
            issueStreamId: "issue:other/cross/i",
            sourceOffset: offsetForOrdinal(0),
          },
          1,
        ),
        { sequence: offsetForOrdinal(0), applicationOffset: offsetForOrdinal(0) },
      );
      await expect(materializer.materialize("maple", "cross")).rejects.toThrow(
        "repo-issues/cross-repo-source",
      );

      await expect(
        materializer.assertIssueDeclared(
          "maple",
          "reading-room",
          "issue:maple/reading-room/preexisting",
          offsetForOrdinal(0),
        ),
      ).rejects.toThrow("repo-issues/migration-required");
    } finally {
      await server.stop();
    }
  });

  it("keeps an accepted dispatch accepted when the optional snapshot cannot be written", async () => {
    const server = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const baseUrl = await server.start();
    const streams = new OfficialStreamAdapter({ baseUrl });
    const blocked = mkdtempSync(join(tmpdir(), "eforest-e5-t03-blocked-"));
    scratch.push(blocked);
    const blockedFile = join(blocked, "not-a-directory");
    writeFileSync(blockedFile, "x", "utf8");
    const materializer = new IssueBoardMaterializer({ streams, cacheDir: blockedFile });
    const gateway = new PlatformGateway({
      verifier,
      streams,
      decideAuthorization: allow,
      namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
      issueBoards: materializer,
    });
    const streamId = repoLabelsStreamId("maple", "reading-room");
    try {
      await streams.create(streamId);
      const response = await gateway.handle(
        new Request("https://platform.test/api/dispatch", {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify({
            streamId,
            event: event("label.created", { v: 1, labelId: "bug", name: "Bug", color: "red" }, 1),
          }),
        }),
      );
      expect(response.status).toBe(202);
      expect(await streams.read(streamId)).toHaveLength(1);
      expect(materializer.materializedCopy("maple", "reading-room")).toBeDefined();
      expect(materializer.snapshotError("maple", "reading-room")).toBeDefined();
    } finally {
      gateway.terminate();
      await server.stop();
    }
  });

  it("rebuilds after platform and file-backed stream-server restarts with deleted and corrupt snapshots", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "eforest-e5-t03-restart-store-"));
    const cacheDir = mkdtempSync(join(tmpdir(), "eforest-e5-t03-restart-cache-"));
    scratch.push(dataDir, cacheDir);
    const org = "maple";
    const repo = "restart";
    const labelStream = repoLabelsStreamId(org, repo);
    const issueStream = `issue:${org}/${repo}/i`;
    const path = boardCachePath(cacheDir, org, repo);
    let expected: string;

    const start = async () => {
      const server = createDurableStreamTestServer({
        host: "127.0.0.1",
        port: 0,
        dataDir,
      });
      const baseUrl = await server.start();
      const streams = new OfficialStreamAdapter({ baseUrl });
      const gateway = new PlatformGateway({
        verifier,
        streams,
        decideAuthorization: allow,
        namespaceViewReader: { viewFor: async () => ({ orgs: {} }) },
        boardCacheDir: cacheDir,
      });
      return { server, streams, gateway };
    };

    let fixture = await start();
    try {
      await fixture.streams.create(labelStream);
      await fixture.streams.create(issueStream);
      for (const [streamId, current] of [
        [
          labelStream,
          event("label.created", { v: 1, labelId: "bug", name: "Bug", color: "red" }, 1),
        ],
        [issueStream, event("issue.opened", { v: 1, title: "Restart", body: "" }, 2)],
        [issueStream, event("issue.labeled", { v: 1, label: "bug" }, 3)],
      ] as const) {
        const response = await fixture.gateway.handle(
          new Request("https://platform.test/api/dispatch", {
            method: "POST",
            headers: { authorization: "Bearer test", "content-type": "application/json" },
            body: JSON.stringify({ streamId, event: current }),
          }),
        );
        expect(response.status).toBe(202);
      }
      const board = await fixture.gateway.handle(
        new Request(`https://platform.test/api/repos/${org}/${repo}/board`, {
          headers: { authorization: "Bearer test" },
        }),
      );
      expected = ((await board.json()) as { digest: string }).digest;
    } finally {
      fixture.gateway.terminate();
      await fixture.server.stop();
    }

    rmSync(path);
    fixture = await start();
    try {
      const rebuilt = await fixture.gateway.handle(
        new Request(`https://platform.test/api/repos/${org}/${repo}/board`, {
          headers: { authorization: "Bearer test" },
        }),
      );
      expect(((await rebuilt.json()) as { digest: string }).digest).toBe(expected);
    } finally {
      fixture.gateway.terminate();
      await fixture.server.stop();
    }

    writeFileSync(path, "{truncated", "utf8");
    fixture = await start();
    try {
      const rebuilt = await fixture.gateway.handle(
        new Request(`https://platform.test/api/repos/${org}/${repo}/board`, {
          headers: { authorization: "Bearer test" },
        }),
      );
      expect(((await rebuilt.json()) as { digest: string }).digest).toBe(expected);
    } finally {
      fixture.gateway.terminate();
      await fixture.server.stop();
    }
  });

  it("replays label logs deterministically in separate processes and fails corrupt logs", () => {
    const directory = mkdtempSync(join(tmpdir(), "eforest-label-replay-"));
    scratch.push(directory);
    const valid = join(
      process.cwd(),
      ".eforest/tasks/epic-5-the-meadow/E5-T03-issue-board-derived-stream/evidence/golden-board/logs/repo-labels.jsonl",
    );
    const invalid = join(directory, "invalid.jsonl");
    const firstLine = readFileSync(valid, "utf8").split("\n")[0]!;
    const firstRecord = JSON.parse(firstLine) as {
      readonly payload: { readonly actor?: unknown; readonly writer?: unknown };
    };
    expect(typeof firstRecord.payload.actor).toBe("string");
    expect(firstRecord.payload.writer).toMatchObject({ v: 1, sub: firstRecord.payload.actor });
    writeFileSync(
      invalid,
      `${firstLine}\n${canonicalJson({
        ...event("label.created", { v: 1, labelId: "bug", name: "Again", color: "blue" }, 2),
        offset: offsetForOrdinal(1),
      })}\n`,
      "utf8",
    );
    const args = [
      "packages/cli/dist/src/bin.js",
      "replay",
      valid,
      "--digest",
      "--reducer",
      "packages/issues/label-reducer.mjs",
    ];
    const first = execFileSync(process.execPath, args, { encoding: "utf8" }).trim();
    const second = execFileSync(process.execPath, args, { encoding: "utf8" }).trim();
    expect(second).toBe(first);
    const corrupt = spawnSync(
      process.execPath,
      [
        "packages/cli/dist/src/bin.js",
        "replay",
        invalid,
        "--digest",
        "--reducer",
        "packages/issues/label-reducer.mjs",
      ],
      { encoding: "utf8" },
    );
    expect(corrupt.status).not.toBe(0);
  });
});
