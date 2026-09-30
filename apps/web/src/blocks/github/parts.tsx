/* Provenance: registry/blocks/github-clone/parts.tsx — @brett_lamy/ui 2.0.0 registry block
   "github-clone" (https://blamy.github.io/ui/r/github-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
/* Small GitHub-flavoured pieces the page composes: the palette, octicon-style glyphs, label chips, state icons,
   underline tabs, a line-numbered code view, a unified diff view and a file tree. Code is highlighted by the
   library's SyntaxHighlighting (gpu-lexer on WebGPU), recolored with Primer's syntax palette below. */
// ef: the code view, unified diff and file tree are not installed: code renders through the app's
// gpu-lexer view (code-tab.tsx), diffs through @pierre/diffs and trees through @pierre/trees (the
// kept foundations); Markdown only through components/markdown/Markdown.tsx (Docstream adapter).
// ef:begin no Primer palette, code view, diff view or file tree dependencies
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import {
  Avatar,
  Icon,
  TabViewIndicator,
  TabViewPanel,
  TabViewTab,
  cn,
  type IconName,
} from "@brett_lamy/ui";
// ef:end

/* ── Palette ──
   ef: the Primer palette object (PRIMER / primerVars / GITHUB_THEME / GITHUB_TINT) is not installed. The
   block renders inside the Electric Forest frame, so its shadcn variables and the --gh-* extras are the
   forest palette defined once in styles/app.css (:root), where contrast is measured. */

/* ── Octicon-style glyphs (16px grid, drawn for this block) ──
   GitHub's domain marks (repo, branch, PR, issue, CI states…) are drawn here; generic UI glyphs come from the
   library's Icon (regular weight at 1.25× lands on the octicons' 1.5px stroke). */
