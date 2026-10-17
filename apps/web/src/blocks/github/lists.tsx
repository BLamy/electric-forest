/* Provenance: registry/blocks/github-clone/lists.tsx — @brett_lamy/ui 2.0.0 registry block
   "github-clone" (https://blamy.github.io/ui/r/github-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
/* Shared pieces of the Issues and Pull requests lists: search toolbar, Open/Closed toggle, filter menus, rows. */
// ef:begin route links and the live types rows render
import type { ReactNode } from "react";
import { Button, SearchField, cn } from "@brett_lamy/ui";
import { RouteLink } from "../../navigation.js";
import {
  AvatarStack,
  Counter,
  LabelChip,
  Oct,
  StateIcon,
  ghButton,
  type ChipLabel,
  type OctName,
  type StateKind,
  type Layout,
  type User,
} from "./parts.js";
// ef:end

// ef:begin labels link to label management; New opens the dispatch form
// ef: the toolbar's Labels button counts the live label catalog and links to label management;
// the New button opens the page's own dispatch form (no mock LABELS, no Milestones stream).
export function ListToolbar({
  ui,
  q,
  setQ,
  placeholder,
  newLabel,
  onNew,
  labelsHref,
  labelCount,
  searchLabel = "Search",
}: {
  ui: Layout;
  q: string;
  setQ: (q: string) => void;
  placeholder: string;
  newLabel: string;
  onNew: () => void;
  labelsHref?: string;
  labelCount?: number;
  searchLabel?: string;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <SearchField
        value={q}
        onChange={setQ}
        placeholder={placeholder}
        aria-label={searchLabel}
        className="h-8 min-w-[200px] flex-1 rounded-md border border-border bg-muted px-2 py-0 text-[14px] [&_input]:text-[14px] [&_svg]:size-4"
      />
      {labelsHref === undefined ? null : (
        <RouteLink
          href={labelsHref}
          className={cn(ghButton(), "text-foreground hover:no-underline")}
        >
          <Oct name="tag" className="text-muted-foreground" />
          Labels
          {!ui.phone && labelCount !== undefined ? <Counter>{labelCount}</Counter> : null}
        </RouteLink>
      )}
      <Button className={ghButton(true)} onPress={onNew}>
        {newLabel}
      </Button>
    </div>
  );
}
// ef:end

export function StateToggle({
  value,
  onChange,
  open,
  closed,
  closedIcon,
}: {
  value: "open" | "closed";
  onChange: (v: "open" | "closed") => void;
  open: number;
  closed: number;
  closedIcon: OctName;
}) {
  const item = (v: "open" | "closed", icon: OctName, n: number, label: string) => (
    <button
      type="button"
      onClick={() => onChange(v)}
      aria-pressed={value === v}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-2 py-1 text-[14px] hover:bg-secondary",
        value === v ? "font-semibold text-foreground" : "text-muted-foreground",
      )}
    >
      <Oct name={icon} />
      {n} {label}
    </button>
  );
  return (
    <div className="flex items-center gap-1">
      {item("open", "issue", open, "Open")}
      {item("closed", closedIcon, closed, "Closed")}
    </div>
  );
}

// ef: FilterMenus (Author / Projects / Milestones / … dropdowns over mock data) is not installed; the
// lists filter by the live label catalog and the search field only.

// ef:begin rows are route links carrying evidence attributes
export function ItemRow({
  ui,
  state,
  title,
  href,
  labels,
  meta,
  assignees,
  comments,
  status,
  onOpen,
  rowProps,
}: {
  ui: Layout;
  state: StateKind;
  title: string;
  // ef: rows are links to their routes (the block opened them through page state).
  href: string;
  labels: readonly ChipLabel[];
  meta: ReactNode;
  assignees: readonly User[];
  comments: number;
  status?: ReactNode;
  onOpen?: () => void;
  // ef: evidence attributes (data-testid, data-pr-id, …) land on the row element.
  rowProps?: Record<string, string | undefined>;
}) {
  return (
    <li
      {...rowProps}
      className="flex gap-2 border-t border-border px-4 py-2 first:border-t-0 hover:bg-muted"
    >
      <StateIcon state={state} className="mt-[3px]" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <RouteLink
            href={href}
            {...(onOpen === undefined ? {} : { onNavigate: onOpen })}
            className="text-left text-[16px] leading-6 font-semibold text-foreground hover:text-link hover:no-underline"
          >
            {title}
          </RouteLink>
          {status}
          {labels.map((l) => (
            <LabelChip key={l.name} label={l} dark={ui.dark} />
          ))}
        </div>
        <div className="mt-1 text-[12px] text-muted-foreground">{meta}</div>
      </div>
      {!ui.phone ? (
        <div className="flex w-[120px] shrink-0 items-start justify-end gap-4 pt-1">
          {assignees.length ? <AvatarStack users={assignees} /> : null}
          {comments ? (
            <span className="flex items-center gap-1 text-[12px] text-muted-foreground">
              <Oct name="comment" />
              {comments}
            </span>
          ) : null}
        </div>
      ) : comments ? (
        <span className="flex shrink-0 items-center gap-1 pt-1 text-[12px] text-muted-foreground">
          <Oct name="comment" size={14} />
          {comments}
        </span>
      ) : null}
    </li>
  );
}
// ef:end
