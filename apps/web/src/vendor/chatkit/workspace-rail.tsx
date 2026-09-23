/* Vendored from github.com/blamy/ui touchkit/packages/chatkit/src/lib/workspace-rail.tsx @ b7e037c (2026-08-29).
   @touchkit/chatkit is unpublished; keep edits minimal and mark them with "ef:" comments. */
import type { CSSProperties } from "react";
import { ChatIcon, chatIconPaths } from "./chat-icon.js";
import { K, KFONT } from "./chat-tokens.js";
import { cn } from "./cn.js";
import { kvib } from "./kvib.js";

export interface Workspace {
  id: string;
  /** one-letter (or short) label shown in the tile */
  label: string;
  color: string;
  active?: boolean;
  /** tooltip title; defaults to label */
  title?: string;
}

export interface WorkspaceRailProps {
  /** defaults to the prototype's TouchKit HQ / Creamery pair */
  workspaces?: Workspace[];
  onSelect?: (id: string) => void;
  onAdd?: () => void;
  /** tint used by the default workspaces' active tile */
  tint?: string;
  className?: string;
  style?: CSSProperties;
}

export function WorkspaceRail({
  workspaces,
  onSelect,
  onAdd,
  tint = "#0A84FF",
  className,
  style,
}: WorkspaceRailProps) {
  const ws: Workspace[] = workspaces ?? [
    { id: "touchkit", label: "T", color: tint, active: true, title: "TouchKit HQ" },
    { id: "creamery", label: "C", color: "#BF5AF2", title: "Creamery" },
  ];
  return (
    <div
      data-slot="workspace-rail"
      className={cn(className)}
      style={{
        width: 52,
        flexShrink: 0,
        background: K.rail,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        padding: "10px 0",
        borderRight: "1px solid " + K.sep,
        boxSizing: "border-box",
        ...style,
      }}
    >
      {ws.map((w) => (
        <button
          key={w.id}
          title={w.title ?? w.label}
          onClick={() => {
            kvib([5]);
            onSelect?.(w.id);
          }}
          style={{
            width: 34,
            height: 34,
            borderRadius: 11,
            border: w.active ? "2px solid " + w.color : "2px solid transparent",
            background: w.active ? w.color : K.fill2,
            color: "#fff",
            fontWeight: 800,
            fontSize: 14,
            cursor: "pointer",
            fontFamily: KFONT,
            flexShrink: 0,
          }}
        >
          {w.label}
        </button>
      ))}
      <button
        aria-label="Add workspace"
        onClick={() => {
          kvib([5]);
          onAdd?.();
        }}
        style={{
          width: 34,
          height: 34,
          borderRadius: 11,
          border: "1px dashed " + K.sep,
          background: "none",
          color: K.mut3,
          cursor: "pointer",
          display: "grid",
          placeItems: "center",
          flexShrink: 0,
        }}
      >
        <ChatIcon d={chatIconPaths.plus} size={14} />
      </button>
    </div>
  );
}
