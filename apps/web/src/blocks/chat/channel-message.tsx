/* Provenance: registry/blocks/discord-clone/channel-message.tsx — @brett_lamy/ui 2.0.0 registry block
   "discord-clone" (https://blamy.github.io/ui/r/discord-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
// ef: a message is a replayed `chat:<org>/<channel>` record. Its body renders through the Docstream
// adapter; edit / delete / reply are dispatches (chat.message.edit|delete|post) with expectedRevision.
// There are no reactions stream events, so the reaction parts are not used.
// ef:begin imports the live chat stream types, the Docstream adapter and the run accordion
import { useState } from "react";
import { Icon } from "@brett_lamy/ui";
import type { ChatMessage } from "@eforest/reducers";
import type { ReferenceSources } from "@brett_lamy/docstream-editor";
import { Markdown } from "../../components/markdown/Markdown.js";
import { RunAccordion } from "../../chat/RunAccordion.js";
import type { ChatChannelBinding } from "../../chat/types.js";
import { ChatComposer } from "./components/chat-composer.js";
import type { ChatUser } from "./components/chat-avatar.js";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageAuthor,
  MessageAvatar,
  MessageBadge,
  MessageBody,
  MessageContent,
  MessageHeader,
  MessageTimestamp,
} from "./components/message.js";
import { ThreadPreview, ThreadPreviewReply } from "./components/thread-preview.js";
// ef:end

const AUTHOR_COLORS = ["#48b979", "#6eafff", "#bf5af2", "#ff9f0a", "#5ac8fa", "#ff6b6b"];

function authorColor(actor: string): string {
  let hash = 0;
  for (const char of actor) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length]!;
}

export function displayName(actor: string): string {
  if (actor.startsWith("agent:")) return actor.slice("agent:".length);
  return actor.replace(/^auth0\|/, "").split("@")[0] ?? actor;
}

/** ef: the chat user a stream actor renders as (agents are bots). */
export function chatUserOf(actor: string): ChatUser {
  const color = authorColor(actor);
  return { name: displayName(actor), c: color, role: color, bot: actor.startsWith("agent:") };
}

const RUN_MARKER = /^\[eforest-run\]: eforest:(agent-run:\S+)$/m;

/** The agent run log a message links (invisible `[eforest-run]` definition). */
export function runOf(body: string): string | undefined {
  return RUN_MARKER.exec(body)?.[1];
}

