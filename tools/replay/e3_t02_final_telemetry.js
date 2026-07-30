async (page) => {
  const telemetryState = page.__eforestE3T02Telemetry;
  if (
    !telemetryState ||
    !Array.isArray(telemetryState.failures) ||
    !Number.isInteger(telemetryState.activity)
  ) {
    throw new Error("recording telemetry state did not persist on the Playwright page");
  }

  // Browser events can be delivered after the walkthrough command has returned.
  // Require the live store to stay unchanged for two samples before serializing
  // the final pre-publish snapshot.
  let stableSamples = 0;
  let observedActivity = telemetryState.activity;
  for (let attempt = 0; attempt < 20 && stableSamples < 2; attempt += 1) {
    await page.waitForTimeout(100);
    if (telemetryState.activity === observedActivity) {
      stableSamples += 1;
    } else {
      observedActivity = telemetryState.activity;
      stableSamples = 0;
    }
  }
  if (stableSamples < 2) {
    throw new Error(
      `recording telemetry did not quiesce: activity=${String(telemetryState.activity)}`,
    );
  }

  return {
    activity: telemetryState.activity,
    stableSamples,
    telemetryFailures: telemetryState.failures.map((failure) => ({ ...failure })),
  };
};
