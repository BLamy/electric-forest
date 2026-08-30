import { extname, relative, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { resolveSessionBackedIdentity, type WhoamiOptions } from "../api/whoami.js";
import { isPublicSiteRoute } from "../route-topology.js";

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

/**
 * The served shell carries one bit of server truth: whether the request arrived with a
 * replayed session. The client uses it to choose between the public landing page and
 * the application at `/` without a whoami round trip (and without a flash of either).
 */
export const SESSION_SHELL_MARKER = '<meta name="ef-session" content="replayed">';

async function fileResponse(
  path: string,
  transform?: (text: string) => string,
): Promise<Response | null> {
  try {
    const bytes = await readFile(path);
    return new Response(transform === undefined ? bytes : transform(bytes.toString("utf8")), {
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
  const url = new URL(request.url);
  const identity = await resolveSessionBackedIdentity(request, options);
  const emittedAsset = url.pathname.startsWith("/assets/") && extname(url.pathname) !== "";
  // Emitted bundles are public because the public site is built from the same bundle;
  // they never carry a secret. Application routes remain behind the session gate.
  if (identity === null && !emittedAsset && !isPublicSiteRoute(url.pathname)) {
    return redirectToLogin();
  }
  const assetPath = safeAssetPath(options.webRoot, url.pathname);
  if (assetPath === null) return notFound();
  // Only emitted assets are extension-addressed. Application routes may carry
  // file-like StreamFS paths (`/blob/main/docs/readme.md`); treating those as
  // disk assets would return a platform 404 before the client router renders.
  const segments = url.pathname.split("/").filter(Boolean);
  const isSpaDeepRoute =
    (segments.length >= 4 && (segments[2] === "tree" || segments[2] === "blob")) ||
    (segments.length === 4 && segments[0] === "inspect");
  if (extname(url.pathname) !== "" && !url.pathname.startsWith("/assets/") && !isSpaDeepRoute) {
    return notFound();
  }
  if (url.pathname.startsWith("/assets/") && extname(url.pathname) !== "") {
    const asset = await fileResponse(assetPath);
    return asset ?? notFound();
  }
  const shell = await fileResponse(resolve(options.webRoot, "index.html"), (html) =>
    identity === null ? html : html.replace(/<head>/i, `<head>${SESSION_SHELL_MARKER}`),
  );
  return shell ?? notFound();
}
