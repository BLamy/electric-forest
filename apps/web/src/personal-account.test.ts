import { describe, expect, it } from "vitest";
import { personalAccount } from "./personal-account.js";

describe("personal account namespace", () => {
  it("does not invent an account before authentication", () => {
    expect(personalAccount(null)).toBeNull();
  });

  it("qualifies the readable name with the authenticated subject", () => {
    expect(personalAccount({ sub: "auth0|one", email: "Brett@example.test" })).toEqual({
      name: "Brett",
      namespace: "brett-9719be6ce62a",
    });
    expect(personalAccount({ sub: "auth0|two", email: "Brett@example.test" })?.namespace).not.toBe(
      "brett-9719be6ce62a",
    );
  });

  it.each([
    "a..b+notes@example.test",
    "😃@example.test",
    `${"long".repeat(30)}@example.test`,
    "main@example.test",
  ])("produces a valid bounded namespace for %s", (email) => {
    const account = personalAccount({ sub: "auth0|one", email })!;
    expect(account.namespace).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(account.namespace.length).toBeLessThanOrEqual(40);
    expect(account.namespace).not.toBe("main");
  });
});
