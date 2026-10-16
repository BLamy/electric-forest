import { createHash } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import { connect } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OidcTransactions } from "../src/auth/oidc.js";
import { safeLocalReturn } from "../src/auth/routes.js";
import { signedSessionCookie, clearedSessionCookie } from "../src/auth/session.js";
import { prepareHostedStorage } from "../src/hosted-storage.js";
import { HOSTED_LIMITS, readHostedEnvironment } from "../src/hosted.js";
import { createPlatformServer, listenPlatformServer } from "../src/server.js";

const workshop = resolve(
  ".eforest/tasks/epic-12-first-light/E12-T10-real-auth0-private-railway/work/unit",
);
const configuration = {
  EF_DEPLOYMENT_MODE: "production",
  EF_PUBLIC_ORIGIN: "https://forest.example.test",
  EF_OIDC_ISSUER: "https://tenant.auth0.com/",
  EF_OIDC_CLIENT_ID: "forest-web",
  EF_BUILD_REVISION: "a".repeat(40),
  PORT: "8080",
};
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
});
async function directory(): Promise<string> {
  await mkdir(workshop, { recursive: true });
  return mkdtemp(resolve(workshop, "case-"));
}

async function socket(base: string, data: string): Promise<string> {
  const port = Number(new URL(base).port);
  return new Promise((resolveResponse, reject) => {
    const connection = connect(port, "127.0.0.1");
    let result = "";
    connection.setTimeout(3_000, () => {
      connection.destroy();
      reject(new Error("socket sensor timed out"));
    });
    connection.on("connect", () => connection.write(data));
    connection.on("data", (chunk: Buffer) => {
      result += chunk.toString();
    });
    connection.on("end", () => resolveResponse(result));
    connection.on("error", reject);
  });
}

