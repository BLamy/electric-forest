async (page) => {
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    consoleErrors.push(`requestfailed: ${request.url()}`);
  });
  // The run-code sandbox has no URL global; read the origin from the page.
  const origin = await page.evaluate(() => window.location.origin);

  // Scene 1 — the gate. An unauthenticated app route lands on the emulator
  // login form, not the shell.
  await page.getByTestId("auth0-fixture-login-form").waitFor();
  if ((await page.locator('input[type="password"]').count()) !== 0) {
    throw new Error("fixture login exposed a password field");
  }

  // Scene 2 — login to shell.
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/"),
    page.getByTestId("auth0-fixture-login-submit").click(),
  ]);
  await page.getByTestId("identity-region").waitFor();

  // Scene 3 — the identity triple, visible in the DOM at a point a critic can
  // cross-check against the transcript's out-of-band values.
  const region = page.getByTestId("identity-region");
  const triple = {
    stream: await region.getAttribute("data-ef-stream"),
    offset: await region.getAttribute("data-ef-offset"),
    digest: await region.getAttribute("data-ef-digest"),
  };
  const identity = {
    sub: await page.getByTestId("identity-sub").textContent(),
    email: await page.getByTestId("identity-email").textContent(),
  };
  if (!triple.stream || !triple.offset || !triple.digest) {
    throw new Error(`identity region carries a partial triple: ${JSON.stringify(triple)}`);
  }

  // No partial triples anywhere in the rendered document.
  const partials = await page.evaluate(() => {
    const attrs = ["data-ef-stream", "data-ef-offset", "data-ef-digest"];
    return [...document.querySelectorAll("*")]
      .filter((element) => {
        const present = attrs.filter((attr) => element.hasAttribute(attr));
        return present.length > 0 && present.length < attrs.length;
      })
      .map((element) => element.tagName);
  });
  if (partials.length > 0) {
    throw new Error(`partial triple regions: ${JSON.stringify(partials)}`);
  }

  // Scene 4 — client-side routing driven through real links, exactly as the
  // shell suite drives it. The navigation-entry count is the document-load
  // probe: it must still be 1 after the whole walk.
  const navigationsBefore = await page.evaluate(
    () => performance.getEntriesByType("navigation").length,
  );
  await page.getByRole("link", { name: "Maple" }).click();
  await page.getByTestId("route-org").waitFor();
  await page.getByRole("link", { name: "Reading room" }).click();
  await page.getByTestId("route-repo").waitFor();
  await page.goBack();
  await page.getByTestId("route-org").waitFor();
  await page.goForward();
  await page.getByTestId("route-repo").waitFor();
  await page.getByRole("link", { name: "Missing trail" }).click();
  await page.getByTestId("route-not-found").waitFor();
  const navigationsAfter = await page.evaluate(
    () => performance.getEntriesByType("navigation").length,
  );
  if (navigationsAfter !== 1) {
    throw new Error(`SPA performed ${navigationsAfter} document loads, expected 1`);
  }

  // Scene 5 — logout returns to logged-out and clears the session cookie.
  await page.getByRole("link", { name: "Home" }).click();
  await page.getByTestId("identity-region").waitFor();
  await page.getByRole("button", { name: "Log out" }).click();
  await page.getByTestId("auth0-fixture-login-form").waitFor();

  return {
    origin,
    triple,
    identity,
    partialTripleElements: partials.length,
    documentLoads: { before: navigationsBefore, after: navigationsAfter },
    consoleErrors,
  };
}
