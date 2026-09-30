/* Provenance: registry/blocks/discord-clone/components/channel-list.tsx — @brett_lamy/ui 2.0.0 registry block
   "discord-clone" (https://blamy.github.io/ui/r/discord-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Button, composeRenderProps } from "react-aria-components";
import { Icon, cn, useOptionalChatShell } from "@brett_lamy/ui";
import { cva } from "class-variance-authority";

/* ══ Channel navigation ══
   <ChannelList selectedKey onSelectionChange>
     <ChannelGroup label="Team">
       <ChannelItem id="general">general</ChannelItem>
       <ChannelItem id="dev" unread mentions={2}>dev</ChannelItem>
       <ChannelThreadItem onPress={…}>Repo connect spawning…</ChannelThreadItem>
   Picking a channel (or a thread row) inside a compact ChatShell also closes its navigation drawer. */

interface ChannelListContextValue {
  // ef: `| undefined` for exactOptionalPropertyTypes (strict TS).
  selectedKey?: string | null | undefined;
  onSelectionChange?: ((id: string) => void) | undefined;
}
const ChannelListContext = createContext<ChannelListContextValue>({});

export interface ChannelListProps extends Omit<ComponentProps<"nav">, "onChange"> {
  /** the current channel */
  selectedKey?: string | null;
  onSelectionChange?: (id: string) => void;
}

/** The scrolling channel list. Owns the selection its ChannelItems read. */
export function ChannelList({
  selectedKey,
  onSelectionChange,
  className,
  children,
  ...props
}: ChannelListProps) {
  return (
    <ChannelListContext.Provider value={{ selectedKey, onSelectionChange }}>
      <nav
        data-slot="channel-list"
        aria-label="Channels"
        className={cn("ck-scroll min-h-0 flex-1 overflow-y-auto px-[8px] py-[6px]", className)}
        {...props}
      >
        {children}
      </nav>
    </ChannelListContext.Provider>
  );
}

export interface ChannelGroupProps extends ComponentProps<"div"> {
  label: ReactNode;
}

/** A labelled section of channels ("Team", "Direct messages"). */
export function ChannelGroup({ label, className, children, ...props }: ChannelGroupProps) {
  return (
    <div
      data-slot="channel-group"
      role="group"
      aria-label={typeof label === "string" ? label : undefined}
      className={className}
      {...props}
    >
      <div className="px-[8px] pt-[11px] pb-[4px] text-[10px] font-bold tracking-[.7px] text-tertiary-foreground uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

function MentionPill({ n }: { n: number }) {
  return (
    <span
      data-slot="channel-item-mentions"
      className="box-border flex h-[16px] min-w-[16px] shrink-0 items-center justify-center rounded-full bg-destructive px-[4px] text-[10px] leading-none font-bold text-white"
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** A channel row: the selected one on the stronger fill; selected or unread rows bold. */
export const channelItemVariants = cva(
  "flex w-full cursor-pointer items-center gap-[7px] rounded-[8px] border-0 px-[8px] py-[5px] text-left font-ios text-[13.5px] [transition:background-color_var(--duration-spring-snappy)_var(--ease-spring-snappy)] motion-reduce:transition-none",
  {
    variants: {
      active: { true: "bg-secondary-strong", false: "bg-transparent data-hovered:bg-accent" },
      emphasized: {
        true: "font-[650] text-foreground",
        false: "font-normal text-muted-foreground",
      },
    },
    defaultVariants: { active: false, emphasized: false },
  },
);

// ef: the thread-row variants are not installed (thread rows are not listed in the sidebar).

export interface ChannelItemProps extends Omit<ComponentProps<typeof Button>, "id" | "children"> {
  id: string;
  children?: ReactNode;
  /** leading glyph; a # by default (pass a ChatAvatar for a DM) */
  icon?: ReactNode;
  /** new activity: bold label and a tint dot (hidden while selected) */
  unread?: boolean;
  /** mention count: a red pill (replaces the dot) */
  mentions?: number;
  /** overrides the list's selection */
  isActive?: boolean;
}

export function ChannelItem({
  id,
  icon,
  unread,
  mentions,
  isActive,
  className,
  children,
  onPress,
  ...props
}: ChannelItemProps) {
  const list = useContext(ChannelListContext);
  const shell = useOptionalChatShell();
  const on = isActive ?? list.selectedKey === id;
  return (
    <Button
      data-slot="channel-item"
      data-active={on || undefined}
      data-unread={unread || undefined}
      {...(on ? { "aria-current": "page" as const } : {})} // ef: no explicit undefined (exactOptionalPropertyTypes)
      onPress={(e) => {
        list.onSelectionChange?.(id);
        onPress?.(e);
        shell?.setNavOpen(false);
      }}
      className={composeRenderProps(className, (c) =>
        cn(channelItemVariants({ active: on, emphasized: on || !!unread }), c),
      )}
      {...props}
    >
      <span className="grid text-tertiary-foreground">
        {icon ?? <Icon name="number" size={13} sw={2} />}
      </span>
      <span className="flex-1 truncate">{children}</span>
      {mentions ? (
        <MentionPill n={mentions} />
      ) : (
        unread && !on && <span className="size-[7px] rounded-[50%] bg-primary" />
      )}
    </Button>
  );
}

// ef: ChannelThreadItem is not installed — threads open from their message (ChatShellPanel).
