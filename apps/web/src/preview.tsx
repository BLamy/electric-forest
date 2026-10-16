export function isPreview(doc: Document = document): boolean {
  return doc.querySelector('meta[name="ef-mode"][content="preview"]') !== null;
}

/** The server stamps mode and revision; no credential is embedded in the client build. */
export function PreviewNotice(): React.JSX.Element | null {
  if (!isPreview()) return null;
  const revision = document.querySelector('meta[name="ef-build"]')?.getAttribute("content");
  return (
    <aside
      role="note"
      data-testid="preview-banner"
      data-ef-mode="preview"
      data-ef-build={revision}
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-500/40 bg-amber-950 px-3 py-2 text-center text-xs text-amber-100"
    >
      <strong>Public preview · disposable data · shared fixture accounts</strong>
      <span>Do not enter private information. Agents and integrations are off.</span>
      <a className="underline" href="/chat/preview/welcome">
        Try live chat
      </a>
      <span title={revision ?? "unknown"}>Build {revision?.slice(0, 12)}</span>
    </aside>
  );
}
