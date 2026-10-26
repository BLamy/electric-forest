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

const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#0f1010"/><path d="M16 6c-4.5 0-8 3.8-8 8.5 0 4.1 2.5 7.3 6 8.2V27h4v-4.3c3.5-.9 6-4.1 6-8.2C24 9.8 20.5 6 16 6Z" fill="#48b979"/><circle cx="13" cy="14" r="1.5" fill="#0f1010"/><circle cx="19" cy="14" r="1.5" fill="#0f1010"/></svg>';
const REPLAY_QA_SECURITY_NONCE = "loopqa-sec-1TOLLVrqSC11nfIyd7tVP7CfyO7d6mJhPdW8KMvCPTQ";

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

/** Only browser-verify harnesses install the optional proof receipt endpoint. */
export const PROOF_RECEIPT_SHELL_MARKER = '<meta name="ef-proof-receipt" content="available">';

async function fileResponse(
  path: string,
  transform?: (text: string) => string,
  cacheControl = "no-store",
): Promise<Response | null> {
  try {
    const bytes = await readFile(path);
    return new Response(transform === undefined ? bytes : transform(bytes.toString("utf8")), {
      headers: {
        "cache-control": cacheControl,
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
  readonly retainLoginTarget?: boolean;
  /** Test-only marker for the browser-verify proof receipt endpoint. */
  readonly proofReceiptAvailable?: boolean;
}

export async function spaResponse(request: Request, options: SpaHandlerOptions): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: { class: "method-not-allowed" } }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  const url = new URL(request.url);
  if (url.pathname === "/.well-known/replay-qa-security-nonce") {
    return new Response(request.method === "HEAD" ? null : REPLAY_QA_SECURITY_NONCE, {
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  }
  const identity = await resolveSessionBackedIdentity(request, options);
  const emittedAsset = url.pathname.startsWith("/assets/") && extname(url.pathname) !== "";
  const favicon = url.pathname === "/favicon.ico";
  // Emitted bundles are public because the public site is built from the same bundle;
  // they never carry a secret. Application routes remain behind the session gate.
  if (identity === null && !emittedAsset && !favicon && !isPublicSiteRoute(url.pathname)) {
    if (options.retainLoginTarget === true) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `/auth/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
          "cache-control": "no-store",
        },
      });
    }
    return redirectToLogin();
  }
  if (favicon) {
    return new Response(FAVICON_SVG, {
      headers: {
        "cache-control": "public, max-age=86400",
        "content-type": "image/svg+xml",
      },
    });
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
    const asset = await fileResponse(assetPath, undefined, "public, max-age=31536000, immutable");
    return asset ?? notFound();
  }
  const shell = await fileResponse(resolve(options.webRoot, "index.html"), (html) =>
    identity === null
      ? html
      : html.replace(
          /<head>/i,
          `<head>${SESSION_SHELL_MARKER}${
            options.proofReceiptAvailable ? PROOF_RECEIPT_SHELL_MARKER : ""
          }`,
        ),
  );
  return shell ?? notFound();
}
