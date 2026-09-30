/* Provenance: registry/blocks/discord-clone/components/message-list.tsx — @brett_lamy/ui 2.0.0 registry block
   "discord-clone" (https://blamy.github.io/ui/r/discord-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
import { useLayoutEffect, useRef, type ComponentProps, type ReactNode, type Ref } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Icon, cn } from "@brett_lamy/ui";

/* ══ Transcript parts ══
   <MessageList scrollKey={channelId}>
     <ChannelIntro title="Welcome to #dev">…</ChannelIntro>
     <DateDivider>August 12, 2026</DateDivider>
     <Message …/> …
     (ef: no TypingIndicator row — chat streams carry no typing events)
   </MessageList> */

export interface MessageListProps extends ComponentProps<"div"> {
  /** keep the list pinned to the newest message while the reader is at the bottom (default true) */
  autoScroll?: boolean;
  /** changing it (switching channels) snaps back to the bottom */
  scrollKey?: string | number;
}

/** The scrolling transcript (a `log` region). Pinned to the bottom until the reader scrolls up. */
export function MessageList({
  autoScroll = true,
  scrollKey,
  className,
  onScroll,
  ref,
  ...props
}: MessageListProps) {
  const el = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const key = useRef(scrollKey);
  useLayoutEffect(() => {
    if (key.current !== scrollKey) {
      key.current = scrollKey;
      stick.current = true;
    }
    if (autoScroll && stick.current && el.current) el.current.scrollTop = el.current.scrollHeight;
  });
  return (
    <div
      ref={(node) => {
        el.current = node;
        setRef(ref, node);
      }}
      data-slot="message-list"
      role="log"
      aria-live="polite"
      onScroll={(e) => {
        const t = e.currentTarget;
        stick.current = t.scrollHeight - t.scrollTop - t.clientHeight < 48;
        onScroll?.(e);
      }}
      className={cn("ck-scroll relative min-h-0 flex-1 overflow-y-auto py-3", className)}
      {...props}
    />
  );
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

// ef: MessageGroup is not installed — every stream message renders as its own row.

export interface ChannelIntroProps extends Omit<ComponentProps<"div">, "title"> {
  title: ReactNode;
  /** the tile glyph; a # by default */
  icon?: ReactNode;
}

/** "Welcome to #channel" at the top of a transcript. */
export function ChannelIntro({ title, icon, className, children, ...props }: ChannelIntroProps) {
  return (
    <div data-slot="channel-intro" className={cn("px-[18px] pb-2.5", className)} {...props}>
      <div className="mb-2 grid size-10 place-items-center rounded-[12px] bg-secondary-strong text-muted-foreground">
        {icon ?? <Icon name="number" size={20} sw={2.2} />}
      </div>
      <div className="text-[15.5px] font-[750]">{title}</div>
      {children != null && (
        <div className="mt-0.5 text-[12px] text-tertiary-foreground">{children}</div>
      )}
    </div>
  );
}

export const messageDividerVariants = cva(
  "flex items-center gap-2 px-[18px] text-[10.5px] text-tertiary-foreground",
  {
    variants: {
      variant: {
        /** a day boundary */
        date: "pt-1 pb-2 font-semibold",
        /** a quieter rule ("3 replies", "New") */
        subtle: "py-1.5",
      },
    },
    defaultVariants: { variant: "subtle" },
  },
);

export interface MessageDividerProps
  extends ComponentProps<"div">, VariantProps<typeof messageDividerVariants> {}

/** A labelled rule across the transcript. */
export function MessageDivider({ variant, className, children, ...props }: MessageDividerProps) {
  return (
    <div
      data-slot="message-divider"
      className={cn(messageDividerVariants({ variant }), className)}
      {...props}
    >
      <span className="h-px flex-1 bg-border" />
      {children}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** `MessageDivider variant="date"`. */
export function DateDivider(props: Omit<MessageDividerProps, "variant">) {
  return <MessageDivider variant="date" {...props} />;
}

/** Placeholder text for an empty transcript or thread. */
export function MessageListEmpty({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-list-empty"
      className={cn("px-[18px] py-3.5 text-[12.5px] text-tertiary-foreground", className)}
      {...props}
    />
  );
}

// ef: TypingIndicator is not installed — the chat streams carry no typing events.
