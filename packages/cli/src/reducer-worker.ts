import { replayDigestLocal, ReplayCliError } from "./replay-command.js";

const [path, reducerPath] = process.argv.slice(2);
if (!path || !reducerPath || !process.send) process.exit(2);

try {
  const digest = await replayDigestLocal(path, reducerPath);
  process.send({ ok: true, digest });
} catch (error) {
  process.send({
    ok: false,
    error: error instanceof ReplayCliError ? error.message : "custom reducer failed",
  });
}
