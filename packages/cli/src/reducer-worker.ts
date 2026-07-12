import { replayDigestLocal, ReplayCliError } from "./replay-command.js";

const [path, reducerPath] = process.argv.slice(2);
if (!path || !reducerPath || !process.send) process.exit(2);

// Reducer modules execute in this process, so they must never inherit the wrapper's
// private completion channel or be able to turn an import-time exit into a clean,
// result-shaped transcript. Keep both capabilities only in this module's closure.
const sendResult = process.send.bind(process);
const exitProcess = process.exit.bind(process);
Reflect.deleteProperty(process, "send");
process.exit = ((code?: number | string | null): never => {
  throw new Error(`reducer attempted to exit (${String(code ?? 0)})`);
}) as typeof process.exit;

try {
  const digest = await replayDigestLocal(path, reducerPath);
  sendResult({ ok: true, digest }, undefined, undefined, (error) => {
    exitProcess(error ? 2 : 0);
  });
} catch (error) {
  sendResult(
    {
      ok: false,
      error: error instanceof ReplayCliError ? error.message : "custom reducer failed",
    },
    undefined,
    undefined,
    (sendError) => {
      exitProcess(sendError ? 2 : 0);
    },
  );
}
