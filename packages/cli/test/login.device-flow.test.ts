import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  credentialsPath,
  DEVICE_DENIED_EXIT,
  DEVICE_EXPIRED_EXIT,
  runLogin,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function environment(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "eforest-cli-login-"));
  roots.push(root);
  return {
    EF_HOME: root,
    EF_OIDC_ISSUER: "https://issuer.example.test",
    EF_OIDC_CLIENT_ID: "eforest-cli",
    EF_SERVER_URL: "https://platform.example.test",
  };
}

function io(): { readonly stdout: string[]; readonly stderr: string[] } {
  return { stdout: [], stderr: [] };
}

function cliIo(output: ReturnType<typeof io>) {
  return {
    stdout: (text: string) => output.stdout.push(text),
    stderr: (text: string) => output.stderr.push(text),
  };
}

function grantResponse(): Response {
  return Response.json({
    device_code: "device-1",
    user_code: "ABCD-EFGH",
    verification_uri: "https://issuer.example.test/activate",
    verification_uri_complete: "https://issuer.example.test/activate?user_code=ABCD-EFGH",
    interval: 1,
  });
}

describe("ef login device flow", () => {
  it("honors pending and slow_down, registers the grant, and writes mode 0600", async () => {
    const env = await environment();
    const output = io();
    const sleeps: number[] = [];
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const polls = [
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({ error: "slow_down" }, { status: 400 }),
      Response.json({ access_token: "device-access-secret", id_token: "verified-id-token" }),
    ];
    const fetcher: typeof fetch = async (input, init) => {
      const url = input.toString();
      requests.push({ url, body: String(init?.body ?? "") });
      if (url.endsWith("/oauth/device/code")) return grantResponse();
      if (url.endsWith("/oauth/token")) return polls.shift()!;
      if (url.endsWith("/api/device-grants")) return Response.json({ grantId: "grant-device" });
      throw new Error(`unexpected request ${url}`);
    };

    const code = await runLogin(true, cliIo(output), {
      environment: env,
      fetch: fetcher,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    expect(code).toBe(0);
    expect(sleeps).toEqual([1_000, 1_000, 6_000]);
    expect(sleeps[2]).toBeGreaterThanOrEqual(sleeps[1]! + 5_000);
    expect(output.stdout.join("")).toContain("Device code: ABCD-EFGH");
    expect(requests.filter(({ url }) => url.endsWith("/oauth/token"))).toHaveLength(3);
    const registration = requests.find(({ url }) => url.endsWith("/api/device-grants"))!;
    expect(JSON.parse(registration.body)).toEqual({
      idToken: "verified-id-token",
      name: "ef login",
      scopes: ["email", "openid", "profile", "repo:write"],
    });
    expect((await stat(credentialsPath(env))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(credentialsPath(env), "utf8"))).toMatchObject({
      accessToken: "device-access-secret",
      tokenType: "Bearer",
    });
  });

  it.each([
    ["expired_token", DEVICE_EXPIRED_EXIT, "Device code expired"],
    ["access_denied", DEVICE_DENIED_EXIT, "Device authorization was denied"],
  ])("returns the frozen exit for %s without writing credentials", async (error, code, message) => {
    const env = await environment();
    const output = io();
    const fetcher: typeof fetch = async (input) =>
      input.toString().endsWith("/oauth/device/code")
        ? grantResponse()
        : Response.json({ error }, { status: error === "access_denied" ? 403 : 400 });

    await expect(
      runLogin(true, cliIo(output), {
        environment: env,
        fetch: fetcher,
        sleep: async () => {},
      }),
    ).resolves.toBe(code);
    expect(output.stderr.join("")).toContain(message);
    await expect(stat(credentialsPath(env))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
