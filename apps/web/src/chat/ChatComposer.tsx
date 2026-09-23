import { useMemo, useRef, useState } from "react";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { GitbookEditor } from "@brett_lamy/docstream-editor";
import { astToTiptap } from "@brett_lamy/docstream-editor/convert";
import { parseMarkdown } from "@brett_lamy/docstream/gitbook";
import { ChatIcon, chatIconPaths } from "../vendor/chatkit/index.js";

/**
 * Rich chat composer on Docstream's editor: the same GitBook document model the
 * message bodies render with, so what you compose is exactly what the stream stores.
 * `/` opens the block menu (hints, code, tables, …). Enter sends only from a plain
 * top-level line — inside any block it keeps the editor's own meaning (next item / new
 * line); ⌘/Ctrl+Enter always sends; Shift+Enter breaks a line. The slash menu keeps
 * its own Enter — it runs before this keymap.
 *
 * With `initialMarkdown` the composer becomes an inline editor for an existing message
 * (Save / Cancel, Escape cancels).
 */
export function ChatComposer(props: {
  readonly placeholder: string;
  readonly onSend: (markdown: string) => Promise<void> | void;
  readonly initialMarkdown?: string;
  readonly submitLabel?: string;
  readonly onCancel?: () => void;
  readonly autofocus?: boolean;
  readonly compact?: boolean;
}): React.JSX.Element {
  const [markdown, setMarkdown] = useState(props.initialMarkdown ?? "");
  const [busy, setBusy] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const markdownRef = useRef(markdown);
  markdownRef.current = markdown;
  const onSendRef = useRef(props.onSend);
  onSendRef.current = props.onSend;
  const onCancelRef = useRef(props.onCancel);
  onCancelRef.current = props.onCancel;
  const editing = props.initialMarkdown !== undefined;

  const send = async (): Promise<void> => {
    const body = markdownRef.current.trim();
    const editor = editorRef.current;
    if (body.length === 0 || busy || editor === null) return;
    setBusy(true);
    try {
      await onSendRef.current(body);
      if (!editing) {
        editor.commands.clearContent(true);
        setMarkdown("");
      }
    } finally {
      setBusy(false);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  const keymap = useMemo(
    () =>
      Extension.create({
        name: "chatComposerKeys",
        addKeyboardShortcuts() {
          return {
            Enter: ({ editor }) => {
              // While the slash menu is open Enter belongs to it (TipTap runs this
              // keymap first). Inside any structured block — list item, task, step,
              // hint, quote, table, code — Enter keeps the editor's own meaning
              // (next item / new line). Only a plain top-level paragraph sends.
              if (document.querySelector(".slash-menu") !== null) return false;
              if (!caretOnPlainLine(editor)) return false;
              void sendRef.current();
              return true;
            },
            "Mod-Enter": () => {
              void sendRef.current();
              return true;
            },
            "Shift-Enter": ({ editor }) => editor.commands.insertContent({ type: "hardBreak" }),
            Escape: () => {
              if (onCancelRef.current === undefined) return false;
              onCancelRef.current();
              return true;
            },
          };
        },
      }),
    [],
  );

  // Pasted Markdown (a copied message, a README excerpt, a GitBook block) becomes rich
  // blocks through the same parser the renderer uses; plain prose pastes as-is.
  const pasteMarkdown = useMemo(
    () =>
      Extension.create({
        name: "chatPasteMarkdown",
        addProseMirrorPlugins() {
          return [
            new Plugin({
              props: {
                handlePaste: (_view, event) => {
                  const text = event.clipboardData?.getData("text/plain") ?? "";
                  if (!looksLikeMarkdown(text)) return false;
                  const editor = editorRef.current;
                  if (editor === null) return false;
                  const doc = astToTiptap(parseMarkdown(text));
                  if (doc.content === undefined || doc.content.length === 0) return false;
                  event.preventDefault();
                  editor.commands.insertContent(doc.content);
                  return true;
                },
              },
            }),
          ];
        },
      }),
    [],
  );

  const empty = markdown.trim().length === 0;
  const unchanged = editing && markdown.trim() === (props.initialMarkdown ?? "").trim();
  return (
    <div
      className={editing ? "chat-composer-editor chat-composer-editing" : "chat-composer-editor"}
      data-testid={editing ? "chat-edit-composer" : "chat-composer"}
      data-busy={busy}
    >
      <GitbookEditor
        toolbar={false}
        slashMenu
        placeholder={props.placeholder}
        className={
          props.compact ? "chat-composer-doc chat-composer-doc-compact" : "chat-composer-doc"
        }
        {...(editing ? { markdown: props.initialMarkdown } : {})}
        autofocus={props.autofocus ?? editing}
        onChange={setMarkdown}
        extensions={[keymap, pasteMarkdown]}
        onEditorReady={(editor: Editor | null) => {
          editorRef.current = editor;
        }}
      />
      {editing ? (
        <div className="chat-edit-actions">
          <button type="button" className="chat-edit-cancel" onClick={() => props.onCancel?.()}>
            Cancel
          </button>
          <button
            type="button"
            className="chat-edit-save"
            data-testid="chat-edit-save"
            disabled={empty || unchanged || busy}
            onClick={() => void send()}
          >
            {busy ? "Saving…" : (props.submitLabel ?? "Save")}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="chat-send"
          aria-label="Send message"
          data-testid="chat-send"
          disabled={empty || busy}
          onClick={() => void send()}
        >
          <ChatIcon d={chatIconPaths.send} size={15} sw={2.2} />
        </button>
      )}
    </div>
  );
}

/** True when the caret sits in a top-level paragraph with nothing structural around it. */
function caretOnPlainLine(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  return empty && $from.depth === 1 && $from.parent.type.name === "paragraph";
}

const MARKDOWN_HINTS = [
  /^\s{0,3}#{1,6}\s/m, // headings
  /^\s*(?:[-*+]|\d+[.)])\s/m, // lists
  /^\s*>\s/m, // quotes
  /```/, // fenced code
  /\{%\s*[a-z-]+/, // GitBook blocks
  /\*\*[^*\n]+\*\*|__[^_\n]+__/, // bold
  /`[^`\n]+`/, // inline code
  /\[[^\]\n]+\]\([^)\s]+\)/, // links
  /^\s*\|.+\|\s*$/m, // tables
  /^\s*(?:---|\*\*\*)\s*$/m, // rules
];

export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_HINTS.some((pattern) => pattern.test(text));
}
