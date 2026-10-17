/* Provenance: registry/blocks/discord-clone/components/message.tsx — @brett_lamy/ui 2.0.0 registry block
   "discord-clone" (https://blamy.github.io/ui/r/discord-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
import { createContext, useContext, type ComponentProps, type CSSProperties } from "react";
import { Button, composeRenderProps } from "react-aria-components"; // ef: no ToggleButton (no reactions)
import { cva, type VariantProps } from "class-variance-authority";
import { ChatAvatar } from "./chat-avatar.js";
// ef: rich-text.tsx is not installed — message bodies are Docstream Markdown elements, never RichText.
import type { ChatUser } from "./chat-avatar.js"; // ef: type moved from chat-users.tsx
import { cn } from "@brett_lamy/ui";

/* ══ Message — one row of a transcript, from parts ══
   <Message user={ada}>
     <MessageAvatar />
     <MessageBody>
       <MessageHeader><MessageAuthor /><MessageTimestamp>9:12 AM</MessageTimestamp></MessageHeader>
       <MessageContent>Morning @noor!</MessageContent>
       (ef: no MessageReactions — chat streams carry no reaction events)
       <ThreadPreview … />
     </MessageBody>
     <MessageActions><MessageAction label="Add 👍">👍</MessageAction></MessageActions>
   </Message>
   The row provides its author to the parts, so MessageAvatar / MessageAuthor need no props. */

interface MessageContextValue {
  // ef: `| undefined` for exactOptionalPropertyTypes (strict TS).
  user?: ChatUser | undefined;
  variant: "default" | "continued";
}
const MessageContext = createContext<MessageContextValue>({ variant: "default" });

/** react-aria's Button drops `title`, so the tooltip goes on through a ref. */
const titleRef = (title: string) => (el: HTMLElement | null) => {
  if (el) el.title = title;
};

export const messageVariants = cva(
  "group/message relative flex gap-[11px] px-[18px] font-ios [&:hover]:bg-accent",
  {
    variants: {
      variant: {
        default: "py-[7px]",
        /** a follow-up from the same author: no avatar or header, tighter rows */
        continued: "py-[2px]",
      },
      /** rise into place (new messages) */
      appear: {
        true: "animate-[ck-in_var(--duration-spring-smooth)_var(--ease-spring-smooth)_both] motion-reduce:animate-none",
        false: "",
      },
    },
    defaultVariants: { variant: "default", appear: false },
  },
);

export interface MessageProps extends ComponentProps<"div">, VariantProps<typeof messageVariants> {
  /** the author, read by MessageAvatar and MessageAuthor */
  user?: ChatUser;
}

export function Message({ user, variant, appear, className, style, ...props }: MessageProps) {
  return (
    <MessageContext.Provider value={{ user, variant: variant ?? "default" }}>
      <div
        data-slot="message"
        data-variant={variant ?? "default"}
        className={cn(messageVariants({ variant, appear }), className)}
        style={{ "--ck-role": user?.role, ...style } as CSSProperties}
        {...props}
      />
    </MessageContext.Provider>
  );
}

export interface MessageAvatarProps {
  user?: ChatUser;
  size?: number;
  className?: string;
  style?: CSSProperties;
}

/** The author's avatar (bots get a rounded square). In a continued row it keeps the gutter empty. */
export function MessageAvatar({ user: userProp, size = 36, className, style }: MessageAvatarProps) {
  const { user: ctxUser, variant } = useContext(MessageContext);
  const user = userProp ?? ctxUser;
  if (variant === "continued" || !user) {
    return (
      <span
        data-slot="message-avatar"
        aria-hidden
        className={cn("shrink-0", className)}
        style={{ width: size, ...style }}
      />
    );
  }
  return (
    <ChatAvatar user={user} size={size} square={user.bot} className={className} style={style} />
  );
}

export function MessageBody({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="message-body" className={cn("min-w-0 flex-1", className)} {...props} />;
}

export function MessageHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-header"
      className={cn("flex items-baseline gap-[7px]", className)}
      {...props}
    />
  );
}

/** The author's name in their role color; defaults to the row's user. */
export function MessageAuthor({ className, children, ...props }: ComponentProps<"span">) {
  const { user } = useContext(MessageContext);
  return (
    <span
      data-slot="message-author"
      className={cn("ck-role text-[13.5px] font-bold text-(--ck-role)", className)}
      {...props}
    >
      {children ?? user?.name}
    </span>
  );
}

/** A small tag after the name ("APP", "BOT", "MOD"). */
export function MessageBadge({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="message-badge"
      className={cn(
        "rounded-[4px] bg-primary px-[5px] py-px text-[9px] font-extrabold tracking-[.4px] text-white",
        className,
      )}
      {...props}
    />
  );
}

export function MessageTimestamp({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="message-timestamp"
      className={cn("text-[10.5px] text-tertiary-foreground", className)}
      {...props}
    />
  );
}

// ef:begin children render as given (Docstream adapter), never RichText
/** The message text. A string child is rendered as RichText (so @mentions become chips). */
// ef: children render as given — the forest passes the Docstream adapter (components/markdown), so a
// message body can never reach the DOM through RichText or another Markdown renderer.
export function MessageContent({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn(
        "mt-px text-[13.5px] leading-[1.55] wrap-break-word text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
// ef:end

// ef: MessageReactions / MessageReaction are not installed — no reaction events exist on chat streams.

/** The floating action bar on the row's top-right corner: shown on hover and on keyboard focus. */
export function MessageActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-actions"
      className={cn(
        "absolute -top-[10px] right-[16px] flex gap-[2px] rounded-[9px] border border-border bg-card p-[2px] opacity-0 [transition:opacity_var(--duration-spring-snappy)_var(--ease-spring-snappy)] group-hover/message:opacity-100 has-data-focus-visible:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

export interface MessageActionProps extends ComponentProps<typeof Button> {
  /** accessible name and tooltip */
  label: string;
}

export function MessageAction({ label, className, ...props }: MessageActionProps) {
  return (
    <Button
      data-slot="message-action"
      aria-label={label}
      ref={titleRef(label)}
      className={composeRenderProps(className, (c) =>
        cn(
          "grid cursor-pointer place-items-center rounded-[7px] border-0 bg-transparent px-[6px] py-[3px] text-[13px] text-muted-foreground data-hovered:bg-secondary",
          c,
        ),
      )}
      {...props}
    />
  );
}
