import { createHostedRuntime, HOSTED_LIMITS } from "./hosted.js";

const startup = setTimeout(() => {
  process.stderr.write("hosted readiness deadline exceeded\n");
  process.exit(1);
}, HOSTED_LIMITS.readinessMs);
try {
  const runtime = await createHostedRuntime(process.env);
  await runtime.start();
  clearTimeout(startup);
  process.stdout.write(
    `Electric Forest ready mode=production auth=auth0 revision=${runtime.config.revision} port=${String(runtime.config.port)} agents=${runtime.config.agents} integrations=off\n`,
  );
  const stop = (): void => {
    const deadline = setTimeout(() => {
      process.stderr.write("hosted drain deadline exceeded\n");
      process.exit(1);
    }, HOSTED_LIMITS.drainMs);
    void runtime.close().then(
      () => {
        clearTimeout(deadline);
        process.exit(0);
      },
      () => {
        process.stderr.write("hosted shutdown failed\n");
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch {
  clearTimeout(startup);
  // Configuration, filesystem and provider messages may contain private input. Log no values.
  process.stderr.write(
    "hosted startup refused; validate configuration, artifact and private volume\n",
  );
  process.exitCode = 1;
}