const GENERIC = {
  check: "check",
  x: "xmark",
  chevDown: "chevron-down",
  chevRight: "chevron-right",
  chevLeft: "chevron-left",
  search: "magnifyingglass",
  plus: "plus",
  bell: "bell",
  menu: "menu",
  link: "link",
  gear: "gear",
  copy: "copy",
  kebab: "ellipsis",
  sidebar: "sidebar",
  star: "star",
} as const satisfies Record<string, IconName>;
const OCT: Record<string, ReactNode> = {
  code: <path d="M5.2 4.2 1.5 8l3.7 3.8M10.8 4.2 14.5 8l-3.7 3.8" />,
  issue: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  issueClosed: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="m5.4 8.2 1.8 1.8 3.4-3.6" />
    </>
  ),
  pr: (
    <>
      <circle cx="4" cy="3.5" r="1.7" />
      <circle cx="4" cy="12.5" r="1.7" />
      <circle cx="12" cy="12.5" r="1.7" />
      <path d="M4 5.2v5.6M12 10.8V6.5A2.2 2.2 0 0 0 9.8 4.3H7.4M8.9 2.6 7.2 4.3 8.9 6" />
    </>
  ),
  prDraft: (
    <>
      <circle cx="4" cy="3.5" r="1.7" />
      <circle cx="4" cy="12.5" r="1.7" />
      <circle cx="12" cy="12.5" r="1.7" />
      <path d="M4 5.2v5.6M12 3.2v.4M12 6.4v.4M12 9.4v.4" />
    </>
  ),
  merged: (
    <>
      <circle cx="4" cy="3.5" r="1.7" />
      <circle cx="4" cy="12.5" r="1.7" />
      <circle cx="12" cy="8.5" r="1.7" />
      <path d="M4 5.2v5.6M4 5.2c0 2.2 1.6 3.3 3.6 3.3h2.7" />
    </>
  ),
  prClosed: (
    <>
      <circle cx="4" cy="3.5" r="1.7" />
      <circle cx="4" cy="12.5" r="1.7" />
      <circle cx="12" cy="12.5" r="1.7" />
      <path d="M4 5.2v5.6M12 10.8V7.6M10.4 2.2l3.2 3.2M13.6 2.2l-3.2 3.2" />
    </>
  ),
  play: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M6.6 5.4v5.2L10.6 8z" fill="currentColor" />
    </>
  ),
  eye: (
    <>
      <path d="M1.2 8S3.6 3.3 8 3.3 14.8 8 14.8 8 12.4 12.7 8 12.7 1.2 8 1.2 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  fork: (
    <>
      <circle cx="4" cy="3" r="1.6" />
      <circle cx="12" cy="3" r="1.6" />
      <circle cx="8" cy="13" r="1.6" />
      <path d="M4 4.6v.9A1.8 1.8 0 0 0 5.8 7.3h4.4A1.8 1.8 0 0 0 12 5.5v-.9M8 7.3v4.1" />
    </>
  ),
  book: (
    <path d="M1.8 2.8h3.7A2.5 2.5 0 0 1 8 5.3v8.2a2 2 0 0 0-2-2H1.8zM14.2 2.8h-3.7A2.5 2.5 0 0 0 8 5.3v8.2a2 2 0 0 1 2-2h4.2z" />
  ),
  file: (
    <>
      <path d="M3.5 1.8h5.8l3.2 3.2v9.2h-9z" />
      <path d="M9.2 1.8v3.3h3.3" />
    </>
  ),
  folder: (
    <path
      d="M1.5 3.2c0-.5.4-.9.9-.9h3.7l1.5 1.8h6c.5 0 .9.4.9.9v7.8c0 .5-.4.9-.9.9H2.4a.9.9 0 0 1-.9-.9z"
      fill="currentColor"
      stroke="none"
    />
  ),
  branch: (
    <>
      <circle cx="4.5" cy="3.2" r="1.6" />
      <circle cx="4.5" cy="12.8" r="1.6" />
      <circle cx="11.5" cy="4.5" r="1.6" />
      <path d="M4.5 4.8v6.4M11.5 6.1c0 2.7-2.4 3-5 3.6a3 3 0 0 0-2 1.5" />
    </>
  ),
  tag: (
    <>
      <path d="M1.8 2.6v4.8l6.9 6.9 5.6-5.6-6.9-6.9H2.6z" />
      <circle cx="5" cy="5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  history: (
    <>
      <path d="M2.2 8a5.8 5.8 0 1 0 1.7-4.1L2.2 5.6M2.2 2.2v3.4h3.4" />
      <path d="M8 5v3.3l2.2 1.4" />
    </>
  ),
  comment: (
    <path d="M2.3 3.3c0-.6.5-1 1-1h9.4c.6 0 1 .4 1 1v6.4c0 .6-.4 1-1 1H7.4L4.3 13.5v-2.8h-1c-.5 0-1-.4-1-1z" />
  ),
  checkFill: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
      <path d="m4.9 8.2 2.1 2.1 4.1-4.3" stroke="var(--background)" strokeWidth="1.7" />
    </>
  ),
  xFill: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
      <path d="m5.6 5.6 4.8 4.8m0-4.8-4.8 4.8" stroke="var(--background)" strokeWidth="1.7" />
    </>
  ),
  stopFill: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" stroke="none" />
      <path d="M5.3 8h5.4" stroke="var(--background)" strokeWidth="1.7" />
    </>
  ),
  dotFill: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  law: (
    <path d="M8 1.8v12.4M3.5 14.2h9M2 4.2h12M4 4.2 1.8 9.3a2.2 2.2 0 0 0 4.4 0zM12 4.2l-2.2 5.1a2.2 2.2 0 0 0 4.4 0z" />
  ),
  pulse: <path d="M1.2 8h3l1.8-4.5 3.4 9 1.8-4.5h3.6" />,
  commit: (
    <>
      <circle cx="8" cy="8" r="2.6" />
      <path d="M1 8h4.4M10.6 8H15" />
    </>
  ),
  desktop: (
    <>
      <rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.2" />
      <path d="M5.5 13.8h5M8 11v2.8" />
    </>
  ),
  zip: (
    <>
      <path d="M3.5 1.8h5.8l3.2 3.2v9.2h-9z" />
      <path d="M7 3v1.2M7 5.4v1.2M7 7.8V9" />
    </>
  ),
  eyeClosed: (
    <path d="M1.8 6.2S4 9.8 8 9.8s6.2-3.6 6.2-3.6M3.8 8.5l-1.2 1.8M12.2 8.5l1.2 1.8M8 9.8v2" />
  ),
  shield: <path d="M8 1.5 2.8 3.4v4c0 3.2 2.2 5.8 5.2 7.1 3-1.3 5.2-3.9 5.2-7.1v-4z" />,
  people: (
    <>
      <circle cx="5.8" cy="5.2" r="2.3" />
      <path d="M1.6 13.3a4.2 4.2 0 0 1 8.4 0M10.8 3.2a2.2 2.2 0 0 1 0 4.2M12 9.4a3.6 3.6 0 0 1 2.4 3.4" />
    </>
  ),
  inbox: (
    <path d="M1.8 9.2 3.6 3.3c.1-.4.5-.8 1-.8h6.8c.5 0 .9.4 1 .8l1.8 5.9v3.3c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1zM1.8 9.2h3.6l1 1.8h3.2l1-1.8h3.6" />
  ),
  // ef: glyphs for the forest's extra repository surfaces (wiki, stream inspector).
  wiki: (
    <>
      <path d="M2.5 2.5h8l3 3v8h-11z" />
      <path d="M5 7h6M5 9.5h6M5 12h3.5" />
    </>
  ),
  stream: <path d="M1.5 5c2-2 4-2 6.5 0s4.5 2 6.5 0M1.5 11c2-2 4-2 6.5 0s4.5 2 6.5 0" />,
};
export type OctName = keyof typeof OCT | keyof typeof GENERIC;

