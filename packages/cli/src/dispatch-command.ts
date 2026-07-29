import { loadCredentials, NO_CREDENTIALS_MESSAGE } from "./credentials.js";
import type { CliIo } from "./cli.js";

export async function runAuthenticatedDispatch(
  streamId: string,
  eventJson: string,
  io: CliIo,
  environment: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const credentials = await loadCredentials(environment);
  if (credentials === null) {
    io.stderr(`${NO_CREDENTIALS_MESSAGE}\n`);
    return 10;
  }
  const baseUrl = environment.EF_SERVER_URL;
  if (baseUrl === undefined || baseUrl.length === 0) throw new Error("EF_SERVER_URL is required");
  let event: unknown;
  try {
    event = JSON.parse(eventJson);
  } catch {
    io.stderr("event must be valid JSON\n");
    return 2;
  }
  const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/api/dispatch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ streamId, event }),
  });
  const text = await response.text();
  if (response.status === 401) {
    io.stderr(`${text}\n`);
    return 13;
  }
  if (!response.ok) {
    io.stderr(`${text}\n`);
    return 1;
  }
  io.stdout(`${text}\n`);
  return 0;
}
