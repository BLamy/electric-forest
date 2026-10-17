import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Icon, List, ListRow, ListSection, cn } from "@brett_lamy/ui";
import {
  CONTENT_EVIDENCE_KINDS,
  contentBytes,
  isContentEvidenceKind,
  type Attachment,
  type ContentAttachment,
  type EvidenceEntityType,
  type ReferenceAttachment,
} from "@eforest/evidence";
import {
  Download,
  ExternalLink,
  FileCheck2,
  FileWarning,
  Link2,
  Paperclip,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { Markdown } from "../components/markdown/Markdown.js";
import { ghButton, ghField, githubMarkdown } from "../blocks/github/parts.js";
import {
  browserSha256,
  byteExactBlob,
  formatEvidenceSize,
  isTextMediaType,
  replayLinkEvent,
  safeHttpsHref,
  textPreview,
} from "./model.js";
import {
  uploadEvidence,
  useEvidence,
  useEvidenceContent,
  type EvidenceBinding,
} from "./useEvidence.js";

export interface EvidencePanelProps {
  readonly org: string;
  readonly repo: string;
  readonly entityType: EvidenceEntityType;
  readonly entityId: string;
}

function attachmentTitle(attachment: Attachment): string {
  return attachment.type === "content" ? attachment.name : (attachment.title ?? "Replay recording");
}

function attachmentSubtitle(attachment: Attachment): string {
  return attachment.type === "content"
    ? `${attachment.kind} · ${formatEvidenceSize(attachment.size)}`
    : attachment.kind;
}

function attachmentElementId(attachmentId: string): string {
  return `evidence-attachment-${attachmentId}`;
}

function isMarkdownAttachment(attachment: ContentAttachment): boolean {
  const mediaType = attachment.mediaType.split(";", 1)[0]!.trim().toLowerCase();
  return (
    mediaType === "text/markdown" ||
    mediaType === "text/x-markdown" ||
    /\.(?:md|markdown|mdown)$/i.test(attachment.name)
  );
}

function newAttachmentId(prefix: string): string {
  if (globalThis.crypto?.randomUUID === undefined) {
    throw new Error("Secure attachment IDs are unavailable");
  }
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function useDownloadUrl(
  bytes: Uint8Array | undefined,
  mediaType: string,
  enabled: boolean,
): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (
      !enabled ||
      bytes === undefined ||
      typeof URL.createObjectURL !== "function" ||
      typeof URL.revokeObjectURL !== "function"
    ) {
      setUrl(undefined);
      return;
    }
    const next = URL.createObjectURL(byteExactBlob(bytes, mediaType));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [bytes, enabled, mediaType]);
  return url;
}

