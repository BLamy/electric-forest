async (page) => {
  const telemetryState = {
    activity: 0,
    failures: [],
  };
  Object.defineProperty(page, "__eforestE3T02Telemetry", {
    configurable: true,
    enumerable: false,
    value: telemetryState,
  });
  const recordTelemetryFailure = (failure) => {
    telemetryState.activity += 1;
    telemetryState.failures.push(failure);
  };
  const sourceMapRequests = new Set();
  let sourceMapActivity = 0;
  page.on("console", (message) => {
    if (message.type() === "error") {
      recordTelemetryFailure({
        class: "console.error",
        detail: message.text(),
      });
    }
  });
  page.on("pageerror", (error) => {
    recordTelemetryFailure({
      class: "pageerror",
      detail: error.message,
    });
  });
  page.on("request", (request) => {
    if (request.url().endsWith(".js.map")) {
      sourceMapActivity += 1;
      sourceMapRequests.add(request);
    }
  });
  page.on("requestfinished", (request) => {
    sourceMapRequests.delete(request);
  });
  page.on("requestfailed", (request) => {
    sourceMapRequests.delete(request);
    recordTelemetryFailure({
      class: "requestfailed",
      detail: `${request.url()} (${request.failure()?.errorText ?? "unknown failure"})`,
    });
  });
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
  // Read the origin only after landing back on the app: before login the page
  // sits on the emulator, whose origin is a different port. The run-code
  // sandbox has no URL global, so read it from the page.
  const origin = await page.evaluate(() => window.location.origin);

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

  // Replay Chromium fetches source maps asynchronously for time-travel source
  // mapping. Do not navigate away while a map fetch is still scheduled or in
  // flight: Chromium reports that cancellation as requestfailed, and the
  // recording must fail closed on every request failure.
  let settledSourceMapActivity = -1;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (sourceMapRequests.size === 0 && settledSourceMapActivity === sourceMapActivity) {
      break;
    }
    settledSourceMapActivity = sourceMapRequests.size === 0 ? sourceMapActivity : -1;
    await page.waitForTimeout(100);
  }
  if (sourceMapRequests.size > 0 || settledSourceMapActivity !== sourceMapActivity) {
    throw new Error(
      `source-map requests did not settle: activity=${String(sourceMapActivity)} in-flight=${String(sourceMapRequests.size)}`,
    );
  }

  // Scene 5 — logout returns to logged-out and clears the session cookie.
  await page.getByRole("link", { name: "Home" }).click();
  await page.getByTestId("identity-region").waitFor();
  await page.getByRole("button", { name: "Log out" }).click();
  await page.getByTestId("auth0-fixture-login-form").waitFor();

  if (telemetryState.failures.length > 0) {
    throw new Error(
      `recording tripwire observed browser failures: ${JSON.stringify(telemetryState.failures)}`,
    );
  }

  return {
    origin,
    triple,
    identity,
    partialTripleElements: partials.length,
    documentLoads: { before: navigationsBefore, after: navigationsAfter },
    sourceMapActivity,
    telemetryFailures: telemetryState.failures,
  };
};
