import { useEffect, useRef, useState } from "react";
import { Icon } from "@brett_lamy/ui";
import type { ChatMessage } from "@eforest/reducers";
import { ChatAvatar, ChatIcon, chatIconPaths, K, KFONT } from "../vendor/chatkit/index.js";
import { Markdown } from "../components/markdown/Markdown.js";
import { MobileSideDrawer } from "../components/mobile/MobileOverlays.js";
import { DesktopTouchKit } from "../components/touchkit/DesktopTouchKit.js";
import { ChatComposer } from "./ChatComposer.js";
import { useChatChannel } from "./useChat.js";
import { useWhoami } from "./useWhoami.js";
import type { ChatChannelBinding } from "./types.js";

const COPY_ICON = "M9 9h10v11H9zM5 15V4h10";
const EDIT_ICON = "M4 20h4l10-10-4-4L4 16zM13 7l4 4";
const TRASH_ICON = "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6";
const AUTHOR_COLORS = ["#48b979", "#6eafff", "#bf5af2", "#ff9f0a", "#5ac8fa", "#ff6b6b"];

function authorColor(actor: string): string {
  let hash = 0;
  for (const char of actor) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AUTHOR_COLORS[hash % AUTHOR_COLORS.length]!;
}

function displayName(actor: string): string {
  return actor.replace(/^auth0\|/, "").split("@")[0] ?? actor;
}

