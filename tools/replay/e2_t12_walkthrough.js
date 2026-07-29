async (page) => {
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  const origin = new URL(page.url()).origin;
  const replace = async (locator, value) => {
    await locator.click();
    await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await locator.type(value);
  };
  const proof = async (testId) => {
    const log = page.getByTestId("proof-log");
    const before = await log.textContent();
    await page.getByTestId(testId).click();
    await page.waitForFunction(
      ({ previous }) =>
        document.querySelector('[data-testid="proof-log"]')?.textContent !== previous,
      { previous: before },
    );
    return JSON.parse((await log.textContent()) ?? "{}");
  };

  await page.getByTestId("login").click();
  await page.getByTestId("auth0-login-form").waitFor();
  await replace(page.getByTestId("auth0-login-email"), "gate@example.test");
  await replace(page.getByTestId("auth0-login-password"), "LockedGate1234!");
  await Promise.all([
    page.waitForURL((url) => url.origin === origin && url.pathname === "/"),
    page.getByTestId("auth0-login-submit").click(),
  ]);
  await page.locator('[data-auth-state="logged-in"]').waitFor();
  await page.getByTestId("cli-tokens-link").click();
  await page.locator('input[name="name"]').click();
  await page.locator('input[name="name"]').type("capstone workstation");
  await page.getByRole("button", { name: "Mint token" }).click();
  const secret = page.getByTestId("cli-token-secret");
  await secret.waitFor({ state: "visible" });
  const token = (await secret.textContent()) ?? "";
  const item = page.getByTestId("cli-token-list").locator("li");
  await item.waitFor();
  const grantId = (await item.getAttribute("data-grant-id")) ?? "";
  if (!token.startsWith("ef_cli_") || !grantId.startsWith("grant_")) {
    throw new Error("web session did not mint a CLI credential");
  }

  await page.goto(`${origin}/__e2_t12`);
  await replace(page.getByTestId("grant-id"), grantId);
  await replace(page.getByTestId("cli-token"), token);
  const mint = await proof("register-token");
  if (mint.rawSecretStored !== false) throw new Error("identity stream stored raw CLI secret");
  const authorized = await proof("authorized-cli");
  if (authorized.cli?.exitCode !== 0 || authorized.after?.count !== authorized.before?.count + 1) {
    throw new Error("authorized CLI dispatch did not append exactly one event");
  }
  const tokenless = await proof("tokenless");
  if (tokenless.status !== 401 || tokenless.byteIdentical !== true) {
    throw new Error("tokenless refusal was not typed and byte-neutral");
  }

  await page.getByTestId("tokens-link").click();
  await page.getByRole("button", { name: "Revoke" }).click();
  await item.waitFor({ state: "detached" });
  await page.goto(`${origin}/__e2_t12`);
  const revoked = await proof("revoked-cli");
  if (revoked.cli?.exitCode !== 13 || revoked.byteIdentical !== true) {
    throw new Error("revoked CLI refusal was not exit 13 and byte-neutral");
  }
  await page.getByTestId("refresh-proof").click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="proof-log"]')?.textContent?.includes('"revoked"'),
  );
  const finalState = JSON.parse((await page.getByTestId("proof-log").textContent()) ?? "{}");
  if (!/^[0-9a-f]{40}$/.test(finalState.proof?.sha ?? "")) {
    throw new Error("recording is not bound to an immutable proof SHA");
  }
  const requestUrls = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("http")),
  );
  if (
    requestUrls.some(
      (value) => !["127.0.0.1", "localhost", "::1"].includes(new URL(value).hostname),
    )
  ) {
    throw new Error("browser made a non-loopback request");
  }
  if (consoleErrors.length !== 0) throw new Error(consoleErrors.join("\n"));
  return {
    status: "E2_T12_REPLAY_WALKTHROUGH_OK",
    proofSha: finalState.proof.sha,
    consoleErrors: 0,
    nonLoopbackRequests: 0,
    authorizedOffset: authorized.after.offset,
    authorizedDigest: authorized.after.digest,
    tokenlessByteIdentical: tokenless.byteIdentical,
    revokedByteIdentical: revoked.byteIdentical,
  };
};
