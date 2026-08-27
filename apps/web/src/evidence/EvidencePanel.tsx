import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, List, ListRow, ListSection } from "@brett_lamy/ui";
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
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card, CardContent, CardHeader } from "../components/ui/card.js";
import { Markdown } from "../components/markdown/Markdown.js";
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
    <Card
      id={attachmentElementId(props.attachment.attachmentId)}
      tabIndex={-1}
      className={`attachment-row evidence-attachment-card${hashMismatch ? " evidence-hash-mismatch" : ""}`}
      data-testid="attachment-row"
      data-attachment-id={props.attachment.attachmentId}
      data-content-stream={binding.streamId}
      data-content-offset={binding.projection.checkpoint}
      data-content-digest={binding.projection.digest}
      data-content-reducer={binding.reducerId}
      data-ef-hash-verified={hashVerified ? "true" : "false"}
    >
      <CardHeader className="evidence-card-heading">
        <FileCheck2 size={19} aria-hidden="true" />
        <div>
          <strong>{props.attachment.name}</strong>
          <span>
            {props.attachment.kind} · {formatEvidenceSize(props.attachment.size)}
          </span>
        </div>
        <Badge>{state.sealed ? "sealed" : "loading"}</Badge>
      </CardHeader>
      <CardContent>
        <dl className="evidence-file-facts">
          <dt>Media type</dt>
          <dd>{props.attachment.mediaType}</dd>
          <dt>Recorded SHA-256</dt>
          <dd>
            <code className="attachment-sha256" data-testid="attachment-sha256">
              {props.attachment.sha256}
            </code>
          </dd>
          <dt>Web Crypto SHA-256</dt>
          <dd>
            <code>{webHash ?? "Computing…"}</code>
          </dd>
        </dl>

        {hashVerified ? (
          <p className="evidence-integrity evidence-integrity-ok" role="status">
            <ShieldCheck size={17} aria-hidden="true" /> Hash verified from replayed bytes
          </p>
        ) : hashMismatch ? (
          <p className="evidence-integrity evidence-integrity-bad" role="alert">
            <FileWarning size={17} aria-hidden="true" /> SHA-256 mismatch — do not trust this
            attachment
          </p>
        ) : hashError !== undefined ? (
          <p className="evidence-integrity evidence-integrity-bad" role="alert">
            <FileWarning size={17} aria-hidden="true" /> Hash verification unavailable: {hashError}
          </p>
        ) : binding.projection.status.startsWith("error:") ? (
          <p className="evidence-integrity evidence-integrity-bad" role="alert">
            Content projection refused: {binding.projection.status.slice("error:".length)}
          </p>
        ) : state.sealed ? (
          <p className="evidence-integrity" role="status">
            Recomputing SHA-256 with Web Crypto…
          </p>
        ) : (
          <p className="evidence-integrity" role="status">
            Waiting for validly sealed content…
          </p>
        )}

        {preview === undefined ? null : (
          <div className="evidence-preview">
            <div>
              <strong>
                {isMarkdownAttachment(props.attachment) ? "Markdown preview" : "Text preview"}
              </strong>
              {preview.truncated ? <span>First 64 KB</span> : <span>Complete file</span>}
            </div>
            {isMarkdownAttachment(props.attachment) ? (
              <Markdown source={preview.text} data-testid="evidence-markdown-preview" />
            ) : (
              <pre>{preview.text}</pre>
            )}
          </div>
        )}

        <div className="evidence-card-actions">
          {downloadUrl === undefined ? (
            <span className="evidence-download-disabled">Download available after sealing</span>
          ) : (
            <a
              className="evidence-download"
              href={downloadUrl}
              download={props.attachment.name}
              data-testid="attachment-download"
              data-byte-size={bytes?.byteLength}
            >
              <Download size={16} aria-hidden="true" /> Download exact bytes
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ReferenceAttachmentCard(props: {
  readonly attachment: ReferenceAttachment;
}): React.JSX.Element {
  const href = safeHttpsHref(props.attachment.url);
  return (
    <Card
      id={attachmentElementId(props.attachment.attachmentId)}
      tabIndex={-1}
      className="attachment-row evidence-attachment-card evidence-reference-card"
      data-testid="attachment-row"
      data-attachment-id={props.attachment.attachmentId}
      data-recorded-href={props.attachment.url}
    >
      <CardHeader className="evidence-card-heading">
        <Link2 size={19} aria-hidden="true" />
        <div>
          <strong>{props.attachment.title ?? "Replay recording"}</strong>
          <span>{props.attachment.kind}</span>
        </div>
        <Badge>reference</Badge>
      </CardHeader>
      <CardContent>
        {href === undefined ? (
          <p
            className="attachment-link evidence-integrity evidence-integrity-bad"
            role="alert"
            data-testid="attachment-link"
          >
            <FileWarning size={17} aria-hidden="true" /> Unsafe non-HTTPS reference blocked
          </p>
        ) : (
          <a
            className="attachment-link evidence-reference-link"
            href={href}
            target="_blank"
            rel="noreferrer"
            data-testid="attachment-link"
          >
            <ExternalLink size={16} aria-hidden="true" />
            <span>{props.attachment.url}</span>
          </a>
        )}
      </CardContent>
    </Card>
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
      className="evidence-form"
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
      <div className="evidence-form-title">
        <Upload size={18} aria-hidden="true" />
        <div>
          <strong>Upload stream evidence</strong>
          <span>Chunks are appended and sealed before the attachment event.</span>
        </div>
      </div>
      <label>
        Kind
        <select
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
      <label className="evidence-file-input">
        File
        <input name="evidence-file" type="file" required data-testid="attachment-file" />
      </label>
      <Button type="submit" disabled={busy} data-testid="attachment-upload-submit">
        {busy ? "Uploading…" : "Upload evidence"}
      </Button>
      {error === undefined ? null : (
        <p className="evidence-form-message evidence-form-error" role="alert">
          {error}
        </p>
      )}
      {message === undefined ? null : (
        <p className="evidence-form-message" role="status">
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
      className="evidence-form"
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
      <div className="evidence-form-title">
        <Link2 size={18} aria-hidden="true" />
        <div>
          <strong>Attach Replay recording</strong>
          <span>Only canonical HTTPS Replay links are accepted.</span>
        </div>
      </div>
      <label className="evidence-wide-field">
        Replay URL
        <input
          name="replay-url"
          type="url"
          inputMode="url"
          placeholder="https://app.replay.io/recording/…"
          required
          data-testid="attachment-replay-url"
        />
      </label>
      <label>
        Title
        <input
          name="replay-title"
          placeholder="Optional label"
          data-testid="attachment-replay-title"
        />
      </label>
      <Button type="submit" disabled={busy} data-testid="attachment-replay-submit">
        {busy ? "Attaching…" : "Attach Replay"}
      </Button>
      {error === undefined ? null : (
        <p className="evidence-form-message evidence-form-error" role="alert">
          {error}
        </p>
      )}
      {message === undefined ? null : (
        <p className="evidence-form-message" role="status">
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
    <div className="evidence-mobile-index">
      <List inset>
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
      className="evidence-region selectable-content"
      aria-labelledby={`evidence-heading-${props.entityType}-${props.entityId}`}
      data-testid="evidence-region"
      data-ef-stream={binding.streamId}
      data-ef-offset={binding.projection.checkpoint}
      data-ef-digest={binding.projection.digest}
      data-ef-reducer={binding.reducerId}
      data-stream-status={binding.projection.status}
    >
      <div className="evidence-heading">
        <div>
          <p className="eyebrow">Durable verification artifacts</p>
          <h2 id={`evidence-heading-${props.entityType}-${props.entityId}`}>
            <Paperclip size={20} aria-hidden="true" /> Evidence
          </h2>
        </div>
        <Badge>{attachments.length} attached</Badge>
      </div>

      {attachments.length === 0 ? null : <MobileAttachmentIndex attachments={attachments} />}

      <div className="evidence-list" aria-live="polite">
        {binding.projection.status === "loading" ? (
          <p className="evidence-empty">Loading evidence attachments…</p>
        ) : binding.projection.status.startsWith("error:") ? (
          <p className="evidence-integrity evidence-integrity-bad" role="alert">
            Evidence projection refused: {binding.projection.status.slice("error:".length)}
          </p>
        ) : attachments.length === 0 ? (
          <p className="evidence-empty">No evidence has been attached yet.</p>
        ) : (
          attachments.map((attachment) => (
            <div
              key={attachment.attachmentId}
              className={attachment.detachedAtOffset === undefined ? "" : "evidence-detached"}
              data-detached-offset={attachment.detachedAtOffset}
            >
              <AttachmentCard org={props.org} repo={props.repo} attachment={attachment} />
            </div>
          ))
        )}
      </div>

      <div className="evidence-forms">
        <UploadEvidenceForm binding={binding} />
        <ReplayReferenceForm binding={binding} />
      </div>
    </section>
  );
}
