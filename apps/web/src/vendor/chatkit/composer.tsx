/* Vendored from github.com/blamy/ui touchkit/packages/chatkit/src/lib/composer.tsx @ b7e037c (2026-08-29).
   @touchkit/chatkit is unpublished; keep edits minimal and mark them with "ef:" comments. */
import { useState, type CSSProperties } from "react";
import { ChatIcon, chatIconPaths } from "./chat-icon.js";
import { K, KFONT } from "./chat-tokens.js";
import { cn } from "./cn.js";
import { kvib } from "./kvib.js";

export interface ComposerProps {
  placeholder?: string;
  onSend: (text: string) => void;
  tint: string;
  autoFocus?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function Composer({
  placeholder,
  onSend,
  tint,
  autoFocus,
  className,
  style,
}: ComposerProps) {
  const [v, setV] = useState("");
  const send = () => {
    if (!v.trim()) return;
    kvib([8]);
    onSend(v.trim());
    setV("");
  };
  return (
    <div
      data-slot="composer"
      className={cn(className)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        background: K.card,
        border: "1px solid " + K.sep,
        borderRadius: 12,
        padding: "4px 4px 4px 13px",
        ...style,
      }}
    >
      <input
        value={v}
        autoFocus={autoFocus}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && send()}
        placeholder={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          border: 0,
          background: "none",
          outline: "none",
          color: K.label,
          fontSize: 13.5,
          fontFamily: KFONT,
          padding: "7px 0",
        }}
      />
      <button
        onClick={send}
        aria-label="Send"
        style={{
          border: 0,
          borderRadius: 9,
          width: 32,
          height: 32,
          background: v.trim() ? tint : K.fill2,
          color: "#fff",
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          transition: "background .2s",
          flexShrink: 0,
        }}
      >
        <ChatIcon d={chatIconPaths.send} size={15} sw={2.2} />
      </button>
    </div>
  );
}
