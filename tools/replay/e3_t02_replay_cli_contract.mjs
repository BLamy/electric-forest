import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const replayCliIdentity = Object.freeze({
  name: "replayio",
  version: "1.8.2",
  bin: "./bin.js",
  integrity:
    "sha512-0LwdJmtI/HZMFIuXkkuWIBHM9MJpQ/Tmh5OZJek9L7JFiny0cOGtfyv49IhZ3FRP2I17fPZePf0GLG3wGamOFg==",
  treeFiles: 150,
  treeSha256: "a42492bf55bbc9dbfb8b5c749aef170f07a0de33ccd5848bce216ecb1e36f7ab",
});

function contractFailure(message) {
  throw new Error(`E3-T02 Replay CLI contract: ${message}`);
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function computePackageTreeDigest(packageRoot) {
  const root = realpathSync(packageRoot);
  const entries = [];
  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        const relativePath = relative(root, path).split(sep).join("/");
        const fileSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
        entries.push(`${relativePath}\0${fileSha256}`);
      }
    }
  }
  visit(root);
  entries.sort();
  return {
    files: entries.length,
    sha256: createHash("sha256").update(entries.join("\n")).digest("hex"),
  };
}

export function resolvePinnedReplayCli(projectRoot) {
  const root = realpathSync(projectRoot);
  const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (rootPackage.devDependencies?.replayio !== replayCliIdentity.version) {
    contractFailure("root devDependency is not the exact pinned version");
  }
  const lock = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
  if (
    !/^\s{6}replayio:\n\s{8}specifier: 1\.8\.2\n\s{8}version: 1\.8\.2(?:\(|\n)/m.test(lock) ||
    !lock.includes(`replayio@1.8.2:\n    resolution: {integrity: ${replayCliIdentity.integrity}}`)
  ) {
    contractFailure("lockfile importer does not bind replayio 1.8.2");
  }

  const shimPath = resolve(root, "node_modules/.bin/replayio");
  const shimStat = lstatSync(shimPath);
  if (!shimStat.isFile() || shimStat.isSymbolicLink()) {
    contractFailure("workspace replayio shim is not a real file");
  }
  const shimRealPath = realpathSync(shimPath);
  if (!isWithin(realpathSync(resolve(root, "node_modules/.bin")), shimRealPath)) {
    contractFailure("workspace replayio shim resolves outside node_modules/.bin");
  }
  const packageRoot = realpathSync(resolve(root, "node_modules/replayio"));
  const pnpmStore = realpathSync(resolve(root, "node_modules/.pnpm"));
  if (
    !isWithin(pnpmStore, packageRoot) ||
    !packageRoot.includes(`${sep}replayio@1.8.2_`) ||
    !packageRoot.endsWith(`${sep}node_modules${sep}replayio`)
  ) {
    contractFailure("resolved replayio package is outside the pinned pnpm package path");
  }
  const packageIdentity = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  if (
    packageIdentity.name !== replayCliIdentity.name ||
    packageIdentity.version !== replayCliIdentity.version ||
    packageIdentity.bin !== replayCliIdentity.bin
  ) {
    contractFailure("installed replayio package identity does not match the lock");
  }
  const binPath = realpathSync(resolve(packageRoot, replayCliIdentity.bin));
  if (!isWithin(packageRoot, binPath) || !lstatSync(binPath).isFile()) {
    contractFailure("resolved Replay CLI entrypoint escapes its package");
  }
  const tree = computePackageTreeDigest(packageRoot);
  if (tree.files !== replayCliIdentity.treeFiles || tree.sha256 !== replayCliIdentity.treeSha256) {
    contractFailure("installed Replay CLI package tree does not match the pinned digest");
  }
  return { root, shimPath, shimRealPath, packageRoot, binPath };
}

const allowedEnvironment = Object.freeze([
  "RECORD_REPLAY_API_KEY",
  "RECORD_REPLAY_SERVER",
  "REPLAY_API_KEY",
  "REPLAY_API_SERVER",
  "REPLAY_APP_SERVER",
  "REPLAY_AUTH_CLIENT_ID",
  "REPLAY_AUTH_HOST",
  "REPLAY_SERVER",
  "REPLAY_TELEMETRY_DISABLED",
]);

export function buildTrustedReplayEnvironment(source, recordingDirectory) {
  const identity = userInfo();
  const env = {
    HOME: identity.homedir,
    LOGNAME: identity.username,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: tmpdir(),
    USER: identity.username,
  };
  for (const name of allowedEnvironment) {
    if (typeof source[name] === "string" && source[name] !== "") env[name] = source[name];
  }
  if (recordingDirectory !== undefined) {
    env.RECORD_REPLAY_DIRECTORY = recordingDirectory;
  }
  return env;
}