export function Oct({
  name,
  size = 16,
  className,
  style,
}: {
  name: OctName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  // Icon's 24px grid pads its glyphs more than the 16px octicons: draw 25% larger inside the same box.
  if (name in GENERIC)
    return (
      <Icon
        name={GENERIC[name as keyof typeof GENERIC]}
        size={size * 1.25}
        className={cn("inline-block", className)}
        style={{ margin: size * -0.125, ...style }}
      />
    );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("inline-block shrink-0", className)}
      style={style}
    >
      {OCT[name]}
    </svg>
  );
}

// ef:begin the Electric Forest mark
/** ef: the Electric Forest mark (the block ships a stand-in for the host's logo). */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      className="shrink-0 text-primary"
    >
      <circle cx="16" cy="16" r="15" fill="currentColor" />
      <path d="M16 6 9 17h4.5L10 24h12l-3.5-7H23z" fill="var(--background)" />
      <path d="M15 24h2v3h-2z" fill="var(--background)" />
    </svg>
  );
}
// ef:end

/* ── Label chip ── light: the label color as a fill; dark: a tinted chip with a lighter label, like GitHub. */
function rgb(hex: string) {
  // ef: labels are user-authored on the label stream; a malformed color falls back to gray.
  const n = /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : 0x8b949e;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
}
/** ef: a label as the label stream projects it (name + color); the block's mock `Label` type is gone. */
export interface ChipLabel {
  readonly name: string;
  readonly color: string;
}
// ef:begin labels from the label stream (name + color)
export function LabelChip({
  label,
  dark = true,
  className,
}: {
  label: ChipLabel;
  dark?: boolean;
  className?: string;
}) {
  const [r, g, b] = rgb(label.color);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const lift = (v: number) => Math.round(v + (255 - v) * (lum < 0.5 ? 0.45 : 0.15));
  const style: CSSProperties = dark
    ? {
        background: `rgba(${r},${g},${b},.18)`,
        color: `rgb(${lift(r)},${lift(g)},${lift(b)})`,
        boxShadow: `inset 0 0 0 1px rgba(${r},${g},${b},.4)`,
      }
    : { background: label.color };
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-[7px] text-[12px] leading-none font-medium whitespace-nowrap",
        !dark && (lum > 0.6 ? "text-(--gh-ink)" : "text-white"),
        className,
      )}
      style={style}
    >
      {label.name}
    </span>
  );
}
// ef:end