function ContentAttachmentCard(props: {
  readonly org: string;
  readonly repo: string;
  readonly attachment: ContentAttachment;
}): React.JSX.Element {
  const binding = useEvidenceContent(props.org, props.repo, props.attachment.attachmentId);
  const state = binding.projection.state;
  const bytes = useMemo(() => {
    try {
      return contentBytes(state);
    } catch {
      return undefined;
    }
  }, [state]);
  const [webHash, setWebHash] = useState<string>();
  const [hashError, setHashError] = useState<string>();

  useEffect(() => {
    let active = true;
    setWebHash(undefined);
    setHashError(undefined);
    if (!state.sealed || bytes === undefined) return () => undefined;
    void browserSha256(bytes).then(
      (hash) => {
        if (active) setWebHash(hash);
      },
      (reason: unknown) => {
        if (active) setHashError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [bytes, state.sealed]);

  const hashComplete = state.sealed && webHash !== undefined;
  const hashVerified =
    hashComplete &&
    webHash === props.attachment.sha256 &&
    state.sha256 === props.attachment.sha256 &&
    state.size === props.attachment.size &&
    props.attachment.contentStream === binding.streamId;
  const hashMismatch = state.sealError !== undefined || (hashComplete && !hashVerified);
  const preview =
    state.sealed && bytes !== undefined && isTextMediaType(props.attachment.mediaType)
      ? textPreview(bytes)
      : undefined;
  const downloadUrl = useDownloadUrl(
    bytes,
    props.attachment.mediaType,
    state.sealed && bytes !== undefined,
  );

  return (
    <div
      id={attachmentElementId(props.attachment.attachmentId)}
      tabIndex={-1}
      className={cn(
        "overflow-hidden rounded-md border bg-background",
        hashMismatch ? "border-destructive" : "border-border",
      )}
      data-testid="attachment-row"
      data-attachment-id={props.attachment.attachmentId}
      data-content-stream={binding.streamId}
      data-content-offset={binding.projection.checkpoint}
      data-content-digest={binding.projection.digest}
      data-content-reducer={binding.reducerId}
      data-ef-hash-verified={hashVerified ? "true" : "false"}
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted px-4 py-2 text-[14px]">
        <FileCheck2 size={19} aria-hidden="true" />
        <div className="grid min-w-0 flex-1">
          <strong className="truncate">{props.attachment.name}</strong>
          <span className="text-[12px] text-muted-foreground">
            {props.attachment.kind} · {formatEvidenceSize(props.attachment.size)}
          </span>
        </div>
        <Badge variant="outline">{state.sealed ? "sealed" : "loading"}</Badge>
      </div>
      <div className="grid gap-3 px-4 py-3 text-[13px]">
        <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
          <dt className="text-muted-foreground">Media type</dt>
          <dd className="m-0">{props.attachment.mediaType}</dd>
          <dt className="text-muted-foreground">Recorded SHA-256</dt>
          <dd className="m-0 min-w-0 break-all">
            <code className="font-mono" data-testid="attachment-sha256">
              {props.attachment.sha256}
            </code>
          </dd>
          <dt className="text-muted-foreground">Web Crypto SHA-256</dt>
          <dd className="m-0 min-w-0 break-all">
            <code>{webHash ?? "Computing…"}</code>
          </dd>
        </dl>

        {hashVerified ? (
          <p className="m-0 flex items-center gap-1.5 text-success" role="status">
            <ShieldCheck size={17} aria-hidden="true" /> Hash verified from replayed bytes
          </p>
        ) : hashMismatch ? (
          <p className="m-0 flex items-center gap-1.5 text-destructive" role="alert">
            <FileWarning size={17} aria-hidden="true" /> SHA-256 mismatch — do not trust this
            attachment
          </p>
        ) : hashError !== undefined ? (
          <p className="m-0 flex items-center gap-1.5 text-destructive" role="alert">
            <FileWarning size={17} aria-hidden="true" /> Hash verification unavailable: {hashError}
          </p>
        ) : binding.projection.status.startsWith("error:") ? (
          <p className="m-0 flex items-center gap-1.5 text-destructive" role="alert">
            Content projection refused: {binding.projection.status.slice("error:".length)}
          </p>
        ) : state.sealed ? (
          <p className="m-0 text-muted-foreground" role="status">
            Recomputing SHA-256 with Web Crypto…
          </p>
        ) : (
          <p className="m-0 text-muted-foreground" role="status">
            Waiting for validly sealed content…
          </p>
        )}

        {preview === undefined ? null : (
          <div className="grid gap-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2 text-[12px]">
              <strong>
                {isMarkdownAttachment(props.attachment) ? "Markdown preview" : "Text preview"}
              </strong>
              {preview.truncated ? <span>First 64 KB</span> : <span>Complete file</span>}
            </div>
            {isMarkdownAttachment(props.attachment) ? (
              <Markdown
                source={preview.text}
                data-testid="evidence-markdown-preview"
                className={githubMarkdown}
              />
            ) : (
              <pre className="m-0 max-h-72 overflow-auto font-mono text-[12px]">{preview.text}</pre>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          {downloadUrl === undefined ? (
            <span className="text-muted-foreground">Download available after sealing</span>
          ) : (
            <a
              className={cn(ghButton(), "text-foreground")}
              href={downloadUrl}
              download={props.attachment.name}
              data-testid="attachment-download"
              data-byte-size={bytes?.byteLength}
            >
              <Download size={16} aria-hidden="true" /> Download exact bytes
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function ReferenceAttachmentCard(props: {
  readonly attachment: ReferenceAttachment;
}): React.JSX.Element {
  const href = safeHttpsHref(props.attachment.url);
  return (
    <div
      id={attachmentElementId(props.attachment.attachmentId)}
      tabIndex={-1}
      className="overflow-hidden rounded-md border border-border bg-background"
      data-testid="attachment-row"
      data-attachment-id={props.attachment.attachmentId}
      data-recorded-href={props.attachment.url}
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted px-4 py-2 text-[14px]">
        <Link2 size={19} aria-hidden="true" />
        <div className="grid min-w-0 flex-1">
          <strong className="truncate">{props.attachment.title ?? "Replay recording"}</strong>
          <span className="text-[12px] text-muted-foreground">{props.attachment.kind}</span>
        </div>
        <Badge variant="outline">reference</Badge>
      </div>
      <div className="grid gap-3 px-4 py-3 text-[13px]">
        {href === undefined ? (
          <p
            className="m-0 flex items-center gap-1.5 text-destructive"
            role="alert"
            data-testid="attachment-link"
          >
            <FileWarning size={17} aria-hidden="true" /> Unsafe non-HTTPS reference blocked
          </p>
        ) : (
          <a
            className="flex min-w-0 items-center gap-1.5 break-all text-link"
            href={href}
            target="_blank"
            rel="noreferrer"
            data-testid="attachment-link"
          >
            <ExternalLink size={16} aria-hidden="true" />
            <span>{props.attachment.url}</span>
          </a>
        )}
      </div>
    </div>
  );
}

function AttachmentCard(props: {
  readonly org: string;
  readonly repo: string;
  readonly attachment: Attachment;
}): React.JSX.Element {
  if (props.attachment.type === "reference") {
    return <ReferenceAttachmentCard attachment={props.attachment} />;
  }
  return <ContentAttachmentCard {...props} attachment={props.attachment} />;
}

function UploadEvidenceForm(props: { readonly binding: EvidenceBinding }): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <form
      ref={formRef}
      className="grid gap-2 rounded-md border border-border p-3 text-[13px]"
      aria-label="Upload evidence"
      data-testid="attachment-upload-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const file = form.get("evidence-file");
        const candidateKind = String(form.get("evidence-kind") ?? "");
        setMessage(undefined);
        setError(undefined);
        if (!(file instanceof File) || file.name === "") {
          setError("Choose an evidence file.");
          return;
        }
        if (!isContentEvidenceKind(candidateKind)) {
          setError("Choose a supported evidence kind.");
          return;
        }
        setBusy(true);
        void file
          .arrayBuffer()
          .then((buffer) =>
            uploadEvidence(props.binding, {
              kind: candidateKind,
              name: file.name,
              mediaType: file.type || "application/octet-stream",
              bytes: new Uint8Array(buffer),
            }),
          )
          .then(
            (result) => {
              formRef.current?.reset();
              setMessage(`Attached ${result.attachmentId}`);
            },
            (reason: unknown) =>
              setError(reason instanceof Error ? reason.message : String(reason)),
          )
          .finally(() => setBusy(false));
      }}
    >
      <div className="flex items-center gap-2">
        <Upload size={18} aria-hidden="true" />
        <div className="grid">
          <strong>Upload stream evidence</strong>
          <span className="text-[12px] text-muted-foreground">
            Chunks are appended and sealed before the attachment event.
          </span>
        </div>
      </div>
      <label className="grid gap-1 font-semibold">
        Kind
        <select
          className={ghField}
          name="evidence-kind"
          defaultValue={CONTENT_EVIDENCE_KINDS[0]}
          data-testid="attachment-kind"
        >
          {CONTENT_EVIDENCE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 font-semibold">
        File
        <input
          name="evidence-file"
          type="file"
          required
          data-testid="attachment-file"
          className="text-[12px] font-normal"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        data-testid="attachment-upload-submit"
        className={ghButton()}
      >
        {busy ? "Uploading…" : "Upload evidence"}
      </button>
      {error === undefined ? null : (
        <p className="m-0 text-destructive" role="alert">
          {error}
        </p>
      )}
      {message === undefined ? null : (
        <p className="m-0 text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </form>
  );
}

function ReplayReferenceForm(props: { readonly binding: EvidenceBinding }): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <form
      ref={formRef}
      className="grid gap-2 rounded-md border border-border p-3 text-[13px]"
      aria-label="Attach Replay recording"
      data-testid="attachment-replay-form"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const url = String(form.get("replay-url") ?? "");
        const title = String(form.get("replay-title") ?? "");
        setMessage(undefined);
        setError(undefined);
        let action;
        try {
          action = replayLinkEvent({
            attachmentId: newAttachmentId("replay"),
            url,
            ...(title === "" ? {} : { title }),
          });
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
          return;
        }
        setBusy(true);
        void props.binding.dispatch(action).then(
          () => {
            formRef.current?.reset();
            setMessage("Replay recording attached.");
            setBusy(false);
          },
          (reason: unknown) => {
            setError(reason instanceof Error ? reason.message : String(reason));
            setBusy(false);
          },
        );
      }}
    >
      <div className="flex items-center gap-2">
        <Link2 size={18} aria-hidden="true" />
        <div className="grid">
          <strong>Attach Replay recording</strong>
          <span className="text-[12px] text-muted-foreground">
            Only canonical HTTPS Replay links are accepted.
          </span>
        </div>
      </div>
      <label className="grid gap-1 font-semibold">
        Replay URL
        <input
          className={ghField}
          name="replay-url"
          type="url"
          inputMode="url"
          placeholder="https://app.replay.io/recording/…"
          required
          data-testid="attachment-replay-url"
        />
      </label>
      <label className="grid gap-1 font-semibold">
        Title
        <input
          className={ghField}
          name="replay-title"
          placeholder="Optional label"
          data-testid="attachment-replay-title"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        data-testid="attachment-replay-submit"
        className={ghButton()}
      >
        {busy ? "Attaching…" : "Attach Replay"}
      </button>
      {error === undefined ? null : (
        <p className="m-0 text-destructive" role="alert">
          {error}
        </p>
      )}
      {message === undefined ? null : (
        <p className="m-0 text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </form>
  );
}

function MobileAttachmentIndex(props: {
  readonly attachments: readonly Attachment[];
}): React.JSX.Element {
  return (
    <div>
      <List className="overflow-hidden rounded-xl border border-border">
        <ListSection title="Attachment index">
          {props.attachments.map((attachment) => (
            <ListRow
              key={attachment.attachmentId}
              rowRole="button"
              leading={<Icon name={attachment.type === "content" ? "layers" : "pulse"} />}
              title={attachmentTitle(attachment)}
              subtitle={attachmentSubtitle(attachment)}
              trailing={attachment.detachedAtOffset === undefined ? undefined : "Detached"}
              accessory="chevron"
              onPress={() => {
                const row = document.getElementById(attachmentElementId(attachment.attachmentId));
                row?.scrollIntoView({ block: "center" });
                row?.focus({ preventScroll: true });
              }}
            />
          ))}
        </ListSection>
      </List>
    </div>
  );
}

export function EvidencePanel(props: EvidencePanelProps): React.JSX.Element {
  const binding = useEvidence(props.org, props.repo, props.entityType, props.entityId);
  const attachments = binding.projection.state.attachments;
  return (
    <section
      className="overflow-hidden rounded-md border border-border bg-background"
      aria-labelledby={`evidence-heading-${props.entityType}-${props.entityId}`}
      data-testid="evidence-region"
      data-ef-stream={binding.streamId}
      data-ef-offset={binding.projection.checkpoint}
      data-ef-digest={binding.projection.digest}
      data-ef-reducer={binding.reducerId}
      data-stream-status={binding.projection.status}
    >
      <div className="flex items-center gap-2 border-b border-border bg-muted px-4 py-2">
        <h2
          id={`evidence-heading-${props.entityType}-${props.entityId}`}
          className="m-0 flex flex-1 items-center gap-2 text-[14px] font-semibold"
        >
          <Paperclip size={16} aria-hidden="true" /> Evidence
          <span className="font-normal text-muted-foreground">Durable verification artifacts</span>
        </h2>
        <Badge variant="outline">{attachments.length} attached</Badge>
      </div>

      {attachments.length === 0 ? null : <MobileAttachmentIndex attachments={attachments} />}

      <div className="grid gap-3 px-4 py-3" aria-live="polite">
        {binding.projection.status === "loading" ? (
          <p className="m-0 text-muted-foreground">Loading evidence attachments…</p>
        ) : binding.projection.status.startsWith("error:") ? (
          <p className="m-0 flex items-center gap-1.5 text-destructive" role="alert">
            Evidence projection refused: {binding.projection.status.slice("error:".length)}
          </p>
        ) : attachments.length === 0 ? (
          <p className="m-0 text-muted-foreground">No evidence has been attached yet.</p>
        ) : (
          attachments.map((attachment) => (
            <div
              key={attachment.attachmentId}
              className={attachment.detachedAtOffset === undefined ? "" : "opacity-60"}
              data-detached-offset={attachment.detachedAtOffset}
            >
              <AttachmentCard org={props.org} repo={props.repo} attachment={attachment} />
            </div>
          ))
        )}
      </div>

      <div className="grid gap-3 border-t border-border px-4 py-3 md:grid-cols-2">
        <UploadEvidenceForm binding={binding} />
        <ReplayReferenceForm binding={binding} />
      </div>
    </section>
  );
}
