export function isPreview(doc: Document = document): boolean {
  return doc.querySelector('meta[name="ef-mode"][content="preview"]') !== null;
}

export function isHosted(doc: Document = document): boolean {
  return isPreview(doc) || doc.querySelector('meta[name="ef-mode"][content="production"]') !== null;
}

export function agentsDisabled(doc: Document = document): boolean {
  return isPreview(doc) || doc.querySelector('meta[name="ef-agents"][content="off"]') !== null;
}

export function HostedNotice(): React.JSX.Element | null {
  if (document.querySelector('meta[name="ef-mode"][content="production"]') === null) return null;
  const revision = document.querySelector('meta[name="ef-build"]')?.getAttribute("content");
  return (
    <aside
      role="note"
      data-testid="hosted-banner"
      data-ef-mode="production"
      data-ef-auth="auth0"
      data-ef-agents="off"
      data-ef-integrations="off"
      data-ef-build={revision}
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-border bg-muted px-3 py-2 text-center text-xs"
    >
      <strong>Auth0 sign-in · Private data</strong>
      <span>Agents and external integrations are off.</span>
      <a className="underline" href="/settings/cli-tokens">
        CLI tokens
      </a>
      <span title={revision ?? "unknown"}>Build {revision?.slice(0, 12)}</span>
    </aside>
  );
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
