import { Fragment, useEffect, useState } from "react";
import {
  ChatShellDescription,
  ChatShellFooter,
  ChatShellHeader,
  ChatShellHeaderActions,
  ChatShellHeaderIcon,
  ChatShellNavTrigger,
  ChatShellPanel,
  ChatShellTitle,
} from "@brett_lamy/ui";
import type { ChatMessage } from "@eforest/reducers";
import { ChannelMessage, runOf } from "../blocks/chat/channel-message.js";
import { ChatComposer } from "../blocks/chat/components/chat-composer.js";
import { ChannelIntro, DateDivider, MessageList } from "../blocks/chat/components/message-list.js";
import { ThreadView } from "../blocks/chat/thread-view.js";
import { useChatReferenceSources } from "./referenceSources.js";
import { useChatChannel } from "./useChat.js";
import { useWhoami } from "./useWhoami.js";
import type { ChatChannelBinding } from "./types.js";

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

/**
 * One org channel (`/chat/<org>/<channel>`) on the discord-clone block parts: the package's
 * ChatShell header/footer/panel, the owned transcript and message rows. Every message is a
 * `chat:<org>/<channel>` event; posting, editing, deleting and replying are dispatches, and the
 * transcript is the live reducer over that stream — no local message state.
 */
export function ChatChannelPage(props: {
  readonly org: string;
  readonly channel: string;
}): React.JSX.Element {
  const binding = useChatChannel(props.org, props.channel);
  const references = useChatReferenceSources(props.org);
  const me = useWhoami();
  const [error, setError] = useState<string | undefined>(undefined);
  // `?thread=<root id>` (e.g. from a pull request's "Requested in #channel" link) opens it.
  const [threadId, setThreadId] = useState<string | undefined>(
    () => new URLSearchParams(window.location.search).get("thread") ?? undefined,
  );
  const all = binding.projection.state.messages;
  const answeredRuns = new Set(
    all
      .filter((message) => message.actor.startsWith("agent:") && !message.id.includes("-status-"))
      .map((message) => runOf(message.body))
      .filter((run): run is string => run !== undefined),
  );
  const roots = all.filter((message) => message.threadOf === null);
  const repliesOf = (id: string): ChatMessage[] =>
    all.filter((message) => message.threadOf === id && !message.deleted);
  const visibleRoots = roots.filter(
    (message) => !message.deleted || repliesOf(message.id).length > 0,
  );
  const threadRoot = threadId === undefined ? undefined : all.find((m) => m.id === threadId);
  useEffect(() => {
    // Only once messages have replayed: a deep-linked thread must survive the first load.
    if (threadId !== undefined && threadRoot === undefined && all.length > 0) {
      setThreadId(undefined);
    }
  }, [threadId, threadRoot, all.length]);

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
  const row = (message: ChatMessage) => ({
    mine: me !== null && me.sub === message.actor,
    dispatch: binding.dispatch,
    onError: setError,
    references,
    org: props.org,
    answeredRuns,
  });
  let lastDay = "";
  return (
    <section
      id="main-content"
      tabIndex={-1}
      className="relative flex min-h-0 min-w-0 flex-1 outline-none"
      data-testid="chat-channel"
      data-ef-stream={binding.streamId}
      data-ef-offset={binding.projection.checkpoint}
      data-ef-digest={binding.projection.digest}
      data-stream-status={status}
      data-thread-open={threadRoot === undefined ? undefined : threadRoot.id}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatShellHeader>
          <ChatShellNavTrigger />
          <ChatShellHeaderIcon />
          <ChatShellTitle>{props.channel}</ChatShellTitle>
          <ChatShellDescription>
            {binding.topic === "" ? "A durable channel on the workspace stream." : binding.topic}
          </ChatShellDescription>
          <ChatShellHeaderActions>
            <span
              className="rounded-full border border-border px-2 text-[11px] text-muted-foreground"
              data-status={status}
              data-testid="chat-stream-status"
            >
              {status}
            </span>
          </ChatShellHeaderActions>
        </ChatShellHeader>
        <MessageList
          scrollKey={props.channel}
          data-testid="chat-messages"
          aria-label={`#${props.channel} messages`}
        >
          <ChannelIntro title={<>Welcome to #{props.channel}</>}>
            Every message is an event on <code>{binding.streamId}</code>. Markdown renders through
            Docstream.
          </ChannelIntro>
          {refused ? (
            <p role="alert" className="mx-[18px] text-destructive">
              Channel projection refused: {status.slice("error:".length)}
            </p>
          ) : null}
          {visibleRoots.map((message) => {
            const day = dayLabel(message.ts);
            const divider = day !== lastDay;
            lastDay = day;
            return (
              <Fragment key={message.offset || message.id}>
                {divider ? <DateDivider>{day}</DateDivider> : null}
                <ChannelMessage
                  message={message}
                  replies={repliesOf(message.id)}
                  onOpenThread={setThreadId}
                  {...row(message)}
                />
              </Fragment>
            );
          })}
          {!refused && status !== "loading" && visibleRoots.length === 0 ? (
            <p
              className="px-[18px] py-3.5 text-[12.5px] text-tertiary-foreground"
              data-testid="chat-empty"
            >
              No messages yet — say something.
            </p>
          ) : null}
        </MessageList>
        {error === undefined ? null : (
          <p role="alert" className="mx-3.5 mb-2 text-[12.5px] text-destructive">
            {error}
          </p>
        )}
        <ChatShellFooter>
          <ChatComposer
            references={references}
            placeholder={`Message #${props.channel}`}
            onSend={(text) => send(text)}
          />
          <p className="mt-1.5 mb-0 text-[11px] text-tertiary-foreground">
            Docstream editor · <kbd>/</kbd> for blocks · Enter sends from a plain line, continues a
            block otherwise · <kbd>⌘</kbd>
            <kbd>Enter</kbd> always sends
          </p>
        </ChatShellFooter>
      </div>
      <ChatShellPanel
        open={threadRoot !== undefined}
        onOpenChange={(open) => {
          if (!open) setThreadId(undefined);
        }}
        title="Thread"
      >
        {threadRoot === undefined ? null : (
          <ThreadView
            message={threadRoot}
            replies={repliesOf(threadRoot.id)}
            channelName={props.channel}
            mode="panel"
            onReply={(text) => send(text, threadRoot.id)}
            row={row}
          />
        )}
      </ChatShellPanel>
    </section>
  );
}