describe("explicit private Auth0 hosted profile", () => {
  it("freezes numeric defaults and accepts the assigned port without inherited integrations", () => {
    expect(readHostedEnvironment(configuration)).toMatchObject({
      origin: "https://forest.example.test",
      port: 8080,
      sessionTtlSeconds: 86400,
    });
    expect(HOSTED_LIMITS).toEqual({
      maxBodyBytes: 8388608,
      requestDeadlineMs: 30000,
      readinessMs: 60000,
      drainMs: 15000,
      transactionTtlMs: 600000,
      sessionTtlSeconds: 86400,
      maxLongPollMs: 10000,
    });
  });
  it.each([
    "EF_PREVIEW_AUTH",
    "EF_PREVIEW_DATA_DIR",
    "EF_SESSION_SECRET",
    "EF_RESEND_API_KEY",
    "EFOREST_SERVER_URL",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "AWS_ACCESS_KEY_ID",
    "NODE_OPTIONS",
  ])("refuses inherited %s without echoing its value", (name) => {
    const value = "synthetic-secret-canary";
    expect(() => readHostedEnvironment({ ...configuration, [name]: value })).toThrow(name);
    try {
      readHostedEnvironment({ ...configuration, [name]: value });
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  });
  it.each([
    ["EF_DEPLOYMENT_MODE", "preview"],
    ["EF_PUBLIC_ORIGIN", "http://forest.example.test"],
    ["EF_PUBLIC_ORIGIN", "https://user:pass@forest.example.test"],
    ["EF_PUBLIC_ORIGIN", "https://forest.example.test/path"],
    ["EF_OIDC_ISSUER", "http://issuer.test/"],
    ["EF_OIDC_ISSUER", "https://issuer.test/?key=bad"],
    ["PORT", "65536"],
    ["PORT", "-1"],
    ["EF_BUILD_REVISION", "short"],
    ["EF_WEB_ROOT", "relative"],
    ["EF_DATA_DIR", "relative"],
    ["EF_AGENT_RESPONDER", "harness"],
    ["EF_SESSION_TTL", "86401"],
    ["EF_SESSION_TTL", "0"],
  ])("refuses invalid %s configuration", (name, value) => {
    expect(() => readHostedEnvironment({ ...configuration, [name]: value })).toThrow();
  });
  it.each([
    "//evil.test",
    "https://evil.test",
    "/%2f%2fevil.test",
    "/%252f%252fevil.test",
    "/\\evil.test",
    "/%5cevil.test",
    "/x/..//evil.test/auth/callback",
    "/%0d%0alocation:evil",
    "/bad%",
    "/white space",
  ])("rejects unsafe local return %s", (value) => {
    expect(safeLocalReturn(value)).toBeUndefined();
  });
  it("keeps safe local deep links and query state", () => {
    expect(safeLocalReturn("/maple/repo/blob/main/README.md?tab=code")).toBe(
      "/maple/repo/blob/main/README.md?tab=code",
    );
  });
  it("binds transactions to a browser, expires exactly at ten minutes and consumes once", () => {
    let now = 100;
    let seed = 0;
    const tx = new OidcTransactions((size) => new Uint8Array(size).fill(++seed), {
      now: () => now,
      ttlMs: 600000,
    });
    const one = tx.create({ binding: "browser-a", next: "/own/path" });
    expect(() => tx.consume(one.state)).toThrow("bad-state");
    expect(() => tx.consume(one.state, "browser-b")).toThrow("bad-state");
    now = 600099;
    expect(tx.consume(one.state, "browser-a").next).toBe("/own/path");
    expect(() => tx.consume(one.state, "browser-a")).toThrow("reused-code");
    const two = tx.create({ binding: "browser-a" });
    now += 600000;
    expect(() => tx.consume(two.state, "browser-a")).toThrow("bad-state");
  });
  it("makes hosted session and clearing cookies Secure without changing the local default", () => {
    expect(signedSessionCookie("secret", "opaque", 86400, true)).toMatch(
      /Path=\/; HttpOnly; SameSite=Lax; Max-Age=86400; Secure$/,
    );
    expect(clearedSessionCookie(true)).toContain("; Secure");
    expect(clearedSessionCookie()).not.toContain("Secure");
  });
  it("publishes one stable private signing key and refuses loss/corruption after readiness", async () => {
    const data = await directory();
    const initial = await prepareHostedStorage(
      data,
      configuration.EF_OIDC_ISSUER,
      configuration.EF_OIDC_CLIENT_ID,
    );
    expect(initial.initializing).toBe(true);
    await mkdir(resolve(data, "streams"));
    await initial.ready();
    expect(
      Object.keys(JSON.parse(await readFile(resolve(data, "hosted-state.json"), "utf8"))).sort(),
    ).toEqual(["clientId", "issuer", "keyHash", "mode", "phase", "version"]);
    const before = await readFile(resolve(data, "session.key"));
    expect((await stat(data)).mode & 0o777).toBe(0o700);
    expect((await stat(resolve(data, "session.key"))).mode & 0o777).toBe(0o600);
    const restarted = await prepareHostedStorage(
      data,
      configuration.EF_OIDC_ISSUER,
      configuration.EF_OIDC_CLIENT_ID,
    );
    expect(restarted.initializing).toBe(false);
    expect(restarted.secret).toBe(initial.secret);
    await writeFile(resolve(data, "session.key"), "corrupt\n");
    await expect(
      prepareHostedStorage(data, configuration.EF_OIDC_ISSUER, configuration.EF_OIDC_CLIENT_ID),
    ).rejects.toThrow("signing key");
    await writeFile(resolve(data, "session.key"), before);
    await unlink(resolve(data, "session.key"));
    await expect(
      prepareHostedStorage(data, configuration.EF_OIDC_ISSUER, configuration.EF_OIDC_CLIENT_ID),
    ).rejects.toThrow();
    await expect(readFile(resolve(data, "session.key"))).rejects.toThrow();
  });
  it("resumes only a complete pre-listen initialization journal, never preview or unknown state", async () => {
    const data = await directory();
    const first = await prepareHostedStorage(
      data,
      configuration.EF_OIDC_ISSUER,
      configuration.EF_OIDC_CLIENT_ID,
    );
    const resumed = await prepareHostedStorage(
      data,
      configuration.EF_OIDC_ISSUER,
      configuration.EF_OIDC_CLIENT_ID,
    );
    expect(resumed.initializing).toBe(true);
    expect(resumed.secret).toBe(first.secret);
    expect(createHash("sha256").update(resumed.secret).digest("hex")).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(resolve(data, "preview-state.json"), "{}");
    await expect(
      prepareHostedStorage(data, configuration.EF_OIDC_ISSUER, configuration.EF_OIDC_CLIENT_ID),
    ).rejects.toThrow("unknown or incomplete");
    const unknown = await directory();
    await writeFile(resolve(unknown, "unrelated.txt"), "preserve");
    await expect(
      prepareHostedStorage(unknown, configuration.EF_OIDC_ISSUER, configuration.EF_OIDC_CLIENT_ID),
    ).rejects.toThrow();
    expect(await readFile(resolve(unknown, "unrelated.txt"), "utf8")).toBe("preserve");
    const insecure = await directory();
    await chmod(insecure, 0o755);
    await expect(
      prepareHostedStorage(insecure, configuration.EF_OIDC_ISSUER, configuration.EF_OIDC_CLIENT_ID),
    ).rejects.toThrow("private");
  });
  it("pins the origin on the Node wire and emits multiple cookie headers separately", async () => {
    const server = createPlatformServer(
      async (request) => {
        const headers = new Headers();
        headers.append("set-cookie", "one=opaque; Path=/auth; HttpOnly; SameSite=Lax; Secure");
        headers.append("set-cookie", "two=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0");
        return new Response(request.url, { headers });
      },
      { origin: configuration.EF_PUBLIC_ORIGIN, maxBodyBytes: 8, requestDeadlineMs: 1000 },
    );
    servers.push(server);
    const base = await listenPlatformServer(server);
    const wire = await new Promise<{ url: string; cookies: string[] }>((done, reject) => {
      httpRequest(
        base,
        {
          path: "/auth/login",
          headers: {
            host: "evil.test",
            forwarded: "host=evil.test;proto=http",
            "x-forwarded-host": "evil.test",
            "x-forwarded-proto": "http",
          },
        },
        (response) => {
          let body = "";
          response.on("data", (bytes: Buffer) => {
            body += bytes.toString();
          });
          response.on("end", () =>
            done({ url: body, cookies: response.headers["set-cookie"] ?? [] }),
          );
        },
      )
        .on("error", reject)
        .end();
    });
    expect(wire.url).toBe("https://forest.example.test/auth/login");
    expect(wire.cookies).toHaveLength(2);
    expect(wire.cookies.every((cookie) => cookie.includes("; Secure"))).toBe(true);
    expect(
      await socket(
        base,
        "GET /x/..//attacker.test/auth/callback HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n",
      ),
    ).toContain("400 Bad Request");
    expect(
      await socket(
        base,
        "GET http://evil.test/path HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n",
      ),
    ).toContain("400 Bad Request");
  });
  it("bounds declared/chunked bodies and stalled sockets before handler execution", async () => {
    let calls = 0;
    const server = createPlatformServer(
      async () => {
        calls += 1;
        return new Response("ok");
      },
      { origin: configuration.EF_PUBLIC_ORIGIN, maxBodyBytes: 8, requestDeadlineMs: 100 },
    );
    servers.push(server);
    const base = await listenPlatformServer(server);
    expect((await fetch(base, { method: "POST", body: "12345678" })).status).toBe(200);
    expect(calls).toBe(1);
    expect(
      await socket(
        base,
        "POST /api/dispatch HTTP/1.1\r\nHost: fixture\r\nContent-Length: 9\r\n\r\n",
      ),
    ).toContain("413 Payload Too Large");
    expect(
      await socket(
        base,
        "POST /api/dispatch HTTP/1.1\r\nHost: fixture\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n123456789\r\n0\r\n\r\n",
      ),
    ).toContain("413 Payload Too Large");
    expect(
      await socket(
        base,
        "POST /api/dispatch HTTP/1.1\r\nHost: fixture\r\nContent-Length: 4\r\n\r\nx",
      ),
    ).toContain("408 Request Timeout");
    expect(await socket(base, "GET /healthz HTTP/1.1\r\nHost: fixture")).toBe("");
    expect(calls).toBe(1);
  });
  it("bounds a stalled finite response but leaves established SSE until cancellation", async () => {
    const server = createPlatformServer(
      async (request) =>
        request.url.endsWith("/stream")
          ? new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            )
          : new Promise(() => undefined),
      { origin: configuration.EF_PUBLIC_ORIGIN, requestDeadlineMs: 50 },
    );
    servers.push(server);
    const base = await listenPlatformServer(server);
    expect((await fetch(`${base}/stall`)).status).toBe(504);
    const controller = new AbortController();
    const stream = await fetch(`${base}/stream`, { signal: controller.signal });
    expect(stream.status).toBe(200);
    await new Promise((done) => setTimeout(done, 75));
    expect(new TextDecoder().decode((await stream.body!.getReader().read()).value)).toBe(
      "data: ready\n\n",
    );
    controller.abort();
  });
  it("rearms the socket admission deadline for the next partial keepalive request", async () => {
    let calls = 0;
    const server = createPlatformServer(
      async () => {
        calls += 1;
        return new Response("ok");
      },
      { origin: configuration.EF_PUBLIC_ORIGIN, requestDeadlineMs: 100 },
    );
    servers.push(server);
    const base = await listenPlatformServer(server);
    const began = performance.now();
    const response = await socket(
      base,
      "GET /healthz HTTP/1.1\r\nHost: fixture\r\nConnection: keep-alive\r\n\r\nGET /healthz HTTP/1.1\r\nHost: fixture",
    );
    expect(response.match(/HTTP\/1\.1 200/g)).toHaveLength(1);
    expect(calls).toBe(1);
    expect(performance.now() - began).toBeLessThan(1000);
  });
  it("preserves local generic failure envelopes and redacts hosted exception values", async () => {
    let captured = "";
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      captured += String(value);
      return true;
    });
    try {
      const local = createPlatformServer(async () => {
        throw new Error("expected-local-error");
      });
      servers.push(local);
      expect(await (await fetch(await listenPlatformServer(local))).json()).toEqual({
        error: { class: "internal", reason: "request_failed" },
      });
      captured = "";
      const hosted = createPlatformServer(
        async () => {
          throw new Error("private-request-canary");
        },
        { origin: configuration.EF_PUBLIC_ORIGIN, redactErrors: true },
      );
      servers.push(hosted);
      expect(await (await fetch(await listenPlatformServer(hosted))).json()).toEqual({
        error: { class: "http-refused", reason: "request-failed" },
      });
      expect(captured).toBe("platform request failed\n");
    } finally {
      stderr.mockRestore();
    }
  });
});
