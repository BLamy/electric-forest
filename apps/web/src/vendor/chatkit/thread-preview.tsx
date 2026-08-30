/* Vendored from github.com/blamy/ui touchkit/packages/chatkit/src/lib/thread-preview.tsx @ b7e037c (2026-08-29).
   @touchkit/chatkit is unpublished; keep edits minimal and mark them with "ef:" comments. */
import type { CSSProperties } from "react";
import { ChatAvatar } from "./chat-avatar.js";
import { K, KFONT } from "./chat-tokens.js";
import { useChatUsers, type ChatThreadData, type ChatUsers } from "./chat-users.js";
import { cn } from "./cn.js";
import { kvib } from "./kvib.js";

export interface ThreadPreviewProps {
  th: ChatThreadData;
  onOpen: () => void;
  tint: string;
  users?: ChatUsers;
  className?: string;
  style?: CSSProperties;
}

export function ThreadPreview({ th, onOpen, tint, users, className, style }: ThreadPreviewProps) {
  const ctxUsers = useChatUsers();
  const map = users ?? ctxUsers;
  const last = th.msgs[th.msgs.length - 1];
  const lastUser = last === undefined ? undefined : map[last.u]; // ef: strict index access
  return (
    <button
      data-slot="thread-preview"
      className={cn(className)}
      onClick={() => {
        kvib([6]);
        onOpen();
      }}
      style={{
        display: "block",
        width: "100%",
        maxWidth: 520,
        textAlign: "left",
        marginTop: 7,
        cursor: "pointer",
        background: K.card,
        border: "1px solid " + K.sep,
        borderRadius: 10,
        padding: "8px 11px",
        fontFamily: KFONT,
        ...style,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5 }}>
        <span style={{ fontWeight: 650, color: K.label }}>{th.title}</span>
        <span style={{ color: tint, fontWeight: 600, whiteSpace: "nowrap" }}>
          {th.msgs.length} {th.msgs.length === 1 ? "message" : "messages"} ›
        </span>
      </span>
      {last && lastUser && (
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
            fontSize: 12,
            color: K.mut,
            minWidth: 0,
          }}
        >
          <ChatAvatar user={lastUser} size={15} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {lastUser.name}: {last.txt}
          </span>
        </span>
      )}
    </button>
  );
}
