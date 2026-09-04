/* Vendored from github.com/blamy/ui touchkit/packages/chatkit/src/lib/channel-list.tsx @ b7e037c (2026-08-29).
   @touchkit/chatkit is unpublished; keep edits minimal and mark them with "ef:" comments. */
import type { CSSProperties, ReactNode } from "react";
import { ChatAvatar } from "./chat-avatar.js";
import { ChatIcon, chatIconPaths } from "./chat-icon.js";
import { K, KFONT } from "./chat-tokens.js";
import type { ChatChannel, ChatChannels } from "./chat-users.js";
import { cn } from "./cn.js";
import { kvib } from "./kvib.js";

export interface ChannelListProps {
  chans: ChatChannels;
  cur: string;
  onPick: (id: string, threadId?: string) => void;
  tint: string;
  onClose?: (() => void) | null;
  /** header title slot — default matches the prototype's "TouchKit HQ" */
  title?: ReactNode;
  /** ef: replaces the built-in header row entirely; `null` renders no header. */
  header?: ReactNode | null;
  /** footer slot — default matches the prototype's Ada "online" footer */
  footer?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const defaultFooterUser = { name: "Ada", c: "#0A84FF", role: "#7EB6FF" };

function DefaultFooter() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "9px 12px",
        borderTop: "1px solid " + K.sep,
      }}
    >
      <ChatAvatar user={defaultFooterUser} size={26} />
      <div style={{ lineHeight: 1.1, flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: K.label }}>Ada</div>
        <div style={{ fontSize: 10, color: K.green, fontWeight: 600 }}>● online</div>
      </div>
      <span style={{ color: K.mut3, display: "grid" }}>
        <ChatIcon d={chatIconPaths.bell} size={14} />
      </span>
    </div>
  );
}

export function ChannelList({
  chans,
  cur,
  onPick,
  tint,
  onClose,
  title = "TouchKit HQ",
  header,
  footer,
  className,
  style,
}: ChannelListProps) {
  const secs: { name: string; items: [string, ChatChannel][] }[] = [];
  Object.entries(chans).forEach(([id, ch]) => {
    let s = secs.find((x) => x.name === ch.section);
    if (!s) {
      s = { name: ch.section, items: [] };
      secs.push(s);
    }
    s.items.push([id, ch]);
  });
  return (
    <div
      data-slot="channel-list"
      className={cn(className)}
      style={{
        width: 222,
        flexShrink: 0,
        background: K.side,
        borderRight: "1px solid " + K.sep,
        display: "flex",
        flexDirection: "column",
        fontFamily: KFONT,
        height: "100%",
        boxSizing: "border-box",
        ...style,
      }}
    >
      {header === undefined ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "13px 14px 9px",
            borderBottom: "1px solid " + K.sep,
          }}
        >
          <span
            style={{
              fontSize: 13.5,
              fontWeight: 800,
              color: K.label,
              letterSpacing: "-.1px",
              flex: 1,
            }}
          >
            {title}
          </span>
          {onClose ? (
            <button
              onClick={onClose}
              aria-label="Close channels"
              style={{
                border: 0,
                background: "none",
                color: K.mut3,
                cursor: "pointer",
                padding: 4,
                display: "grid",
              }}
            >
              <ChatIcon d={chatIconPaths.x} size={14} />
            </button>
          ) : (
            <span style={{ color: K.mut3, display: "grid" }}>
              <ChatIcon d={chatIconPaths.chev} size={13} style={{ transform: "rotate(90deg)" }} />
            </span>
          )}
        </div>
      ) : (
        header
      )}
      <div
        className="ck-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 8px" }}
      >
        {secs.map((s) => (
          <div key={s.name}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: ".7px",
                textTransform: "uppercase",
                color: K.mut3,
                padding: "11px 8px 4px",
              }}
            >
              {s.name}
            </div>
            {s.items.map(([id, ch]) => {
              const on = id === cur;
              const threads = ch.msgs.filter((m) => m.thread);
              return (
                <div key={id}>
                  <button
                    className="ck-hl"
                    onClick={() => {
                      kvib([5]);
                      onPick(id);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      border: 0,
                      borderRadius: 8,
                      padding: "5px 8px",
                      cursor: "pointer",
                      fontFamily: KFONT,
                      background: on ? K.fill2 : "none",
                      color: on ? K.label : ch.unread ? K.label : K.mut,
                      fontSize: 13.5,
                      fontWeight: on || ch.unread ? 650 : 400,
                      textAlign: "left",
                    }}
                  >
                    <span style={{ color: K.mut3, display: "grid" }}>
                      <ChatIcon d={chatIconPaths.hash} size={13} sw={2} />
                    </span>
                    <span
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {ch.label}
                    </span>
                    {ch.unread && !on && (
                      <span
                        style={{ width: 7, height: 7, borderRadius: "50%", background: tint }}
                      />
                    )}
                  </button>
                  {on &&
                    threads.map((m) => (
                      <button
                        key={m.id}
                        className="ck-hl"
                        onClick={() => {
                          kvib([4]);
                          onPick(id, m.id);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          width: "100%",
                          border: 0,
                          borderRadius: 7,
                          padding: "3px 8px 3px 24px",
                          cursor: "pointer",
                          fontFamily: KFONT,
                          background: "none",
                          color: K.mut3,
                          fontSize: 12,
                          textAlign: "left",
                        }}
                      >
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderLeft: "1.5px solid " + K.sep,
                            borderBottom: "1.5px solid " + K.sep,
                            borderRadius: "0 0 0 4px",
                            marginTop: -6,
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.thread?.title}
                        </span>
                      </button>
                    ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {footer === undefined ? <DefaultFooter /> : footer}
    </div>
  );
}
