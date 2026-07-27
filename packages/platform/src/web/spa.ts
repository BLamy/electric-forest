import { extname, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { resolveSessionBackedIdentity, type WhoamiOptions } from "../api/whoami.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function redirectToLogin(): Response {
  return new Response(null, { status: 302, headers: { location: "/auth/login" } });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: { class: "not-found" } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function safeAssetPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) {
    return null;
  }
  const candidate = resolve(root, `.${decoded}`);
  const within = relative(root, candidate);
  if (within === ".." || within.startsWith(`..${sep}`) || resolve(root, within) !== candidate) {
    return null;
  }
  return candidate;
}

async function fileResponse(path: string): Promise<Response | null> {
  try {
    const bytes = await readFile(path);
    return new Response(bytes, {
      headers: {
        "cache-control": "no-store",
        "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface SpaHandlerOptions extends WhoamiOptions {
  readonly webRoot: string;
}

export async function spaResponse(request: Request, options: SpaHandlerOptions): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: { class: "method-not-allowed" } }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  if ((await resolveSessionBackedIdentity(request, options)) === null) return redirectToLogin();
  const url = new URL(request.url);
  const assetPath = safeAssetPath(options.webRoot, url.pathname);
  if (assetPath === null) return notFound();
  if (extname(url.pathname) !== "") {
    const asset = await fileResponse(assetPath);
    return asset ?? notFound();
  }
  return (await fileResponse(resolve(options.webRoot, "index.html"))) ?? notFound();
}
