import { spawn } from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { appendFile } from "node:fs/promises";

const output = process.env.E2_T04_PROCESS_NETWORK_LOG;
if (output === undefined) throw new Error("E2_T04_PROCESS_NETWORK_LOG is required");
if (process.env.E2_T04_OS_SANDBOX_ACTIVE !== "1") {
  throw new Error("E2-T04 network canaries must run inside the OS loopback sandbox");
}

async function refused(label, operation) {
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) throw new Error(`${label} unexpectedly reached non-loopback network`);
  await appendFile(output, `OS_SANDBOX_REFUSED ${label}\n`);
}

function request(get) {
  return new Promise((resolve, reject) => {
    const request = get(resolve);
    request.once("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("timeout")));
  });
}

const loopbackServer = http.createServer((_request, response) => response.end("ok"));
await new Promise((resolve, reject) => {
  loopbackServer.once("error", reject);
  loopbackServer.listen(0, "127.0.0.1", resolve);
});
const address = loopbackServer.address();
if (address === null || typeof address === "string")
  throw new Error("loopback canary did not bind");
const loopbackResponse = await request((resolve) =>
  http.get(`http://127.0.0.1:${String(address.port)}/e2-t04-loopback-canary`, resolve),
);
loopbackResponse.resume();
await new Promise((resolve) => loopbackResponse.once("end", resolve));
await new Promise((resolve, reject) =>
  loopbackServer.close((error) => (error === undefined ? resolve() : reject(error))),
);
await appendFile(output, "OS_SANDBOX_ALLOWED http-loopback\n");

const dnsResult = await new Promise((resolve) =>
  dns.resolve4("auth0.com", (error, addresses) =>
    resolve(error === null ? `resolved:${addresses.length}` : `refused:${error.code}`),
  ),
);
await appendFile(output, `OS_SANDBOX_DNS_LOOKUP auth0.com ${dnsResult}\n`);
await refused(
  "net.connect 1.1.1.1:443",
  () =>
    new Promise((resolve, reject) => {
      const socket = net.connect({ host: "1.1.1.1", port: 443 });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
      socket.setTimeout(2_000, () => socket.destroy(new Error("timeout")));
    }),
);
await refused("https.get auth0.com", () =>
  request((resolve) => https.get("https://auth0.com/e2-t04-https-canary", resolve)),
);
await refused(
  "subprocess curl auth0.com",
  () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/curl",
        ["-sS", "-I", "--max-time", "2", "https://auth0.com/e2-t04-curl-canary"],
        {
          stdio: "ignore",
        },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`curl exit ${String(code)}`)),
      );
    }),
);

process.stdout.write(
  "E2_T04_OS_NETWORK_GUARD_OK loopback=true dns-observed=true socket=true https=true subprocess=true\n",
);
