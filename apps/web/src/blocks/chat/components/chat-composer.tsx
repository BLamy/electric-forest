/* Provenance: registry/blocks/discord-clone/components/chat-composer.tsx — @brett_lamy/ui 2.0.0 registry block
   "discord-clone" (https://blamy.github.io/ui/r/discord-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
// ef:begin the field is Docstream's GitbookEditor (TipTap keymap + Markdown paste)
import { useMemo, useRef, useState } from "react";
import { Button, composeRenderProps } from "react-aria-components";
import { Icon, cn } from "@brett_lamy/ui";
import { cva } from "class-variance-authority";
import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { GitbookEditor } from "@brett_lamy/docstream-editor/editor";
import { astToTiptap } from "@brett_lamy/docstream-editor/convert";
import type { ReferenceSources } from "@brett_lamy/docstream-editor";
import { parseMarkdown } from "@brett_lamy/docstream/gitbook";
// ef:end

/* ══ ChatComposer — the message field ══
   <ChatComposer onSend={send} placeholder="Message #dev" />      // input + send button
   <ChatComposer onSend={send}>                                  // or compose it
     <ChatComposerAction aria-label="Attach"><Icon name="plus" size={16} sw={1.9} /></ChatComposerAction>
     <ChatComposerInput placeholder="Message #dev" />
     <ChatComposerSend />
   </ChatComposer>
   Enter sends; the field clears after a send. */
// ef: the field is Docstream's GitbookEditor (the same GitBook document model message bodies render
// with, so what you compose is exactly what the stream stores) instead of a plain Input. `/` opens the
// block menu; Enter sends only from a plain top-level line (inside any block it keeps the editor's
// meaning); ⌘/Ctrl+Enter always sends; Shift+Enter breaks a line. With `initialMarkdown` the composer
// edits an existing message (Save / Cancel, Escape cancels). `onSend` resolves once the dispatch
// is confirmed; the field clears only then.

// ef:begin edit mode, compact sizing and reference pickers; onSend resolves on dispatch
export interface ChatComposerProps {
  onSend: (markdown: string) => Promise<void> | void;
  /** placeholder of the default input */
  placeholder?: string;
  /** focus the default input on mount */
  autoFocus?: boolean;
  // ef: edit mode, compact sizing and `@` / `#` / `$` reference pickers.
  initialMarkdown?: string;
  submitLabel?: string;
  onCancel?: () => void;
  compact?: boolean;
  references?: ReferenceSources;
  className?: string;
}
// ef:end

