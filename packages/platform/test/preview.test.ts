import { describe, expect, it } from "vitest";
import { readPreviewEnvironment } from "../src/preview.js";
import { readPlatformEnvironment } from "../src/production.js";

const environment = {
  EF_DEPLOYMENT_MODE: "preview",
  EF_PREVIEW_AUTH: "fixture",
  EF_PUBLIC_ORIGIN: "https://preview.example.test",
  EF_BUILD_REVISION: "a".repeat(40),
  PORT: "8080",
};

describe("explicit public preview configuration boundary", () => {
  it("requires an explicit mode and fixture identity, and derives the HTTPS Railway origin", () => {
    expect(readPreviewEnvironment(environment)).toMatchObject({
      origin: "https://preview.example.test",
      port: 8080,
    });
    const { EF_PUBLIC_ORIGIN: _origin, ...railway } = environment;
    expect(
      readPreviewEnvironment({ ...railway, RAILWAY_PUBLIC_DOMAIN: "preview.up.railway.app" })
        .origin,
    ).toBe("https://preview.up.railway.app");
    expect(() => readPreviewEnvironment({ ...environment, EF_PREVIEW_AUTH: "oidc" })).toThrow();
    expect(() =>
      readPreviewEnvironment({ ...environment, EF_DEPLOYMENT_MODE: "production" }),
    ).toThrow();
  });
  it.each([
    ["EFOREST_SERVER_URL", "https://production.example.test"],
    ["EF_OIDC_ISSUER", "https://production.auth0.com"],
    ["EF_SESSION_SECRET", "synthetic-secret-canary"],
    ["EF_RESEND_API_KEY", "synthetic-secret-canary"],
    ["EF_RESEND_URL", "https://api.resend.com"],
    ["EF_AGENT_RESPONDER", "harness"],
    ["ANTHROPIC_API_KEY", "synthetic-secret-canary"],
    ["OPENAI_API_KEY", "synthetic-secret-canary"],
    ["CODEX_HOME", "/Users/synthetic/.codex"],
    ["CLAUDE_CONFIG_DIR", "/Users/synthetic/.claude"],
    ["AWS_SECRET_ACCESS_KEY", "synthetic-secret-canary"],
    ["GOOGLE_APPLICATION_CREDENTIALS", "/credentials.json"],
  ])("refuses %s before starting anything without echoing its value", (name, value) => {
    let error: unknown;
    try {
      readPreviewEnvironment({ ...environment, [name]: value });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(value);
  });
  it.each([
    "http://public.example.test",
    "https://user:pass@preview.example.test",
    "https://preview.example.test/path",
    "https://preview.example.test?token=canary",
  ])("refuses an unsafe canonical origin %s", (origin) => {
    expect(() => readPreviewEnvironment({ ...environment, EF_PUBLIC_ORIGIN: origin })).toThrow();
  });
  it("keeps production entrypoint closed to preview identity", () => {
    expect(() => readPlatformEnvironment(environment)).toThrow("preview configuration requires");
    expect(() => readPlatformEnvironment({ EF_PREVIEW_AUTH: "fixture" })).toThrow(
      "preview configuration requires",
    );
  });
});