function clock(ts: number): string {
  if (!Number.isFinite(ts) || ts < 1_000_000_000_000) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function dayLabel(ts: number): string {
  if (!Number.isFinite(ts) || ts < 1_000_000_000_000) return "Replayed";
  return new Date(ts).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
}

function messageId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

type Dispatch = ChatChannelBinding["dispatch"];

async function postMessage(dispatch: Dispatch, body: string, threadOf?: string): Promise<void> {
  await dispatch({
    type: "chat.message.post",
    payload: { v: 1, id: messageId(), body, ...(threadOf === undefined ? {} : { threadOf }) },
    ts: Date.now(),
  });
}

function MessageRow(props: {
  readonly message: ChatMessage;
  readonly replies: readonly ChatMessage[];
  readonly mine: boolean;
  readonly dispatch: Dispatch;
  readonly onOpenThread: ((id: string) => void) | undefined;
  readonly onError: (message: string) => void;
  readonly inThread?: boolean;
}): React.JSX.Element {
  const { message } = props;
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const user = {
    name: displayName(message.actor),
    c: authorColor(message.actor),
    role: authorColor(message.actor),
  };
  const run = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : "The dispatch was refused.");
      throw cause;
    }
  };
  const lastReply = props.replies.at(-1);
  return (
    <div
      className="chat-message-row ck-row"
      data-testid="chat-message"
      data-offset={message.offset}
      data-message-id={message.id}
      data-revision={message.revision}
      data-deleted={message.deleted ? "true" : undefined}
    >
      <ChatAvatar user={user} size={36} />
      <div className="chat-message-main">
        <div className="chat-message-meta">
          <span className="chat-message-author" style={{ color: user.role }}>
            {user.name}
          </span>
          <span className="chat-message-time">{clock(message.ts)}</span>
          <code className="chat-message-offset" title="application offset">
            {message.offset.slice(-6)}
          </code>
          {message.editedAt !== null && !message.deleted ? (
            <span className="chat-message-edited" data-testid="chat-message-edited">
              (edited)
            </span>
          ) : null}
          {message.deleted ? null : (
            <span className="chat-message-actions">
              <button
                type="button"
                className="chat-message-action"
                title="Copy as Markdown"
                aria-label="Copy message as Markdown"
                data-testid="chat-message-copy"
                onClick={() => void navigator.clipboard?.writeText(message.body)}
              >
                <ChatIcon d={COPY_ICON} size={13} />
              </button>
              {props.onOpenThread === undefined ? null : (
                <button
                  type="button"
                  className="chat-message-action"
                  title={props.replies.length === 0 ? "Start thread" : "Open thread"}
                  aria-label={props.replies.length === 0 ? "Start thread" : "Open thread"}
                  data-testid="chat-message-thread"
                  onClick={() => props.onOpenThread?.(message.id)}
                >
                  <ChatIcon d={chatIconPaths.thread} size={13} />
                </button>
              )}
              {props.mine ? (
                <>
                  <button
                    type="button"
                    className="chat-message-action"
                    title="Edit message"
                    aria-label="Edit message"
                    data-testid="chat-message-edit"
                    onClick={() => setEditing(true)}
                  >
                    <ChatIcon d={EDIT_ICON} size={13} />
                  </button>
                  <button
                    type="button"
                    className="chat-message-action chat-message-action-danger"
                    title="Delete message"
                    aria-label="Delete message"
                    data-testid="chat-message-delete"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <ChatIcon d={TRASH_ICON} size={13} />
                  </button>
                </>
              ) : null}
            </span>
          )}
        </div>
        {message.deleted ? (
          <p className="chat-message-tombstone" data-testid="chat-message-tombstone">
            This message was deleted.
          </p>
        ) : editing ? (
          <ChatComposer
            placeholder="Edit your message"
            initialMarkdown={message.body}
            compact
            onCancel={() => setEditing(false)}
            onSend={(body) =>
              run(async () => {
                await props.dispatch({
                  type: "chat.message.edit",
                  payload: { v: 1, id: message.id, body, expectedRevision: message.revision },
                  ts: Date.now(),
                });
                setEditing(false);
              })
            }
          />
        ) : (
          <Markdown source={message.body} className="chat-markdown" />
        )}
        {confirmingDelete ? (
          <div className="chat-delete-confirm" data-testid="chat-delete-confirm">
            <span>Delete this message? Its offset stays on the stream as a tombstone.</span>
            <button type="button" onClick={() => setConfirmingDelete(false)}>
              Keep
            </button>
            <button
              type="button"
              className="chat-delete-confirm-yes"
              data-testid="chat-delete-confirm-yes"
              onClick={() =>
                void run(async () => {
                  await props.dispatch({
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
        {!props.inThread && props.replies.length > 0 && props.onOpenThread !== undefined ? (
          <button
            type="button"
            className="chat-thread-pill"
            data-testid="chat-thread-pill"
            onClick={() => props.onOpenThread?.(message.id)}
          >
            <span className="chat-thread-pill-avatars">
              {[...new Set(props.replies.map((reply) => reply.actor))].slice(0, 3).map((actor) => (
                <ChatAvatar
                  key={actor}
                  user={{ name: displayName(actor), c: authorColor(actor), role: "" }}
                  size={16}
                />
              ))}
            </span>
            <span className="chat-thread-pill-count">
              {props.replies.length} {props.replies.length === 1 ? "reply" : "replies"}
            </span>
            {lastReply === undefined ? null : (
              <span className="chat-thread-pill-last">
                Last reply {clock(lastReply.ts) || "replayed"}
              </span>
            )}
            <span className="chat-thread-pill-open">View thread ›</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ChatChannelPage(props: {
  readonly org: string;
  readonly channel: string;
}): React.JSX.Element {
  const binding = useChatChannel(props.org, props.channel);
  const me = useWhoami();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const all = binding.projection.state.messages;
  const roots = all.filter((message) => message.threadOf === null);
  const repliesOf = (id: string): ChatMessage[] =>
    all.filter((message) => message.threadOf === id && !message.deleted);
  const visibleRoots = roots.filter(
    (message) => !message.deleted || repliesOf(message.id).length > 0,
  );
  const threadRoot = threadId === undefined ? undefined : all.find((m) => m.id === threadId);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [roots.length]);
  useEffect(() => {
    if (threadId !== undefined && threadRoot === undefined) setThreadId(undefined);
  }, [threadId, threadRoot]);

  const status = binding.projection.status;
  const refused = status.startsWith("error:");
  const send = async (text: string, threadOf?: string): Promise<void> => {
    setError(undefined);
    try {
      await postMessage(binding.dispatch, text, threadOf);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The message was refused.");
      throw cause;
    }
  };
  let lastDay = "";
  const drawerWidth = Math.min(420, Math.max(320, window.innerWidth - 700));
  return (
    <>
      <section
        className="chat-channel"
        data-testid="chat-channel"
        data-ef-stream={binding.streamId}
        data-ef-offset={binding.projection.checkpoint}
        data-ef-digest={binding.projection.digest}
        data-stream-status={status}
        data-thread-open={threadRoot === undefined ? undefined : threadRoot.id}
        style={{ fontFamily: KFONT }}
      >
        <header className="chat-channel-head">
          <span style={{ color: K.mut3, display: "grid" }}>
            <ChatIcon d={chatIconPaths.hash} size={16} sw={2.2} />
          </span>
          <strong>{props.channel}</strong>
          <span className="chat-channel-topic">
            {binding.topic === "" ? "A durable channel on the workspace stream." : binding.topic}
          </span>
          <span className="tree-status" data-status={status} data-testid="chat-stream-status">
            {status}
          </span>
        </header>
        <div ref={scrollRef} className="chat-channel-scroll ck-scroll" data-testid="chat-messages">
          <div className="chat-channel-welcome">
            <div className="chat-channel-welcome-icon">
              <ChatIcon d={chatIconPaths.hash} size={22} sw={2.2} />
            </div>
            <div className="chat-channel-welcome-title">Welcome to #{props.channel}</div>
            <div className="chat-channel-welcome-sub">
              Every message is an event on <code>{binding.streamId}</code>. Markdown renders through
              Docstream.
            </div>
          </div>
          {refused ? (
            <p role="alert" className="projection-refusal">
              Channel projection refused: {status.slice("error:".length)}
            </p>
          ) : null}
          {visibleRoots.map((message) => {
            const day = dayLabel(message.ts);
            const divider = day !== lastDay;
            lastDay = day;
            return (
              <div key={message.offset || message.id}>
                {divider ? (
                  <div className="chat-day-divider">
                    <span />
                    {day}
                    <span />
                  </div>
                ) : null}
                <MessageRow
                  message={message}
                  replies={repliesOf(message.id)}
                  mine={me !== null && me.sub === message.actor}
                  dispatch={binding.dispatch}
                  onOpenThread={setThreadId}
                  onError={setError}
                />
              </div>
            );
          })}
          {!refused && status !== "loading" && visibleRoots.length === 0 ? (
            <p className="chat-channel-empty" data-testid="chat-empty">
              No messages yet — say something.
            </p>
          ) : null}
        </div>
        {error === undefined ? null : (
          <p role="alert" className="new-repository-error chat-error">
            {error}
          </p>
        )}
        <div className="chat-composer">
          <ChatComposer placeholder={`Message #${props.channel}`} onSend={(text) => send(text)} />
          <small>
            <Icon name="wave" size={12} /> Docstream editor · <kbd>/</kbd> for blocks · Enter sends
            from a plain line, continues a block otherwise · <kbd>⌘</kbd>
            <kbd>Enter</kbd> always sends
          </small>
        </div>
      </section>
      <DesktopTouchKit>
        <MobileSideDrawer
          mode="overlay"
          open={threadRoot !== undefined}
          onClose={() => setThreadId(undefined)}
          label={threadRoot === undefined ? "Thread" : `Thread on ${displayName(threadRoot.actor)}`}
          title="Thread"
          width={drawerWidth}
          className="chat-thread-drawer"
        >
          {threadRoot === undefined ? null : (
            <div className="chat-thread" data-testid="chat-thread" data-thread-root={threadRoot.id}>
              <div className="chat-thread-scroll ck-scroll">
                <MessageRow
                  message={threadRoot}
                  replies={[]}
                  mine={me !== null && me.sub === threadRoot.actor}
                  dispatch={binding.dispatch}
                  onOpenThread={undefined}
                  onError={setError}
                  inThread
                />
                {repliesOf(threadRoot.id).length > 0 ? (
                  <div className="chat-day-divider">
                    <span />
                    {repliesOf(threadRoot.id).length}{" "}
                    {repliesOf(threadRoot.id).length === 1 ? "reply" : "replies"}
                    <span />
                  </div>
                ) : null}
                {repliesOf(threadRoot.id).map((reply) => (
                  <MessageRow
                    key={reply.offset || reply.id}
                    message={reply}
                    replies={[]}
                    mine={me !== null && me.sub === reply.actor}
                    dispatch={binding.dispatch}
                    onOpenThread={undefined}
                    onError={setError}
                    inThread
                  />
                ))}
                {repliesOf(threadRoot.id).length === 0 ? (
                  <p className="chat-channel-empty">No replies yet — say something.</p>
                ) : null}
              </div>
              <div className="chat-composer chat-thread-composer">
                <ChatComposer
                  placeholder={`Reply in thread`}
                  autofocus
                  compact
                  onSend={(text) => send(text, threadRoot.id)}
                />
              </div>
            </div>
          )}
        </MobileSideDrawer>
      </DesktopTouchKit>
    </>
  );
}
