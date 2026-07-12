import { createHttpServer } from "../../../packages/server/dist/src/http.js";
import { createDefaultReducerRegistry } from "../../../packages/server/dist/src/redux/reducers.js";
import { FileStreamStore } from "../../../packages/server/dist/src/store/file.js";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dataDir = arg("data-dir");
const port = Number(arg("port") ?? "0");
if (!dataDir || !Number.isSafeInteger(port) || port < 0 || port > 65_535) {
  throw new Error("capstone server requires --data-dir and a valid --port");
}
const server = createHttpServer(new FileStreamStore(dataDir), {
  reducerRegistry: createDefaultReducerRegistry(),
  longPollTimeoutMs: 50,
  sseHeartbeatMs: 20,
});
server.once("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("capstone server did not bind");
  process.stdout.write(`LISTENING http://127.0.0.1:${address.port}\n`);
});
const shutdown = () => server.close(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