// ef:begin GitbookEditor field; clears only after the dispatch confirms
export function ChatComposer({
  onSend,
  placeholder,
  autoFocus,
  initialMarkdown,
  submitLabel,
  onCancel,
  compact,
  references,
  className,
}: ChatComposerProps) {
  const [markdown, setMarkdown] = useState(initialMarkdown ?? "");
  const [busy, setBusy] = useState(false);
  const editorRef = useRef<Editor | null>(null);
  const markdownRef = useRef(markdown);
  markdownRef.current = markdown;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const editing = initialMarkdown !== undefined;

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
              // While the slash menu is open Enter belongs to it (TipTap runs this keymap first).
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

  // Pasted Markdown becomes rich blocks through the same parser the renderer uses.
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
  const unchanged = editing && markdown.trim() === (initialMarkdown ?? "").trim();
  return (
    <div
      data-slot="chat-composer"
      data-testid={editing ? "chat-edit-composer" : "chat-composer"}
      data-busy={busy}
      className={cn(
        "flex items-end gap-[8px] rounded-[12px] border border-border bg-card py-[4px] pr-[4px] pl-[13px]",
        editing && "flex-col items-stretch pr-[13px] pb-[8px]",
        className,
      )}
    >
      <GitbookEditor
        toolbar={false}
        slashMenu
        {...(references === undefined ? {} : { references })}
        {...(placeholder === undefined ? {} : { placeholder })}
        // ef: the editor sheet is unlayered (`.gb` page layout), so the composer sizing needs `!`.
        className={cn(
          "m-0! w-full max-w-none! min-w-0 flex-1 p-0! text-[13.5px]! leading-normal! text-foreground",
          "min-h-0! overflow-y-auto [&_.ProseMirror]:min-h-6! [&_.ProseMirror]:py-1.5! [&_.ProseMirror]:outline-none",
          "[&_.ProseMirror_p]:m-0! [&_.ProseMirror>*+*]:mt-[0.4em]!",
          compact ? "max-h-40!" : "max-h-[40vh]!",
        )}
        {...(editing ? { markdown: initialMarkdown } : {})}
        autofocus={autoFocus ?? editing}
        onChange={setMarkdown}
        extensions={[keymap, pasteMarkdown]}
        onEditorReady={(editor: Editor | null) => {
          editorRef.current = editor;
          // The editable surface is the composer's only field: name it for assistive tech
          // (through editorProps, which ProseMirror applies on mount and every update).
          if (editor !== null) labelEditor(editor, placeholder ?? "Message");
        }}
      />
      {editing ? (
        <div className="flex justify-end gap-2">
          <Button
            onPress={() => onCancel?.()}
            className="cursor-pointer rounded-[8px] border border-border bg-transparent px-2.5 py-1 text-[12px] font-semibold text-muted-foreground data-hovered:bg-accent"
          >
            Cancel
          </Button>
          <Button
            data-testid="chat-edit-save"
            isDisabled={empty || unchanged || busy}
            onPress={() => void send()}
            className="cursor-pointer rounded-[8px] border-0 bg-primary px-2.5 py-1 text-[12px] font-semibold text-primary-foreground data-disabled:opacity-50"
          >
            {busy ? "Saving…" : (submitLabel ?? "Save")}
          </Button>
        </div>
      ) : (
        <ChatComposerSend
          ready={!empty && !busy}
          isDisabled={empty || busy}
          onPress={() => void send()}
        />
      )}
    </div>
  );
}
// ef:end

// ef:begin Enter/paste helpers for the Docstream editor
/** True when the caret sits in a top-level paragraph with nothing structural around it. */
/** Adds an accessible name to the editor's editable element, keeping its other attributes. */
function labelEditor(editor: Editor, label: string): void {
  const current = editor.options.editorProps?.attributes;
  editor.setOptions({
    editorProps: {
      ...editor.options.editorProps,
      attributes: (state) => ({
        ...(typeof current === "function" ? current(state) : (current ?? {})),
        "aria-label": label,
        "aria-multiline": "true",
      }),
    },
  });
}

function caretOnPlainLine(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;
  return empty && $from.depth === 1 && $from.parent.type.name === "paragraph";
}
// ef:end

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

// ef: pasted text is parsed as Markdown only when it looks like Markdown.
export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_HINTS.some((pattern) => pattern.test(text));
}

// ef:begin ready tint reads the forest primary-foreground
/** The send button: tinted once there is something to send. */
export const chatComposerSendVariants = cva(
  "grid size-[32px] shrink-0 cursor-pointer place-items-center rounded-[9px] border-0 [transition:background-color_var(--duration-spring-snappy)_var(--ease-spring-snappy),scale_var(--duration-spring-snappy)_var(--ease-spring-snappy)] data-pressed:scale-[.94] motion-reduce:transition-none",
  {
    variants: {
      ready: {
        true: "bg-primary text-primary-foreground",
        false: "bg-secondary-strong text-secondary-foreground",
      },
    },
    defaultVariants: { ready: false },
  },
);
// ef:end

// ef:begin readiness passed in; keeps the chat-send evidence id
/** Sends the draft; tinted once there is something to send. */
// ef: readiness is passed in (the editor owns the draft) and the button keeps the `chat-send` evidence id.
export function ChatComposerSend({
  ready,
  className,
  ...props
}: React.ComponentProps<typeof Button> & { ready: boolean }) {
  return (
    <Button
      data-slot="chat-composer-send"
      data-testid="chat-send"
      data-ready={ready || undefined}
      aria-label="Send message"
      className={composeRenderProps(className, (c) => cn(chatComposerSendVariants({ ready }), c))}
      {...props}
    >
      <Icon name="arrow-up-compact" size={15} sw={2.2} />
    </Button>
  );
}
// ef:end

// ef: ChatComposerInput (plain Input) and ChatComposerAction (attach) are not installed.
