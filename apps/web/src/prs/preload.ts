/**
 * Optimistic preload for the pull-request detail chunk. PrDetail statically imports
 * @pierre/diffs (MultiFileDiff + Shiki), which makes its lazy chunk the heaviest in the app.
 * route-pages.tsx lazy-loads the page through `loadPrDetail`, so a preload kicked off here
 * (when the app goes idle, when a repository route mounts, or on hover/focus of a PR link)
 * shares the exact same promise and module instance.
 */
type PrDetailModule = typeof import("../blocks/github/pull-request.js");

let pending: Promise<PrDetailModule> | undefined;
let warmed = false;

export function loadPrDetail(): Promise<PrDetailModule> {
  pending ??= import("../blocks/github/pull-request.js").catch((error: unknown) => {
    // Let a later attempt (e.g. the real navigation) retry after a transient chunk failure.
    pending = undefined;
    throw error;
  });
  return pending;
}

/** Fire-and-forget: fetch + evaluate the PR detail chunk, then warm the diff highlighter. */
export function preloadPrDetail(): void {
  loadPrDetail()
    .then((module) => {
      if (warmed) return;
      warmed = true;
      return module.warmDiffHighlighter();
    })
    .catch(() => {
      // Preloading is best-effort; the route's own lazy() load surfaces real failures.
    });
}

interface IdleWindow {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

/**
 * Schedule `preloadPrDetail` for when the app has settled: after `delayMs` (so the current
 * route's own chunks win the network), then on the next idle period (or after `timeoutMs`).
 * Returns a cancel function.
 */
export function preloadPrDetailWhenIdle(delayMs = 1500, timeoutMs = 4000): () => void {
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
    ?.saveData;
  if (saveData === true) return () => undefined;
  const idle = window as Window & IdleWindow;
  let idleHandle: number | undefined;
  const timer = window.setTimeout(() => {
    if (idle.requestIdleCallback === undefined) preloadPrDetail();
    else idleHandle = idle.requestIdleCallback(preloadPrDetail, { timeout: timeoutMs });
  }, delayMs);
  return () => {
    window.clearTimeout(timer);
    if (idleHandle !== undefined) idle.cancelIdleCallback?.(idleHandle);
  };
}
