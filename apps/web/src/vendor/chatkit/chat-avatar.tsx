/* Vendored from github.com/blamy/ui touchkit/packages/chatkit/src/lib/chat-avatar.tsx @ b7e037c (2026-08-29).
   @touchkit/chatkit is unpublished; keep edits minimal and mark them with "ef:" comments. */
import type { CSSProperties } from "react";
import { ChatIcon, chatIconPaths } from "./chat-icon.js";
import { KFONT } from "./chat-tokens.js";
import type { ChatUser } from "./chat-users.js";
import { cn } from "./cn.js";

export interface ChatAvatarProps {
  user: ChatUser;
  size?: number;
  square?: boolean;
  className?: string;
  style?: CSSProperties;
}

/* ef: keep initials readable when the supplied workspace/user color is light. */
function avatarForeground(color: string): string {
  const match = /^#([0-9a-f]{6})/i.exec(color);
  if (match === null) return "#fff";
  const channels = [0, 2, 4].map(
    (index) => Number.parseInt(match[1]!.slice(index, index + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const luminance = 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  return luminance > 0.25 ? "#07140c" : "#fff";
}

export function ChatAvatar({ user, size = 36, square, className, style }: ChatAvatarProps) {
  return (
    <span
      data-slot="chat-avatar"
      className={cn(className)}
      style={{
        width: size,
        height: size,
        borderRadius: square ? size * 0.3 : "50%",
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        background: "linear-gradient(135deg, " + user.c + ", " + user.c + "88)",
        color: avatarForeground(user.c),
        fontWeight: 800,
        fontSize: size * 0.42,
        fontFamily: KFONT,
        ...style,
      }}
    >
      {user.bot ? <ChatIcon d={chatIconPaths.spark} size={size * 0.5} sw={2.2} /> : user.name[0]}
    </span>
  );
}
