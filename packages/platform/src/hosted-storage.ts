import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";

interface Marker {
  readonly version: 1;
  readonly mode: "private-auth0";
  readonly issuer: string;
  readonly clientId: string;
  readonly keyHash: string;
  readonly phase: "initializing" | "ready";
}
interface Journal extends Marker {
  readonly secret: string;
}
export interface HostedStorage {
  readonly secret: string;
  readonly initializing: boolean;
  ready(): Promise<void>;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

async function regularPrivate(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("hosted signing state must be a private regular file");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Atomic publication and fsync; a complete journal is the only resumable init state. */
async function publish(directory: string, name: string, value: string): Promise<void> {
  const temporary = resolve(directory, `${name}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, resolve(directory, name));
  await syncDirectory(directory);
}

function parseMarker(value: unknown, issuer: string, clientId: string): Marker {
  const marker = value as Partial<Marker> | null;
  if (
    marker === null ||
    typeof marker !== "object" ||
    marker.version !== 1 ||
    marker.mode !== "private-auth0" ||
    marker.issuer !== issuer ||
    marker.clientId !== clientId ||
    !/^[a-f0-9]{64}$/.test(marker.keyHash ?? "") ||
    (marker.phase !== "initializing" && marker.phase !== "ready")
  ) {
    throw new Error("hosted volume marker is incompatible");
  }
  const fields = [
    "version",
    "mode",
    "issuer",
    "clientId",
    "keyHash",
    "phase",
    ...(marker.phase === "initializing" ? ["secret"] : []),
  ].sort();
  if (JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(fields))
    throw new Error("hosted volume marker has unknown fields");
  return {
    version: 1,
    mode: "private-auth0",
    issuer,
    clientId,
    keyHash: marker.keyHash!,
    phase: marker.phase,
  };
}

async function readKey(path: string): Promise<string> {
  await regularPrivate(path);
  const value = await readFile(path, "utf8");
  if (!/^[A-Za-z0-9_-]{64}\n$/.test(value)) throw new Error("hosted signing key is corrupt");
  return value.slice(0, -1);
}

export async function prepareHostedStorage(
  directory: string,
  issuer: string,
  clientId: string,
): Promise<HostedStorage> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o700) {
    throw new Error("hosted data directory must be private and must not be a symlink");
  }
  let entries = await readdir(directory);
  if (entries.length === 0) {
    const secret = randomBytes(48).toString("base64url");
    const journal: Journal = {
      version: 1,
      mode: "private-auth0",
      issuer,
      clientId,
      keyHash: hash(secret),
      phase: "initializing",
      secret,
    };
    await publish(directory, "bootstrap.json", `${JSON.stringify(journal)}\n`);
    entries = ["bootstrap.json"];
  }
  if (
    entries.includes("preview-state.json") ||
    entries.some((name) => name.endsWith(".tmp")) ||
    entries.some(
      (name) => !["bootstrap.json", "hosted-state.json", "session.key", "streams"].includes(name),
    )
  ) {
    throw new Error("hosted volume contains unknown or incomplete state; refusing to reset it");
  }
  const ready = entries.includes("hosted-state.json");
  let marker: Marker;
  let secret: string;
  if (ready) {
    await regularPrivate(resolve(directory, "hosted-state.json"));
    marker = parseMarker(
      JSON.parse(await readFile(resolve(directory, "hosted-state.json"), "utf8")),
      issuer,
      clientId,
    );
    if (marker.phase !== "ready" || !entries.includes("streams"))
      throw new Error("hosted ready volume is incomplete");
    secret = await readKey(resolve(directory, "session.key"));
  } else {
    if (!entries.includes("bootstrap.json"))
      throw new Error("hosted volume has no initialization journal");
    await regularPrivate(resolve(directory, "bootstrap.json"));
    const journal = JSON.parse(
      await readFile(resolve(directory, "bootstrap.json"), "utf8"),
    ) as Journal;
    marker = parseMarker(journal, issuer, clientId);
    if (marker.phase !== "initializing")
      throw new Error("hosted initialization journal is invalid");
    secret = journal.secret;
    if (entries.includes("session.key")) {
      if ((await readKey(resolve(directory, "session.key"))) !== secret)
        throw new Error("hosted signing key differs from initialization journal");
    } else if (typeof secret === "string" && /^[A-Za-z0-9_-]{64}$/.test(secret)) {
      await publish(directory, "session.key", `${secret}\n`);
    }
  }
  if (
    typeof secret !== "string" ||
    !/^[A-Za-z0-9_-]{64}$/.test(secret) ||
    hash(secret) !== marker.keyHash
  ) {
    throw new Error("hosted signing key is invalid; refusing to replace accepted state");
  }
  if (entries.includes("streams")) {
    const store = await lstat(resolve(directory, "streams"));
    if (!store.isDirectory() || store.isSymbolicLink())
      throw new Error("hosted stream directory is invalid");
  }
  return {
    secret,
    initializing: !ready,
    ready: async () => {
      if (!ready)
        await publish(
          directory,
          "hosted-state.json",
          `${JSON.stringify({ ...marker, phase: "ready" })}\n`,
        );
      if (entries.includes("bootstrap.json")) {
        await unlink(resolve(directory, "bootstrap.json"));
        await syncDirectory(directory);
      }
    },
  };
}
