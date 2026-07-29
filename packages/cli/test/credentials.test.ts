import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearCredentials,
  credentialsPath,
  NO_CREDENTIALS_MESSAGE,
  runAuthenticatedDispatch,
  storeCredentials,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("CLI credential storage", () => {
  it("stores mode 0600, clears, and refuses locally with exit 10 while the server is unreachable", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-credentials-"));
    roots.push(root);
    const environment = {
      EF_HOME: root,
      EF_SERVER_URL: "http://127.0.0.1:1",
    };
    await storeCredentials(
      {
        accessToken: "secret",
        tokenType: "Bearer",
        issuer: "https://issuer.example.test",
        clientId: "cli",
        scopes: ["repo:write"],
      },
      environment,
    );
    expect((await stat(credentialsPath(environment))).mode & 0o777).toBe(0o600);
    await clearCredentials(environment);
    await expect(stat(credentialsPath(environment))).rejects.toMatchObject({ code: "ENOENT" });

    let fetches = 0;
    const stderr: string[] = [];
    const code = await runAuthenticatedDispatch(
      "target",
      JSON.stringify({ type: "test.created", payload: {}, ts: 1 }),
      { stdout: () => {}, stderr: (text) => stderr.push(text) },
      environment,
      (async () => {
        fetches += 1;
        throw new Error("closed port");
      }) as typeof fetch,
    );
    expect(code).toBe(10);
    expect(stderr.join("")).toBe(`${NO_CREDENTIALS_MESSAGE}\n`);
    expect(fetches).toBe(0);
  });

  it("returns frozen exit 13 for an authenticated 401 response", async () => {
    const root = await mkdtemp(join(tmpdir(), "eforest-credentials-"));
    roots.push(root);
    const environment = { EF_HOME: root, EF_SERVER_URL: "https://platform.example.test" };
    await storeCredentials(
      {
        accessToken: "revoked-secret",
        tokenType: "Bearer",
        issuer: "https://issuer.example.test",
        clientId: "cli",
        scopes: ["repo:write"],
      },
      environment,
    );
    const stderr: string[] = [];
    const code = await runAuthenticatedDispatch(
      "target",
      JSON.stringify({ type: "test.created", payload: {}, ts: 1 }),
      { stdout: () => {}, stderr: (text) => stderr.push(text) },
      environment,
      (async () =>
        Response.json({ error: { class: "token-revoked" } }, { status: 401 })) as typeof fetch,
    );
    expect(code).toBe(13);
    expect(stderr.join("")).toBe('{"error":{"class":"token-revoked"}}\n');
  });
});
