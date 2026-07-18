import { spawn } from "node:child_process";
import { storeCredentials } from "../credentials.js";
import type { CliIo } from "../cli.js";

export const DEVICE_EXPIRED_EXIT = 11;
export const DEVICE_DENIED_EXIT = 12;

interface DeviceGrant {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly interval: number;
}

export interface LoginDependencies {
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly openBrowser?: (url: string) => void;
  readonly environment?: NodeJS.ProcessEnv;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function defaultOpenBrowser(url: string): void {
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.unref();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runLogin(
  noBrowser: boolean,
  io: CliIo,
  dependencies: LoginDependencies = {},
): Promise<number> {
  const environment = dependencies.environment ?? process.env;
  const fetcher = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? delay;
  const issuer = required(environment, "EF_OIDC_ISSUER").replace(/\/+$/, "");
  const clientId = required(environment, "EF_OIDC_CLIENT_ID");
  const serverUrl = required(environment, "EF_SERVER_URL").replace(/\/+$/, "");
  const scopes = ["openid", "profile", "email", "repo:write"].sort();

  const started = await fetcher(`${issuer}/oauth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: scopes.join(" ") }),
  });
  if (!started.ok) throw new Error(`device authorization failed (${started.status})`);
  const grant = (await started.json()) as Partial<DeviceGrant>;
  if (
    typeof grant.device_code !== "string" ||
    typeof grant.user_code !== "string" ||
    typeof grant.verification_uri !== "string" ||
    typeof grant.interval !== "number" ||
    !Number.isFinite(grant.interval) ||
    grant.interval < 0
  ) {
    throw new Error("device authorization returned an invalid response");
  }
  const approvalUrl = grant.verification_uri_complete ?? grant.verification_uri;
  io.stdout(`Device code: ${grant.user_code}\n`);
  io.stdout(`Verify at: ${approvalUrl}\n`);
  if (!noBrowser) (dependencies.openBrowser ?? defaultOpenBrowser)(approvalUrl);

  let intervalMilliseconds = grant.interval * 1_000;
  for (;;) {
    await sleep(intervalMilliseconds);
    const polled = await fetcher(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: clientId,
        device_code: grant.device_code,
      }),
    });
    const result = (await polled.json()) as Record<string, unknown>;
    if (!polled.ok) {
      if (result.error === "authorization_pending") continue;
      if (result.error === "slow_down") {
        intervalMilliseconds += 5_000;
        continue;
      }
      if (result.error === "expired_token") {
        io.stderr("Device code expired. Run `ef login` again.\n");
        return DEVICE_EXPIRED_EXIT;
      }
      if (result.error === "access_denied") {
        io.stderr("Device authorization was denied.\n");
        return DEVICE_DENIED_EXIT;
      }
      throw new Error(`device token request failed (${String(result.error ?? polled.status)})`);
    }
    if (typeof result.access_token !== "string" || typeof result.id_token !== "string") {
      throw new Error("device token response is missing credentials");
    }

    const registered = await fetcher(`${serverUrl}/api/device-grants`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${result.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idToken: result.id_token, name: "ef login", scopes }),
    });
    if (!registered.ok) throw new Error(`device grant registration failed (${registered.status})`);
    await storeCredentials(
      {
        accessToken: result.access_token,
        tokenType: "Bearer",
        issuer,
        clientId,
        scopes,
      },
      environment,
    );
    io.stdout("Login complete.\n");
    return 0;
  }
}
