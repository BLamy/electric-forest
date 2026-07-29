#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const platformPath = path.join(ROOT, "packages/platform/dist/src/index.js");
const serverPath = path.join(ROOT, "packages/server/dist/src/index.js");
const platform = await import(`${pathToFileURL(platformPath).href}?guard=${Date.now()}`);
const server = await import(`${pathToFileURL(serverPath).href}?guard=${Date.now()}`);
const guard = process.argv.find((argument) => argument.startsWith("--guard="))?.slice(8);
assert.ok(guard === "decision" || guard === "digest", "use --guard=decision|digest");

const target = platform.repoTargetFromPath("acme", "secret", "main");
const input = {
  operation: "dispatch",
  target,
  principal: { kind: "identified", sub: "auth0|outsider", grantId: "outsider-grant" },
  eventKind: "application",
  identity: {
    users: {
      "auth0|owner": { email: "owner@example.test" },
      "auth0|outsider": { email: "outsider@example.test" },
    },
    sessions: {},
    orgs: {
      acme: { name: "acme", ownerSub: "auth0|owner" },
    },
    memberships: { acme: { "auth0|owner": { role: "owner", status: "active" } } },
    grants: {
      "outsider-grant": {
        sub: "auth0|outsider",
        kind: "cli-token",
        tokenKind: "web-mint",
        tokenHash: "00",
        scopes: [],
        status: "active",
      },
    },
  },
  identityOffset: "0000000000000000_0000000000000001",
  namespace: {
    orgs: {
      acme: {
        name: "acme",
        owner: "auth0|owner",
        projects: { trees: { name: "trees" } },
        repos: {
          secret: {
            name: "secret",
            project: "trees",
            visibility: "private",
            owner: "auth0|owner",
          },
        },
      },
    },
  },
};

const decision = platform.decideStreamAuthorization(input);
if (guard === "decision") {
  assert.deepEqual(decision, {
    allowed: false,
    operation: "dispatch",
    identityOffset: "0000000000000000_0000000000000001",
    refusal: "authz/not-found",
  });
  console.log("E2_T10_DECISION_GOLDEN_GUARD_OK");
} else {
  const official = server.createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
  const baseUrl = await official.start();
  try {
    const streams = new platform.OfficialStreamAdapter({ baseUrl });
    await streams.create(target.streamId);
    await streams.append(target.streamId, {
      type: "seed",
      payload: { v: 1 },
      ts: 1,
    });
    const digest = async () => {
      const response = await fetch(`${baseUrl}/streams/${encodeURIComponent(target.streamId)}`);
      return createHash("sha256")
        .update(`${response.status}:${await response.text()}`)
        .digest("hex");
    };
    const before = await digest();
    if (decision.allowed) {
      await streams.append(decision.streamId, {
        type: "cross-tenant.write",
        payload: { v: 1 },
        ts: 2,
      });
    }
    const after = await digest();
    assert.equal(after, before, "cross-tenant decision changed the official target digest");
    console.log(`E2_T10_DECISION_DIGEST_GUARD_OK target-calls=0 digest=${before}`);
  } finally {
    await official.stop();
  }
}