/* ── Issue / PR state glyphs and pills ── */
/* icon, glyph color, pill fill (open states use the merge-button green, draft a fixed gray). */
const STATE = {
  open: { icon: "issue", text: "text-(--gh-open)", pill: "bg-(--gh-merge)", label: "Open" },
  closed: {
    icon: "issueClosed",
    text: "text-(--gh-done)",
    pill: "bg-(--gh-done)",
    label: "Closed",
  },
  prOpen: { icon: "pr", text: "text-(--gh-open)", pill: "bg-(--gh-merge)", label: "Open" },
  merged: { icon: "merged", text: "text-(--gh-done)", pill: "bg-(--gh-done)", label: "Merged" },
  prClosed: {
    icon: "prClosed",
    text: "text-(--gh-closed)",
    pill: "bg-(--gh-closed)",
    label: "Closed",
  },
  draft: {
    icon: "prDraft",
    text: "text-muted-foreground",
    pill: "bg-(--gh-draft)",
    label: "Draft",
  },
  // ef: the PR stream's review states (approved, conflicted) as their own pills.
  approved: { icon: "pr", text: "text-(--gh-open)", pill: "bg-(--gh-merge)", label: "Approved" },
  conflicted: {
    icon: "prClosed",
    text: "text-(--gh-attention)",
    pill: "bg-(--gh-attention)",
    label: "Conflicted",
  },
} satisfies Record<string, { icon: OctName; text: string; pill: string; label: string }>;
export type StateKind = keyof typeof STATE;

export function StateIcon({ state, className }: { state: StateKind; className?: string }) {
  const s = STATE[state];
  return <Oct name={s.icon} className={cn(s.text, className)} />;
}

export function StatePill({ state }: { state: StateKind }) {
  const s = STATE[state];
  return (
    // ef: dark ink on every pill fill keeps text contrast ≥ 4.5:1 on the forest palette.
    <span
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[14px] font-medium text-(--gh-ink)",
        s.pill,
      )}
    >
      <Oct name={s.icon} />
      {s.label}
    </span>
  );
}

/** A small gray count bubble (tab counts, button counts). */
export function Counter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-secondary-strong px-1.5 text-[12px] leading-none font-medium text-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** ef: a participant as the streams know them — an actor id rendered as initials. */
export interface User {
  readonly login: string;
  readonly f: string;
  readonly l: string;
}

/** ef: derive the avatar identity from a stream actor (email, `auth0|…` subject, agent handle). */
export function userOf(actor: string): User {
  const login = actor.replace(/^auth0\|/, "").replace(/^agent:/, "");
  const cleaned = login
    .replace(/@.*$/, "")
    .replace(/[._|-]+/g, " ")
    .trim();
  const [first = "?", ...rest] = cleaned.split(/\s+/);
  return { login, f: first, l: rest.at(-1) ?? "" };
}

// ef:begin participants derived from stream actors
/** Overlapping avatars (assignees, contributors). */
export function AvatarStack({ users, size = 20 }: { users: readonly User[]; size?: number }) {
  return (
    <span className="flex">
      {users.map((u, i) => (
        <Avatar
          key={u.login}
          c={u}
          size={size}
          className="ring-2 ring-background"
          style={{ marginLeft: i ? -size / 3 : 0 }}
        />
      ))}
    </span>
  );
}
// ef:end

/* ── Underline tabs ── a TabViewTab styled as GitHub's UnderlineNav: icon, label, count, coral underline. */
export function UnderlineTab({
  id,
  icon,
  label,
  count,
}: {
  id: string;
  icon?: OctName;
  label: string;
  count?: ReactNode;
}) {
  return (
    <TabViewTab
      id={id}
      textValue={label}
      className="group relative flex shrink-0 items-center py-2 outline-none data-selected:font-semibold"
    >
      {/* ef: the theme --ring stays at 2px so keyboard focus is always visible. */}
      <span className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[14px] leading-5 text-foreground group-data-hovered:bg-secondary group-data-focus-visible:ring-2 group-data-focus-visible:ring-ring">
        {icon ? <Oct name={icon} className="text-muted-foreground" /> : null}
        <span className="whitespace-nowrap">{label}</span>
        {count != null ? <Counter>{count}</Counter> : null}
      </span>
      <TabViewIndicator className="inset-x-1 -bottom-px z-1 h-0.5 rounded-full bg-[var(--gh-tab)]" />
    </TabViewTab>
  );
}

/** A tab panel that flows with the page (TabViewPanel is absolutely positioned by default). */
export function FlowPanel({
  id,
  className,
  children,
}: {
  id: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <TabViewPanel
      id={id}
      className={cn("relative inset-auto overflow-visible data-exiting:hidden", className)}
    >
      {children}
    </TabViewPanel>
  );
}

