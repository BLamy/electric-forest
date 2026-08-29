#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { canonicalJson } from "../../packages/protocol/dist/src/index.js";
import { createDurableStreamTestServer } from "../../packages/server/dist/src/index.js";
import { createPlatformProductionRuntime } from "../../packages/platform/dist/src/index.js";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const evidencePath = resolve(
  root,
  ".eforest/tasks/epic-2-the-gates/E2-T12-the-locked-gate/evidence/e2-t12-local-config.json",
);
const now = 1_800_000_000_000;
const nativeFetch = globalThis.fetch;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicRandom(seed) {
  let counter = seed;
  return (size) => {
    counter += 1;
    return Uint8Array.from({ length: size }, (_, index) => (counter * 37 + index * 17) & 0xff);
  };
}

function requestDetails(input, init) {
  const request = input instanceof Request ? input : undefined;
  const url = new URL(request?.url ?? String(input));
  return {
    method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
    url,
  };
}

async function scenario(label, randomSeed) {
  const createdStreams = [];
  const official = createDurableStreamTestServer({
    host: "127.0.0.1",
    port: 0,
    onStreamCreated: ({ path }) => {
      createdStreams.push(decodeURIComponent(path.replace(/^\/streams\//, "")));
    },
  });
  const serverUrl = await official.start();
  const requestTrace = [];
  let runtime;
  globalThis.fetch = async (input, init) => {
    const details = requestDetails(input, init);
    assert.ok(
      ["127.0.0.1", "localhost", "::1"].includes(details.url.hostname),
      `non-loopback request in ${label}: ${details.url.hostname}`,
    );
    assert.equal(details.url.origin, serverUrl, `cross-instance request in ${label}`);
    requestTrace.push(`${details.method} ${details.url.pathname}${details.url.search}`);
    return nativeFetch(input, init);
  };

  try {
    runtime = await createPlatformProductionRuntime(
      {
        EF_OIDC_ISSUER: "http://127.0.0.1:9/",
        EF_OIDC_CLIENT_ID: "e2-t12-local-config",
        EF_SESSION_SECRET: "e2-t12-local-config-session-secret-32-bytes",
        EF_SESSION_TTL: "600",
        EFOREST_SERVER_URL: serverUrl,
      },
      {
        now: () => now,
        random: deterministicRandom(randomSeed),
        operationId: () => "e2-t12-local-config-operation",
      },
    );
    await runtime.registry.stop();

    const empty = await runtime.identity.snapshot();
    assert.equal(empty.events.length, 0, `${label} did not start fresh`);
    const accepted = await runtime.identity.login(
      "auth0|local-config-user",
      "local-config@example.test",
      "e2-t12-local-config-session",
    );
    const reread = await runtime.identity.snapshot();
    assert.deepEqual(reread.events, accepted.events, `${label} reread diverged from append result`);
    assert.equal(reread.digest, accepted.digest, `${label} reread digest diverged`);
    assert.deepEqual(
      reread.events.map((event) => event.type),
      ["identity.user.created", "identity.session.started"],
    );

    const methods = new Set(requestTrace.map((entry) => entry.slice(0, entry.indexOf(" "))));
    for (const method of ["PUT", "POST", "GET", "HEAD"]) {
      assert.ok(methods.has(method), `${label} did not exercise ${method}`);
    }
    assert.deepEqual(
      [...new Set(createdStreams)].sort(),
      ["__identity__", "__registry__", "ns:root"],
      `${label} did not initialize the production runtime streams`,
    );

    return {
      label,
      configuredServer: "fresh-published-test-server",
      createdStreams: [...new Set(createdStreams)].sort(),
      requestCount: requestTrace.length,
      requestShapeSha256: sha256(`${requestTrace.join("\n")}\n`),
      eventCount: reread.events.length,
      eventTypes: reread.events.map((event) => event.type),
      eventBytesSha256: sha256(`${reread.events.map(canonicalJson).join("\n")}\n`),
      offset: reread.offset,
      digest: reread.digest,
      methods: [...methods].sort(),
      nonLoopbackRequests: 0,
      crossInstanceRequests: 0,
    };
  } finally {
    globalThis.fetch = nativeFetch;
    if (runtime !== undefined) {
      await runtime.registry.stop();
      runtime.namespaces.terminate();
    }
    await official.stop();
  }
}

const first = await scenario("server-a", 11);
const second = await scenario("server-b", 29);
assert.notEqual(first.label, second.label);
assert.deepEqual(
  { ...first, label: "same" },
  { ...second, label: "same" },
  "changing only EFOREST_SERVER_URL changed the application result or request path",
);

const [
  production,
  platformBin,
  official,
  serverBoundary,
  browserRoutes,
  platformPackage,
  clientPackage,
  serverPackage,
] = await Promise.all([
  readFile(resolve(root, "packages/platform/src/production.ts"), "utf8"),
  readFile(resolve(root, "packages/platform/src/bin.ts"), "utf8"),
  readFile(resolve(root, "packages/platform/src/official.ts"), "utf8"),
  readFile(resolve(root, "packages/server/src/upstream.ts"), "utf8"),
  readFile(resolve(root, "packages/platform/src/auth/routes.ts"), "utf8"),
  readFile(resolve(root, "packages/platform/package.json"), "utf8"),
  readFile(resolve(root, "packages/client/package.json"), "utf8"),
  readFile(resolve(root, "packages/server/package.json"), "utf8"),
]);
assert.match(platformBin, /createPlatformProductionRuntime\(\)/);
assert.match(production, /new OfficialStreamAdapter\(\{ baseUrl: config\.EFOREST_SERVER_URL \}\)/);
assert.doesNotMatch(production, /NODE_ENV|emulat|localhost|127\.0\.0\.1/);
assert.match(official, /@eforest\/client/);
assert.match(serverBoundary, /DurableStreamTestServer.*@durable-streams\/server/s);
assert.doesNotMatch(
  browserRoutes,
  /EFOREST_SERVER_URL|\/streams\/|@eforest\/client|@durable-streams\/client/,
);
assert.doesNotMatch(platformPackage, /@durable-streams\/server/);
assert.match(clientPackage, /"@durable-streams\/client": "\^0\.2\.6"/);
assert.match(serverPackage, /"@durable-streams\/server": "\^0\.3\.8"/);

const productPaths = ["packages/platform/src", "packages/client/src", "packages/server/src"];
const emulatorSearch = await run("git", [
  "grep",
  "-n",
  "-E",
  "vendor/emulate|@emulators/auth0",
  "--",
  ...productPaths,
]).catch((error) => error);
assert.equal(emulatorSearch.code, 1, String(emulatorSearch.stdout ?? emulatorSearch.stderr ?? ""));

const evidence = {
  schema: "eforest.e2-t12.local-config.v1",
  entrypoint: "packages/platform/src/production.ts#createPlatformProductionRuntime",
  configurationDelta: ["EFOREST_SERVER_URL"],
  instances: [first, second],
  parity: {
    create: true,
    append: true,
    read: true,
    digest: first.digest,
    requestShapeSha256: first.requestShapeSha256,
    eventBytesSha256: first.eventBytesSha256,
    codePathDivergence: 0,
  },
  boundaries: {
    client: "@durable-streams/client@^0.2.6",
    localServer: "@durable-streams/server@^0.3.8",
    emulatorProductImports: 0,
    customPlatformTransport: 0,
    copiedProtocol: 0,
    browserDirectStreamAccess: 0,
  },
};
const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
if (process.env.E2_T12_UPDATE_LOCAL_CONFIG_GOLDEN === "1") {
  await writeFile(evidencePath, serialized);
} else {
  assert.equal(await readFile(evidencePath, "utf8"), serialized, "local config evidence drifted");
}

process.stdout.write(
  `E2_T12_LOCAL_CONFIG_OK servers=2 entrypoint=createPlatformProductionRuntime create=true append=true read=true digest=${first.digest} request-shape=${first.requestShapeSha256} code-path-divergence=0 emulator-product-imports=0 custom-platform-transport=0 copied-protocol=0 browser-direct-stream=0\n`,
);
