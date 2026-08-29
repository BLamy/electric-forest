import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDurableStreamTestServer } from "@eforest/server";
import {
  IdentityStore,
  OidcClient,
  OidcTransactions,
  PlatformWebApp,
  signedSessionCookie,
} from "../src/index.js";

const now = 1_700_000_000_000;
const secret = "e3-t02-spa-test-session-secret-is-at-least-32-bytes";

describe("E3 authenticated SPA and whoami door", () => {
  let official: ReturnType<typeof createDurableStreamTestServer>;
  let identity: IdentityStore;
  let app: PlatformWebApp;
  let webRoot: string;

  beforeEach(async () => {
    official = createDurableStreamTestServer({ host: "127.0.0.1", port: 0 });
    const streamUrl = await official.start();
    identity = new IdentityStore({ baseUrl: streamUrl, now: () => now });
    await identity.ensure();
    webRoot = await mkdtemp(resolve(tmpdir(), "e3-t02-spa-test-"));
    await mkdir(resolve(webRoot, "assets"));
    await writeFile(resolve(webRoot, "index.html"), "<!doctype html><main>canopy shell</main>");
    await writeFile(resolve(webRoot, "assets/app.js"), "globalThis.__CANOPY__=true;");
    app = new PlatformWebApp({
      oidc: new OidcClient({
        issuer: "http://127.0.0.1:9",
        clientId: "e3-t02-spa-test",
        now: () => now,
      }),
      transactions: new OidcTransactions(() => new Uint8Array(32)),
      identity,
      sessionSecret: secret,
      sessionTtlMs: 60_000,
      now: () => now,
      webRoot,
    });
  });

  afterEach(async () => {
    await official.stop();
    await rm(webRoot, { recursive: true, force: true });
  });

  it("keeps app routes and emitted assets behind the replayed session gate", async () => {
    for (const path of ["/", "/maple", "/maple/reading-room", "/index.html", "/assets/app.js"]) {
      const response = await app.handle(new Request(`http://platform.test${path}`));
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe("/auth/login");
    }

    await identity.login("auth0|ada", "ada@example.test", "session-ada");
    const cookie = signedSessionCookie(secret, "session-ada", 60).split(";")[0]!;
    const headers = { cookie };
    const index = await app.handle(new Request("http://platform.test/", { headers }));
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toContain("canopy shell");
    const deep = await app.handle(
      new Request("http://platform.test/maple/reading-room", { headers }),
    );
    expect(await deep.text()).toContain("canopy shell");
    const asset = await app.handle(new Request("http://platform.test/assets/app.js", { headers }));
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await asset.text()).toContain("__CANOPY__");
  });

  it("answers whoami from the reduced view and keeps 200 malformed refusals neutral", async () => {
    await identity.login("auth0|ada", "ada@example.test", "session-ada");
    const before = await identity.snapshot();
    const cookie = signedSessionCookie(secret, "session-ada", 60).split(";")[0]!;
    const allowed = await app.handle(
      new Request("http://platform.test/api/whoami", { headers: { cookie } }),
    );
    expect(await allowed.json()).toEqual({
      user: { sub: "auth0|ada", email: "ada@example.test" },
      stream: "__identity__",
      offset: before.offset,
      digest: before.digest,
    });

    const malformed = Array.from(
      { length: 200 },
      (_, index) => `ef_session=${"x".repeat(index % 31)}${String(index)}.%${String(index)}`,
    );
    for (const value of malformed) {
      const response = await app.handle(
        new Request("http://platform.test/api/whoami", { headers: { cookie: value } }),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { class: "auth-refused" } });
    }
    for (const method of ["POST", "OPTIONS"]) {
      const response = await app.handle(new Request("http://platform.test/api/whoami", { method }));
      expect(response.status).toBe(405);
      expect(await response.json()).toEqual({ error: { class: "method-not-allowed" } });
    }
    const head = await app.handle(
      new Request("http://platform.test/api/whoami", { method: "HEAD" }),
    );
    expect(head.status).toBe(401);
    expect(head.headers.get("content-type")).toBe("application/json");
    const after = await identity.snapshot();
    expect(after).toEqual(before);
  });

  it("fails closed for forged and ended sessions and never falls through reserved paths", async () => {
    await identity.login("auth0|ada", "ada@example.test", "session-ada");
    const forged = signedSessionCookie(secret, "fabricated-session", 60).split(";")[0]!;
    const forgedResponse = await app.handle(
      new Request("http://platform.test/api/whoami", { headers: { cookie: forged } }),
    );
    expect(forgedResponse.status).toBe(401);

    const ended = signedSessionCookie(secret, "session-ada", 60).split(";")[0]!;
    await identity.endSession("session-ada");
    const endedResponse = await app.handle(
      new Request("http://platform.test/api/whoami", { headers: { cookie: ended } }),
    );
    expect(endedResponse.status).toBe(401);

    for (const path of ["/api/nonexistent", "/auth/nonexistent"]) {
      const response = await app.handle(
        new Request(`http://platform.test${path}`, { headers: { cookie: ended } }),
      );
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.text()).not.toContain("<!doctype html>");
    }
    expect(forgedResponse.headers.get("access-control-allow-origin")).toBeNull();
  });
});
