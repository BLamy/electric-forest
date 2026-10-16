import { createPreviewRuntime } from "./preview.js";

try {
  const runtime = await createPreviewRuntime(process.env);
  await runtime.start();
  process.stdout.write(
    `Electric Forest PUBLIC DISPOSABLE PREVIEW ready revision=${runtime.config.revision} port=${String(runtime.config.port)} agents=off integrations=off\n`,
  );
  const stop = (): void => {
    void runtime.close().then(
      () => process.exit(0),
      () => {
        process.stderr.write("preview shutdown failed\n");
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "preview startup failed"}\n`);
  process.exitCode = 1;
}
