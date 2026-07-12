import { startServer } from "./harness.js";

interface Options {
  readonly seed: number;
  readonly iterations: number;
}

function options(args: readonly string[]): Options {
  const seedIndex = args.indexOf("--seed");
  const iterationsIndex = args.indexOf("--iterations");
  const seed = seedIndex >= 0 ? Number(args[seedIndex + 1]) : 20260712;
  const iterations = iterationsIndex >= 0 ? Number(args[iterationsIndex + 1]) : 256;
  if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error("usage: fuzz --seed <integer> [--iterations <positive integer>]");
  }
  return { seed, iterations };
}

function next(state: { value: number }): number {
  state.value = (state.value * 1664525 + 1013904223) >>> 0;
  return state.value;
}

async function runVariant(variant: "memory" | "file", config: Options): Promise<void> {
  const server = await startServer(variant);
  const random = { value: config.seed >>> 0 };
  try {
    const stream = `fuzz-${variant}`;
    const created = await fetch(`${server.baseUrl}/streams/${stream}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fuzz: true }),
    });
    if (created.status !== 201)
      throw new Error(`${variant} setup create returned ${created.status}`);
    for (let index = 0; index < config.iterations; index += 1) {
      const choice = next(random) % 5;
      let response: Response;
      if (choice === 0) {
        response = await fetch(`${server.baseUrl}/streams/${stream}?offset=-2`);
      } else if (choice === 1) {
        response = await fetch(`${server.baseUrl}/streams/${stream}`, {
          method: "POST",
          headers: { "content-type": "application/json", "stream-seq": "0" },
          body: "{",
        });
      } else if (choice === 2) {
        response = await fetch(`${server.baseUrl}/streams/${stream}`, {
          method: "POST",
          headers: { "content-type": "text/plain", "stream-seq": "0" },
          body: "not-json",
        });
      } else if (choice === 3) {
        response = await fetch(`${server.baseUrl}/streams/${stream}`, {
          method: "POST",
          headers: { "content-type": "application/json", "stream-seq": "0" },
          body: JSON.stringify({ events: [{ type: "push", payload: index, ts: index }] }),
        });
      } else {
        response = await fetch(`${server.baseUrl}/streams/${stream}?offset=not-an-offset`);
      }
      await response.arrayBuffer();
    }
  } catch (error) {
    throw new Error(
      `${variant} seed ${config.seed} iteration failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await server.stop();
  }
}

const config = options(process.argv.slice(2));
console.log(`fuzz seed=${config.seed} iterations=${config.iterations}`);
for (const variant of ["memory", "file"] as const) await runVariant(variant, config);
console.log("fuzz: no crash or unhandled response");
