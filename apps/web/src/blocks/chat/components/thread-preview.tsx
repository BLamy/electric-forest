/* Provenance: registry/blocks/discord-clone/components/thread-preview.tsx — @brett_lamy/ui 2.0.0 registry block
   "discord-clone" (https://blamy.github.io/ui/r/discord-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
import type { ComponentProps, ReactNode } from "react";
import { Button, composeRenderProps } from "react-aria-components";
import { ChatAvatar } from "./chat-avatar.js";
import type { ChatUser } from "./chat-avatar.js"; // ef: type moved from chat-users.tsx
import { cn } from "@brett_lamy/ui";

/* ══ ThreadPreview — the card under a message that opens its thread ══
   <ThreadPreview title="More relevant bugs" count={2} onPress={open}>
     <ThreadPreviewReply user={ada}>Testing and Network are getting results too.</ThreadPreviewReply>
   </ThreadPreview> */

export interface ThreadPreviewProps extends Omit<ComponentProps<typeof Button>, "children"> {
  title: ReactNode;
  /** number of replies */
  count: number;
  /** the latest reply (a ThreadPreviewReply) */
  children?: ReactNode;
}

export function ThreadPreview({ title, count, className, children, ...props }: ThreadPreviewProps) {
  return (
    <Button
      data-slot="thread-preview"
      className={composeRenderProps(className, (c) =>
        cn(
          "mt-[7px] block w-full max-w-[520px] cursor-pointer rounded-[10px] border border-border bg-card px-[11px] py-[8px] text-left font-ios [transition:border-color_var(--duration-spring-snappy)_var(--ease-spring-snappy)] data-hovered:border-secondary-strong motion-reduce:transition-none",
          c,
        ),
      )}
      {...props}
    >
      <span className="flex items-center gap-[7px] text-[12.5px]">
        <span className="font-[650] text-foreground">{title}</span>
        <span className="font-semibold whitespace-nowrap text-primary">
          {count} {count === 1 ? "message" : "messages"} ›
        </span>
      </span>
      {children}
    </Button>
  );
}

export interface ThreadPreviewReplyProps {
  user: ChatUser;
  children?: ReactNode;
  className?: string;
}

export function ThreadPreviewReply({ user, children, className }: ThreadPreviewReplyProps) {
  return (
    <span
      data-slot="thread-preview-reply"
      className={cn(
        "mt-[4px] flex min-w-0 items-center gap-[6px] text-[12px] text-muted-foreground",
        className,
      )}
    >
      <ChatAvatar user={user} size={15} />
      <span className="truncate">
        {user.name}: {children}
      </span>
    </span>
  );
}

export interface ThreadHeaderProps extends Omit<ComponentProps<"div">, "title"> {
  title: ReactNode;
  /** a line under the title ("Started by Ada in #dev") */
  description?: ReactNode;
}

/** Title block at the top of an open thread. */
export function ThreadHeader({ title, description, className, ...props }: ThreadHeaderProps) {
  return (
    <div
      data-slot="thread-header"
      className={cn("border-b border-border px-4 pt-1.5 pb-3", className)}
      {...props}
    >
      <div className="text-[16px] leading-[1.3] font-[750] text-foreground">{title}</div>
      {description != null && (
        <div className="mt-[3px] text-[11.5px] text-tertiary-foreground">{description}</div>
      )}
    </div>
  );
}