export function clock(ts: number): string {
  if (!Number.isFinite(ts) || ts < 1_000_000_000_000) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

type Dispatch = ChatChannelBinding["dispatch"];

// ef:begin props are a replayed ChatMessage plus dispatch wiring (no local reactions)
export interface ChannelMessageProps {
  message: ChatMessage;
  replies: readonly ChatMessage[];
  mine: boolean;
  dispatch: Dispatch;
  /** opens the message's thread (or starts one) */
  onOpenThread: ((id: string) => void) | undefined;
  onError: (message: string) => void;
  inThread?: boolean;
  references: ReferenceSources;
  org: string;
  /** Runs that already have a final reply; their "working…" notes drop the accordion. */
  answeredRuns: ReadonlySet<string>;
}
// ef:end

// ef:begin body through the Docstream adapter; edit/delete/thread are dispatches; offsets shown
/** One message, from the Message parts. */
export function ChannelMessage({
  message,
  replies,
  mine,
  dispatch,
  onOpenThread,
  onError,
  inThread,
  references,
  org,
  answeredRuns,
}: ChannelMessageProps) {
  const user = chatUserOf(message.actor);
  const linkedRun = message.actor.startsWith("agent:") ? runOf(message.body) : undefined;
  const runStreamId =
    linkedRun !== undefined && message.id.includes("-status-") && answeredRuns.has(linkedRun)
      ? undefined
      : linkedRun;
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const run = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "The dispatch was refused.");
      throw cause;
    }
  };
  const last = replies.at(-1);
  return (
    <Message
      user={user}
      data-testid="chat-message"
      data-offset={message.offset}
      data-message-id={message.id}
      data-revision={message.revision}
      data-deleted={message.deleted ? "true" : undefined}
    >
      <MessageAvatar />
      <MessageBody>
        <MessageHeader>
          <MessageAuthor />
          {user.bot && <MessageBadge>APP</MessageBadge>}
          <MessageTimestamp>{clock(message.ts)}</MessageTimestamp>
          {/* ef: the application offset is part of every message header. */}
          <code className="text-[10.5px] text-tertiary-foreground" title="application offset">
            {message.offset.slice(-6)}
          </code>
          {message.editedAt !== null && !message.deleted ? (
            <span
              className="text-[10.5px] text-tertiary-foreground"
              data-testid="chat-message-edited"
            >
              (edited)
            </span>
          ) : null}
        </MessageHeader>
        {message.deleted ? (
          <p
            className="m-0 text-[13px] text-tertiary-foreground italic"
            data-testid="chat-message-tombstone"
          >
            This message was deleted.
          </p>
        ) : editing ? (
          <ChatComposer
            references={references}
            placeholder="Edit your message"
            initialMarkdown={message.body}
            compact
            onCancel={() => setEditing(false)}
            onSend={(body) =>
              run(async () => {
                await dispatch({
                  type: "chat.message.edit",
                  payload: { v: 1, id: message.id, body, expectedRevision: message.revision },
                  ts: Date.now(),
                });
                setEditing(false);
              })
            }
          />
        ) : (
          <MessageContent>
            {/* ef: the body is Markdown through the Docstream adapter (URL policy), never RichText. */}
            <Markdown source={message.body} className="text-[13.5px] leading-[1.55]" />
            {runStreamId === undefined ? null : (
              <RunAccordion org={org} runStreamId={runStreamId} />
            )}
          </MessageContent>
        )}
        {confirmingDelete ? (
          <div
            className="mt-2 flex flex-wrap items-center gap-2 rounded-[10px] border border-border bg-card px-3 py-2 text-[12.5px]"
            data-testid="chat-delete-confirm"
          >
            <span className="flex-1">
              Delete this message? Its offset stays on the stream as a tombstone.
            </span>
            <button
              type="button"
              className="cursor-pointer rounded-[8px] border border-border bg-transparent px-2.5 py-1 font-semibold text-muted-foreground hover:bg-accent"
              onClick={() => setConfirmingDelete(false)}
            >
              Keep
            </button>
            <button
              type="button"
              className="cursor-pointer rounded-[8px] border-0 bg-destructive px-2.5 py-1 font-semibold text-(--gh-ink)"
              data-testid="chat-delete-confirm-yes"
              onClick={() =>
                void run(async () => {
                  await dispatch({
                    type: "chat.message.delete",
                    payload: { v: 1, id: message.id, expectedRevision: message.revision },
                    ts: Date.now(),
                  });
                  setConfirmingDelete(false);
                }).catch(() => undefined)
              }
            >
              Delete
            </button>
          </div>
        ) : null}
        {!inThread && replies.length > 0 && onOpenThread !== undefined ? (
          <ThreadPreview
            title={`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
            count={replies.length}
            onPress={() => onOpenThread(message.id)}
            data-testid="chat-thread-pill"
          >
            {last && (
              <ThreadPreviewReply user={chatUserOf(last.actor)}>
                {last.deleted ? "deleted" : `Last reply ${clock(last.ts) || "replayed"}`}
              </ThreadPreviewReply>
            )}
          </ThreadPreview>
        ) : null}
      </MessageBody>
      {message.deleted ? null : (
        <MessageActions>
          {/* ef: copy / thread / edit / delete replace the block's local 👍 reaction. */}
          <MessageAction
            label="Copy message as Markdown"
            data-testid="chat-message-copy"
            onPress={() => void navigator.clipboard?.writeText(message.body)}
          >
            <Icon name="copy" size={14} sw={1.9} className="inline" />
          </MessageAction>
          {onOpenThread && (
            <MessageAction
              label={replies.length === 0 ? "Start thread" : "Open thread"}
              data-testid="chat-message-thread"
              onPress={() => onOpenThread(message.id)}
            >
              <Icon name="text-bubble" size={14} sw={1.9} className="inline" />
            </MessageAction>
          )}
          {mine ? (
            <>
              <MessageAction
                label="Edit message"
                data-testid="chat-message-edit"
                onPress={() => setEditing(true)}
              >
                <Icon name="pencil" size={14} sw={1.9} className="inline" />
              </MessageAction>
              <MessageAction
                label="Delete message"
                data-testid="chat-message-delete"
                onPress={() => setConfirmingDelete(true)}
              >
                <Icon name="trash" size={14} sw={1.9} className="inline" />
              </MessageAction>
            </>
          ) : null}
        </MessageActions>
      )}
    </Message>
  );
}
// ef:end
