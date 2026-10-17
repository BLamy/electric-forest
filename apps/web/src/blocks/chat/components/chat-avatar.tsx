/* Provenance: registry/blocks/discord-clone/components/chat-avatar.tsx — @brett_lamy/ui 2.0.0 registry block
   "discord-clone" (https://blamy.github.io/ui/r/discord-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
import type { CSSProperties } from "react";
import { Icon, cn } from "@brett_lamy/ui";
// ef: chat-users.tsx (the RichText mention context) is not installed; its ChatUser type lives here.
/** A chat participant, as avatars, author names and @mentions render them. */
export interface ChatUser {
  name: string;
  /** avatar/base color */
  c: string;
  /** name label color */
  role: string;
  bot?: boolean;
}
import { cva } from "class-variance-authority";

export interface ChatAvatarProps {
  user: ChatUser;
  size?: number;
  // ef: `| undefined` for exactOptionalPropertyTypes (strict TS).
  square?: boolean | undefined;
  /** presence dot on the lower-right; ringed in `--ck-avatar-ring` (the surface it sits on: ChatShell regions set it) */
  status?: "online" | "idle" | "dnd" | "offline" | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

/** Initial (or bot spark) on a diagonal gradient of the user's color. Size and color arrive as CSS variables. */
export const chatAvatarVariants = cva(
  "grid size-(--ck-avatar-size) shrink-0 place-items-center bg-(image:--ck-avatar-bg) font-ios text-(length:--ck-avatar-font) font-extrabold text-white",
  {
    variants: {
      /** A rounded square (bots) instead of a circle. */
      square: { true: "rounded-(--ck-avatar-radius)", false: "rounded-[50%]" },
    },
    defaultVariants: { square: false },
  },
);

/** The presence dot, ringed in the surface colour. */
export const chatAvatarStatusVariants = cva(
  "absolute -right-[2px] -bottom-[2px] box-border size-[max(10px,calc(var(--ck-avatar-size)*.36))] rounded-full border-[2.5px] border-(--ck-avatar-ring,var(--background))",
  {
    variants: {
      status: {
        online: "bg-success",
        idle: "bg-warning",
        dnd: "bg-destructive",
        offline: "bg-tertiary-foreground",
      },
    },
    defaultVariants: { status: "online" },
  },
);

export function ChatAvatar({ user, size = 36, square, status, className, style }: ChatAvatarProps) {
  return (
    <span
      data-slot="chat-avatar"
      className={cn(chatAvatarVariants({ square: !!square }), status && "relative", className)}
      style={
        {
          "--ck-avatar-size": `${size}px`,
          "--ck-avatar-font": `${size * 0.42}px`,
          "--ck-avatar-radius": `${size * 0.3}px`,
          "--ck-avatar-bg": `linear-gradient(135deg, ${user.c}, ${user.c}88)`,
          ...style,
        } as CSSProperties
      }
    >
      {user.bot ? <Icon name="sparkle" size={size * 0.5} sw={2.2} /> : user.name[0]}
      {status && (
        <span
          data-slot="chat-avatar-status"
          data-status={status}
          aria-label={status}
          className={chatAvatarStatusVariants({ status })}
        />
      )}
    </span>
  );
}
