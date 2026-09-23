/**
 * Typing shim for `@brett_lamy/docstream-editor` 0.3.4. The package ships TypeScript
 * source with extensionless relative imports, which this repo's NodeNext typecheck
 * rejects, so tsconfig.base.json maps the specifier here. Vite maps the same
 * specifier to the package's `src/editor/Editor.tsx` (see apps/web/vite.config.ts) so
 * the chat composer never drags in the demo editors and their playground worker.
 */
declare module "@brett_lamy/docstream-editor" {
  import type { AnyExtension } from "@tiptap/core";
  import type { Editor } from "@tiptap/react";
  import type { ReactNode } from "react";

  export interface SlashItem {
    readonly title: string;
    readonly description?: string;
    readonly icon?: ReactNode;
    readonly keywords?: readonly string[];
  }

  export interface GitbookEditorProps {
    readonly markdown?: string;
    readonly onChange?: (markdown: string) => void;
    readonly toolbar?: boolean;
    readonly slashMenu?: boolean | { readonly items?: SlashItem[] };
    readonly editable?: boolean;
    readonly placeholder?: string;
    readonly className?: string;
    readonly autofocus?: boolean;
    readonly disableHistory?: boolean;
    readonly extensions?: AnyExtension[];
    readonly onEditorReady?: (editor: Editor | null) => void;
  }

  export function GitbookEditor(props: GitbookEditorProps): React.JSX.Element;
}

declare module "@brett_lamy/docstream-editor/convert" {
  /** ProseMirror JSON node as TipTap's `editor.getJSON()` returns it. */
  export interface PMNode {
    readonly type: string;
    readonly attrs?: Record<string, unknown>;
    readonly content?: PMNode[];
    readonly text?: string;
    readonly marks?: { readonly type: string; readonly attrs?: Record<string, unknown> }[];
  }
  export function astToTiptap(doc: unknown): PMNode;
  export function tiptapToAst(doc: PMNode): unknown;
}

declare module "@brett_lamy/docstream/gitbook" {
  export function parseMarkdown(markdown: string): unknown;
  export function serializeMarkdown(doc: unknown): string;
}
