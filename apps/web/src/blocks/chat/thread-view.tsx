/* Provenance: registry/blocks/discord-clone/thread-view.tsx — @brett_lamy/ui 2.0.0 registry block
   "discord-clone" (https://blamy.github.io/ui/r/discord-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
import type { CSSProperties } from "react";
import { ChatShellFooter, cn } from "@brett_lamy/ui";
import type { ChatMessage } from "@eforest/reducers";
import { ChatComposer } from "./components/chat-composer.js";
import { MessageDivider, MessageList, MessageListEmpty } from "./components/message-list.js";
import { ThreadHeader } from "./components/thread-preview.js";
import { ChannelMessage, chatUserOf, type ChannelMessageProps } from "./channel-message.js";

// ef: a thread is the root message plus the stream messages whose `threadOf` names it; a reply is a
// `chat.message.post` dispatch with `threadOf` (no local reply list).
export interface ThreadViewProps {
  /** the message the thread hangs off */
  message: ChatMessage;
  replies: readonly ChatMessage[];
  channelName: string;
  /** `panel` beside the channel, or `full` in place of it */
  mode: "panel" | "full";
  onReply: (text: string) => Promise<void>;
  /** ef: how each message row is wired (mine, dispatch, references, runs). */
  row: (message: ChatMessage) => Omit<ChannelMessageProps, "message" | "replies" | "onOpenThread">;
}

// ef:begin root + threadOf replies from the stream; replies are chat.message.post dispatches
/** An open thread: its root message, the replies, and a reply composer. */
export function ThreadView({ message, replies, channelName, mode, onReply, row }: ThreadViewProps) {
  const author = chatUserOf(message.actor);
  const n = replies.length;
  const title =
    message.body.replace(/\s+/g, " ").slice(0, 36) + (message.body.length > 36 ? "…" : "");
  return (
    <div
      className={cn(
        "mx-auto box-border flex h-full w-full flex-col font-ios",
        mode === "full" ? "max-w-[760px]" : "max-w-none",
      )}
      data-testid="chat-thread"
      data-thread-root={message.id}
    >
      <MessageList className="pt-1 pb-2.5">
        {mode === "panel" && (
          <ThreadHeader
            title={title}
            // One line: splitting the surrounding text into more nodes shifts its kerning.
            description={
              <>
                Started by{" "}
                <span
                  className="ck-role font-semibold text-[color:var(--ck-role)]"
                  style={{ "--ck-role": author.role } as CSSProperties}
                >
                  {author.name}
                </span>{" "}
                in #{channelName}
              </>
            }
          />
        )}
        <div className="px-1 pt-2.5">
          <ChannelMessage
            message={message}
            replies={[]}
            onOpenThread={undefined}
            inThread
            {...row(message)}
          />
          {n > 0 && (
            <MessageDivider>
              {n} {n === 1 ? "reply" : "replies"}
            </MessageDivider>
          )}
          {replies.map((reply) => (
            <ChannelMessage
              key={reply.offset || reply.id}
              message={reply}
              replies={[]}
              onOpenThread={undefined}
              inThread
              {...row(reply)}
            />
          ))}
          {n === 0 && <MessageListEmpty>No replies yet — say something.</MessageListEmpty>}
        </div>
      </MessageList>
      <ChatShellFooter className="px-3">
        <ChatComposer
          {...(row(message).references === undefined
            ? {}
            : { references: row(message).references })}
          placeholder="Reply in thread"
          onSend={onReply}
          autoFocus={mode === "panel"}
          compact
        />
      </ChatShellFooter>
    </div>
  );
}
// ef:end
