import { describe, expect, it, vi } from "vitest";

vi.mock("@eforest/client", () => ({
  headDurableJsonStream: vi.fn(),
  readDurableJson: vi.fn(),
}));
vi.mock("@eforest/platform", () => ({
  IdentityStore: class {},
  OfficialStreamAdapter: class {},
  SESSION_COOKIE: "ef_session",
  WriterLaneDispatcher: class {},
  createPlatformProductionRuntime: vi.fn(),
  listenPlatformServer: vi.fn(),
  signedSessionCookie: vi.fn(),
}));

import { browserVerifyStartupTestHooks } from "../src/index.js";

describe("browser verification authenticated contexts", () => {
  it("creates the real identity session before installing only its signed cookie", async () => {
    const calls: string[] = [];
    const login = vi.fn(async (sub: string, email: string, sessionId: string) => {
      calls.push(`login:${sub}:${email}:${sessionId}`);
    });
    const addCookies = vi.fn(async () => {
      calls.push("cookie");
    });
    const signSessionCookie = vi.fn(
      (sessionId: string) => `ef_session=${sessionId}.signed; Path=/; HttpOnly`,
    );

    await browserVerifyStartupTestHooks.authenticateSessionContext({
      identity: { login },
      context: { addCookies },
      platformUrl: "http://127.0.0.1:3210",
      subject: {
        id: "reviewer",
        email: "reviewer@canopy.test",
        password: "not-consumed-by-this-helper",
      },
      sessionId: "browser-world-0002-reviewer",
      signSessionCookie,
    });

    expect(login).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith(
      "auth0|reviewer",
      "reviewer@canopy.test",
      "browser-world-0002-reviewer",
    );
    expect(addCookies).toHaveBeenCalledTimes(1);
    expect(addCookies).toHaveBeenCalledWith([
      {
        name: "ef_session",
        value: "browser-world-0002-reviewer.signed",
        url: "http://127.0.0.1:3210",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    expect(signSessionCookie).toHaveBeenCalledOnce();
    expect(signSessionCookie).toHaveBeenCalledWith("browser-world-0002-reviewer");
    expect(calls).toEqual([
      "login:auth0|reviewer:reviewer@canopy.test:browser-world-0002-reviewer",
      "cookie",
    ]);
  });
});
