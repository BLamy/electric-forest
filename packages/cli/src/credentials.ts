import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const NO_CREDENTIALS_MESSAGE = "No credentials. Run `ef login`.";

export interface StoredCredentials {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly issuer: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export function credentialsDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.EF_HOME ?? join(homedir(), ".eforest");
}

export function credentialsPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(credentialsDirectory(environment), "credentials.json");
}

function isCredentials(value: unknown): value is StoredCredentials {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.accessToken === "string" &&
    record.accessToken.length > 0 &&
    record.tokenType === "Bearer" &&
    typeof record.issuer === "string" &&
    typeof record.clientId === "string" &&
    Array.isArray(record.scopes) &&
    record.scopes.every((scope) => typeof scope === "string")
  );
}

export async function loadCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<StoredCredentials | null> {
  try {
    const value: unknown = JSON.parse(await readFile(credentialsPath(environment), "utf8"));
    if (!isCredentials(value)) throw new Error("credentials.json has an invalid shape");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function storeCredentials(
  credentials: StoredCredentials,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const directory = credentialsDirectory(environment);
  const path = credentialsPath(environment);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function clearCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(credentialsPath(environment), { force: true });
}

export async function bearerHeaders(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<Record<string, string>> | null> {
  const credentials = await loadCredentials(environment);
  return credentials === null ? null : { authorization: `Bearer ${credentials.accessToken}` };
}
