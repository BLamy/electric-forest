import { appendFileSync } from "node:fs";

const output = process.env.E2_T04_PROCESS_NETWORK_LOG;
const originalFetch = globalThis.fetch;

function record(line) {
  if (output !== undefined) appendFileSync(output, `${line}\n`);
}

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  const target = `${request.method} ${url.protocol}//${url.hostname}${url.pathname}`;
  if (!loopback) {
    record(`PROCESS_REFUSED ${target}`);
    throw new TypeError(`process network guard refused ${url.hostname}`);
  }
  record(`PROCESS_ALLOWED ${target}`);
  const response = await originalFetch(request);
  record(`PROCESS_RESPONSE ${String(response.status)} ${target}`);
  return response;
};