// ef:begin passes through evidence attributes
/** GitHub's bordered "Box": rounded, 1px border, optional header row. */
export function Box({
  header,
  children,
  className,
  ...props
}: {
  header?: ReactNode;
  children?: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLElement>, "children">) {
  // ef: extra attributes pass through so evidence surfaces keep their data-testid / data-ef-*.
  return (
    <section
      className={cn("overflow-hidden rounded-md border border-border bg-background", className)}
      {...props}
    >
      {header ? (
        <div className="flex min-h-[46px] items-center gap-2 border-b border-border bg-muted px-4 py-2 text-[14px]">
          {header}
        </div>
      ) : null}
      {children}
    </section>
  );
}
// ef:end

/** Class string for GitHub's default (gray) button; add `primary` for the blue action. */
export const ghButton = (primary?: boolean) =>
  cn(
    "inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md border px-3 text-[14px] font-medium outline-none whitespace-nowrap",
    "focus-visible:ring-2 focus-visible:ring-ring data-focus-visible:ring-2 data-focus-visible:ring-ring data-focus-visible:ring-offset-1",
    // ef: native disabled buttons (dispatch in flight) dim like react-aria's data-disabled.
    "disabled:cursor-not-allowed disabled:opacity-50 data-disabled:cursor-not-allowed data-disabled:opacity-50",
    primary
      ? // ef: blue primary keeps routine actions distinct from green merge/success states.
        "border-transparent bg-primary text-primary-foreground hover:bg-(--gh-primary-hover) data-hovered:bg-(--gh-primary-hover)"
      : "border-border bg-(--gh-btn) text-foreground hover:bg-(--gh-btn-hover) data-hovered:bg-(--gh-btn-hover)",
  );

/** ef: native form controls in the block's look (the dispatch forms keep real inputs/selects). */
export const ghField =
  "h-8 min-w-0 rounded-md border border-border bg-muted px-2 text-[14px] text-foreground placeholder:text-tertiary-foreground focus-visible:outline-2 focus-visible:outline-ring";
/** ef: multi-line native textarea in the block's look. */
export const ghTextarea =
  "min-h-24 w-full rounded-md border border-border bg-muted px-3 py-2 text-[14px] leading-5 text-foreground placeholder:text-tertiary-foreground focus-visible:outline-2 focus-visible:outline-ring";

/** Markdown overrides for GitHub's markdown look. Docstream's sheet is unlayered, so these need `!`. */
// ef: applied to the app's Docstream adapter (components/markdown/Markdown.tsx), never to MarkdownView.
export const githubMarkdown = cn(
  "text-foreground [&_[data-docstream-blocks]>:first-child]:mt-0! [&_[data-docstream-blocks]>:last-child]:mb-0!",
  "[&_h1]:mt-0! [&_h1]:mb-4! [&_h1]:border-b [&_h1]:border-border [&_h1]:pb-2! [&_h1]:text-[32px]! [&_h1]:font-semibold!",
  "[&_h2]:mt-6! [&_h2]:mb-4! [&_h2]:pb-2! [&_h2]:text-[24px]! [&_h2]:font-semibold!",
  "[&_li]:my-1! [&_pre]:rounded-md!",
);

/* ── Diffstat ──
   ef: `parsePatch` / `DiffView` (a hand-rolled unified diff) and `DiffStat` are not installed; the Changes
   tab renders @pierre/diffs, which reports exact per-file +/− counts from the digest-admitted bytes. */

/* ── Shared screen types ── */

/** Width class the screens adapt to (measured from the block's own box). */
export interface Layout {
  phone: boolean;
  wide: boolean;
  dark: boolean;
}

/** ef: width classes measured from the frame's main column (the chat rail and sidebar take the rest). */
export function layoutFor(width: number): Layout {
  return { phone: width < 640, wide: width >= 960, dark: true };
}

// ef:begin PR stream statuses mapped to the state glyphs
/** ef: the PR index/stream statuses mapped to the block's state glyphs. */
export const PR_STATE: Record<string, StateKind> = {
  open: "prOpen",
  approved: "approved",
  conflicted: "conflicted",
  merged: "merged",
  closed: "prClosed",
  draft: "draft",
};
// ef:end

/** A branch name chip. */
// ef:begin the tint is an rgba token, not an alpha utility: Tailwind's color-mix() fallback for
// older engines (Replay Chromium 108 records the evidence) is the opaque primary, hiding the name.
export function Branch({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-(--ef-primary-wash-10) px-1.5 py-0.5 font-mono text-[12px] text-primary">
      {children}
    </span>
  );
}
// ef:end
