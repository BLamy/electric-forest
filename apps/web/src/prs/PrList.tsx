import { useEffect, useMemo, useRef, useState } from "react";
import {
  Credenza,
  Icon,
  IndexBar,
  List,
  ListRow,
  ListSection,
  NavigationStack,
  SearchField,
  SideDrawer,
  SplitView,
  TabBar,
  TouchKitProvider,
} from "@brett_lamy/ui";
import { Check, ChevronDown, CircleDot, GitPullRequest, Menu, Plus, Search } from "lucide-react";
import type { PrIndexRow } from "@eforest/pr";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { RouteLink } from "../navigation.js";
import { RepoHeader, navigate, repoSectionPath, type RepoSection } from "./RepoChrome.js";
import {
  branchNameFromStream,
  branchRows,
  openedEvent,
  usePrCreator,
  usePrList,
  type PrListBinding,
} from "./usePrs.js";

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = (): void => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function detailPath(org: string, repo: string, prId: string): string {
  return `${repoSectionPath(org, repo, "pulls")}/${encodeURIComponent(prId)}`;
}

function ageLabel(row: PrIndexRow): string {
  return row.status === "merged" || row.status === "closed"
    ? "closed recently"
    : "updated just now";
}

function statusTone(status: string): string {
  return status === "merged" ? "merged" : status === "closed" ? "closed" : "open";
}

