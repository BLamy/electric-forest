/* Vendored from github.com/blamy/ui touchkit/packages/chatkit/src/lib/message.tsx @ b7e037c (2026-08-29).
   @touchkit/chatkit is unpublished; keep edits minimal and mark them with "ef:" comments. */
import type { CSSProperties } from "react";
import { ChatAvatar } from "./chat-avatar.js";
import { ChatIcon, chatIconPaths } from "./chat-icon.js";
import { K, KFONT } from "./chat-tokens.js";
import { useChatUsers, type ChatMessageData, type ChatUsers } from "./chat-users.js";
import { cn } from "./cn.js";
import { kvib } from "./kvib.js";
import { RichText } from "./rich-text.js";
import { ThreadPreview } from "./thread-preview.js";

export interface MessageProps {
  m: ChatMessageData;
  tint: string;
  onReact: (id: string, i: number) => void;
  onOpenThread: (id: string) => void;
  onStartThread: (id: string) => void;
  users?: ChatUsers;
  className?: string;
  style?: CSSProperties;
}

export function Message({
  m,
  tint,
  onReact,
  onOpenThread,
  onStartThread,
  users,
  className,
  style,
}: MessageProps) {
  const ctxUsers = useChatUsers();
  const map = users ?? ctxUsers;
  // ef: unknown authors render with a neutral identity instead of crashing.
  const usr = map[m.u] ?? { name: m.u, c: "#6b7280", role: K.mut };
  return (
    <div
      data-slot="message"
      className={cn("ck-row", className)}
      style={{
        position: "relative",
        display: "flex",
        gap: 11,
        padding: "7px 18px",
        fontFamily: KFONT,
        ...style,
      }}
    >
      <ChatAvatar user={usr} size={36} square={usr.bot ?? false} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: usr.role }}>{usr.name}</span>
          {usr.bot && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 800,
                letterSpacing: ".4px",
                background: tint,
                color: "#fff",
                borderRadius: 4,
                padding: "1px 5px",
              }}
            >
              APP
            </span>
          )}
          <span style={{ fontSize: 10.5, color: K.mut3 }}>{m.t}</span>
        </div>
        <div
          style={{
            fontSize: 13.5,
            lineHeight: 1.55,
            color: K.label,
            marginTop: 1,
            overflowWrap: "break-word",
          }}
        >
          <RichText text={m.txt} users={map} />
        </div>
        {m.reacts.length > 0 && (
          <div style={{ display: "flex", gap: 5, marginTop: 6 }}>
            {m.reacts.map(([e, n, mine], i) => (
              <button
                key={i}
                onClick={() => {
                  kvib([5]);
                  onReact(m.id, i);
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  border: "1px solid " + (mine ? tint : K.sep),
                  background: mine ? "rgba(10,132,255,.14)" : K.fill,
                  borderRadius: 999,
                  padding: "2px 8px",
                  fontSize: 12,
                  color: K.label,
                  cursor: "pointer",
                  fontFamily: KFONT,
                }}
              >
                {e}
                <span style={{ fontSize: 11, color: mine ? "#7EB6FF" : K.mut }}>{n}</span>
              </button>
            ))}
          </div>
        )}
        {m.thread && (
          <ThreadPreview th={m.thread} tint={tint} users={map} onOpen={() => onOpenThread(m.id)} />
        )}
      </div>
      <div
        className="ck-acts"
        style={{
          position: "absolute",
          top: -10,
          right: 16,
          display: "flex",
          gap: 2,
          opacity: 0,
          transition: "opacity .15s",
          background: K.card,
          border: "1px solid " + K.sep,
          borderRadius: 9,
          padding: 2,
        }}
      >
        <button
          onClick={() => {
            kvib([5]);
            onReact(m.id, -1);
          }}
          title="Add 👍"
          style={{
            border: 0,
            background: "none",
            cursor: "pointer",
            fontSize: 13,
            padding: "3px 6px",
            borderRadius: 7,
          }}
          className="ck-hl"
        >
          👍
        </button>
        <button
          onClick={() => {
            kvib([6]);
            if (m.thread) onOpenThread(m.id);
            else onStartThread(m.id); // ef: statement form for lint
          }}
          title={m.thread ? "Open thread" : "Start thread"}
          style={{
            border: 0,
            background: "none",
            color: K.mut,
            cursor: "pointer",
            padding: "3px 6px",
            borderRadius: 7,
            display: "grid",
          }}
          className="ck-hl"
        >
          <ChatIcon d={chatIconPaths.thread} size={14} />
        </button>
      </div>
    </div>
  );
}