function CreatePrForm(props: {
  readonly org: string;
  readonly repo: string;
  readonly binding: PrListBinding;
  readonly onComplete?: () => void;
}): React.JSX.Element {
  const branches = branchRows(props.binding);
  const defaultSource =
    branches.find((branch) => branch.name !== "main")?.streamId ??
    branches[0]?.streamId ??
    `fs:${props.org}/${props.repo}:main:meta`;
  const [source, setSource] = useState(defaultSource);
  const [prId, setPrId] = useState(() => `pr-${Date.now().toString(36)}`);
  const [error, setError] = useState<string>();
  const dispatch = usePrCreator(props.org, props.repo, prId);
  const selected = branches.find((branch) => branch.streamId === source);
  return (
    <form
      className="pr-create-form selectable-content"
      aria-label="Create pull request"
      onSubmit={(event) => {
        event.preventDefault();
        setError(undefined);
        const form = new FormData(event.currentTarget);
        const target = String(
          form.get("target") ??
            branches.find((branch) => branch.name === "main")?.streamId ??
            `fs:${props.org}/${props.repo}:main:meta`,
        );
        const title = String(form.get("title") ?? "");
        const body = String(form.get("body") ?? "");
        const closes = String(form.get("closes") ?? "").split(",");
        void dispatch(
          openedEvent({
            org: props.org,
            repo: props.repo,
            sourceBranch: source,
            targetBranch: target,
            forkOffset: selected?.forkOffset ?? "-1",
            title,
            body,
            author: props.binding.actor,
            closes,
          }),
        ).then(
          () => {
            props.onComplete?.();
            navigate(detailPath(props.org, props.repo, prId));
            setPrId(`pr-${Date.now().toString(36)}`);
          },
          (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
        );
      }}
    >
      <div className="pr-form-grid">
        <label>
          Source branch
          <select name="source" value={source} onChange={(event) => setSource(event.target.value)}>
            {branches.map((branch) => (
              <option key={branch.streamId} value={branch.streamId}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target branch
          <select
            name="target"
            defaultValue={branches.find((branch) => branch.name === "main")?.streamId}
          >
            {branches.map((branch) => (
              <option key={branch.streamId} value={branch.streamId}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="pr-fork-note">
        Fork offset <code>{selected?.forkOffset ?? "waiting for branch catalog"}</code>
      </p>
      <label>
        Title
        <input name="title" required placeholder="Describe the change" />
      </label>
      <label>
        Description
        <textarea name="body" rows={5} placeholder="What does this pull request change?" />
      </label>
      <label>
        Closes issues
        <input name="closes" placeholder="issue-12, issue-19" />
      </label>
      {error === undefined ? null : (
        <p className="pr-inline-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={branches.length === 0}>
        Create pull request
      </Button>
    </form>
  );
}

function EmptyRows(props: {
  readonly status: string;
  readonly count: number;
}): React.JSX.Element | null {
  if (props.status === "loading") return <p className="pr-empty">Loading pull requests…</p>;
  if (props.status.startsWith("error:"))
    return (
      <p className="pr-inline-error" role="alert">
        Pull-request projection refused: {props.status.slice(6)}
      </p>
    );
  return props.count === 0 ? <p className="pr-empty">No pull requests match this view.</p> : null;
}

function DesktopPrList(props: {
  readonly org: string;
  readonly repo: string;
  readonly binding: PrListBinding;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const rows = props.binding.rows.filter((row) =>
    `${row.title} ${row.prId} ${row.author}`.toLowerCase().includes(query.toLowerCase()),
  );
  const openCount = props.binding.rows.filter(
    (row) => row.status !== "closed" && row.status !== "merged",
  ).length;
  const closedCount = props.binding.rows.length - openCount;
  return (
    <section
      className="pr-app pr-list-page"
      data-testid="pr-list"
      data-ef-stream={props.binding.streamId}
      data-ef-offset={props.binding.projection.checkpoint}
      data-ef-digest={props.binding.projection.digest}
      data-ef-reducer={props.binding.reducerId}
      data-stream-status={props.binding.projection.status}
    >
      <RepoHeader org={props.org} repo={props.repo} active="pulls" />
      <div className="pr-page-width">
        <div className="pr-list-toolbar">
          <div className="pr-search-wrap">
            <Search size={17} aria-hidden="true" />
            <input
              aria-label="Find pull request"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a pull request…"
            />
          </div>
          <Button variant="secondary">
            <Plus size={16} /> Automation
          </Button>
          <Button onClick={() => setCreating((value) => !value)}>
            <Plus size={17} /> New Pull Request
          </Button>
        </div>
        {creating ? (
          <Card className="pr-create-card">
            <CreatePrForm
              org={props.org}
              repo={props.repo}
              binding={props.binding}
              onComplete={() => setCreating(false)}
            />
          </Card>
        ) : null}
        <Card className="pr-list-card">
          <div className="pr-list-filters">
            <div>
              <button type="button" className="pr-count-active">
                Open {openCount}
              </button>
              <button type="button">Closed {closedCount}</button>
            </div>
            <div>
              {["Authors", "Label", "Milestones", "Reviews", "Assignee", "Sort"].map((label) => (
                <button type="button" key={label}>
                  {label}
                  <ChevronDown size={14} />
                </button>
              ))}
            </div>
          </div>
          <EmptyRows status={props.binding.projection.status} count={rows.length} />
          <ul className="pr-list-rows" aria-label="Pull requests">
            {rows.map((row) => (
              <li
                key={row.prStream}
                data-testid="pr-row"
                data-pr-id={row.prId}
                data-pr-status={row.status}
              >
                <GitPullRequest
                  className={`pr-row-icon pr-row-icon-${statusTone(row.status)}`}
                  size={21}
                  aria-hidden="true"
                />
                <div className="pr-row-main">
                  <RouteLink href={detailPath(props.org, props.repo, row.prId)}>
                    {row.title}
                  </RouteLink>
                  <p>
                    #{row.prId} {ageLabel(row)} by {row.author}
                  </p>
                  <div>
                    <Badge>{branchNameFromStream(row.sourceBranch)}</Badge>
                    <span aria-hidden="true">←</span>
                    <Badge>{branchNameFromStream(row.targetBranch)}</Badge>
                  </div>
                </div>
                <div className="pr-row-meta">
                  <span>
                    <CircleDot size={14} /> {row.status}
                  </span>
                  <span>
                    <Check size={14} /> {row.headOffset}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </section>
  );
}

function MobileRepoDrawer(props: {
  readonly org: string;
  readonly repo: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly restore: React.RefObject<HTMLButtonElement | null>;
}): React.JSX.Element {
  const sections: readonly { id: RepoSection; label: string }[] = [
    { id: "code", label: "Code" },
    { id: "pulls", label: "Pull Requests" },
    { id: "issues", label: "Issues" },
    { id: "wiki", label: "Wiki" },
    { id: "settings", label: "Settings" },
  ];
  useEffect(() => {
    if (!props.open) props.restore.current?.focus();
  }, [props.open, props.restore]);
  return (
    <SideDrawer
      mode="overlay"
      open={props.open}
      onClose={props.onClose}
      title={`${props.org} / ${props.repo}`}
    >
      <nav className="mobile-repo-links" aria-label="Repository sections">
        {sections.map((section) => (
          <button
            type="button"
            key={section.id}
            onClick={() => {
              props.onClose();
              navigate(repoSectionPath(props.org, props.repo, section.id));
            }}
          >
            {section.label}
          </button>
        ))}
      </nav>
    </SideDrawer>
  );
}

function MobilePrList(props: {
  readonly org: string;
  readonly repo: string;
  readonly binding: PrListBinding;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [creating, setCreating] = useState(false);
  const tablet = useMedia("(min-width: 620px)");
  const menuRef = useRef<HTMLButtonElement>(null);
  const rows = useMemo(
    () =>
      props.binding.rows.filter((row) =>
        `${row.title} ${row.prId}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [props.binding.rows, query],
  );
  const list = (
    <div
      className="mobile-pr-master selectable-content"
      data-testid="pr-list"
      data-ef-stream={props.binding.streamId}
      data-ef-offset={props.binding.projection.checkpoint}
      data-ef-digest={props.binding.projection.digest}
      data-ef-reducer={props.binding.reducerId}
      data-stream-status={props.binding.projection.status}
    >
      <SearchField q={query} setQ={setQuery} placeholder="Find pull request" />
      <List inset>
        <ListSection title={`${String(rows.length)} pull requests`}>
          {rows.map((row) => (
            <div id={`mobile-pr-${row.prId}`} key={row.prStream}>
              <ListRow
                rowRole="link"
                leading={<Icon name="layers" />}
                title={row.title}
                subtitle={`#${row.prId} · ${row.status} · ${branchNameFromStream(row.sourceBranch)} → ${branchNameFromStream(row.targetBranch)}`}
                trailing={row.author}
                accessory="chevron"
                onPress={() => navigate(detailPath(props.org, props.repo, row.prId))}
              />
            </div>
          ))}
        </ListSection>
      </List>
      <EmptyRows status={props.binding.projection.status} count={rows.length} />
      <IndexBar
        items={rows.map((row) => ({
          key: row.prId,
          label: row.title.slice(0, 1).toUpperCase(),
          caption: row.status,
          preview: <span>{row.title}</span>,
        }))}
        label="Jump to pull request"
        onJump={(prId: string) =>
          document.getElementById(`mobile-pr-${prId}`)?.scrollIntoView({ block: "center" })
        }
      />
    </div>
  );
  const screen = {
    key: "pulls",
    title: "Pull Requests",
    largeTitle: true,
    leading: (
      <button
        ref={menuRef}
        type="button"
        className="mobile-icon-button"
        aria-label="Open repository navigation"
        aria-expanded={drawer}
        onClick={() => setDrawer(true)}
      >
        <Menu size={22} />
      </button>
    ),
    trailing: (
      <button type="button" className="mobile-new-button" onClick={() => setCreating(true)}>
        <Plus size={18} /> New
      </button>
    ),
    content: list,
    bottomInset: 78,
  };
  return (
    <TouchKitProvider dark tint="#3fb878" className="mobile-pr-shell">
      <SplitView
        wc={tablet ? "regular" : "compact"}
        sidebar={<div />}
        master={<NavigationStack screens={[screen]} />}
        detail={
          <div className="mobile-detail-hint">
            <GitPullRequest size={32} />
            <h2>Select a pull request</h2>
            <p>Review activity, checks, and changes.</p>
          </div>
        }
      />
      <MobileRepoDrawer
        org={props.org}
        repo={props.repo}
        open={drawer}
        onClose={() => setDrawer(false)}
        restore={menuRef}
      />
      <Credenza open={creating} onClose={() => setCreating(false)} title="New pull request" compact>
        <CreatePrForm
          org={props.org}
          repo={props.repo}
          binding={props.binding}
          onComplete={() => setCreating(false)}
        />
      </Credenza>
      <TabBar
        items={[
          { id: "code", title: "Code", icon: "layers" },
          { id: "pulls", title: "Pulls", icon: "message" },
          { id: "issues", title: "Issues", icon: "info" },
          { id: "wiki", title: "Wiki", icon: "star" },
          { id: "settings", title: "Settings", icon: "sliders" },
        ]}
        selected="pulls"
        onSelect={(id: string) =>
          navigate(repoSectionPath(props.org, props.repo, id as RepoSection))
        }
      />
    </TouchKitProvider>
  );
}

export function PrListPage(props: {
  readonly org: string;
  readonly repo: string;
}): React.JSX.Element {
  const binding = usePrList(props.org, props.repo);
  const compact = useMedia("(max-width: 767px)");
  return compact ? (
    <MobilePrList {...props} binding={binding} />
  ) : (
    <DesktopPrList {...props} binding={binding} />
  );
}
