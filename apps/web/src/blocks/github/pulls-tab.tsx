/* Provenance: registry/blocks/github-clone/pulls-tab.tsx — @brett_lamy/ui 2.0.0 registry block
   "github-clone" (https://blamy.github.io/ui/r/github-clone.json), installed as owned source.
   Every divergence from the upstream file carries an `ef:` marker. */
/* Pull requests tab: the PR list with check status and review state. */
// ef: rows are the live PR index projection (usePrList → pr-index reducer); the block's mock pull list and counts are gone.
import { useEffect, useState } from "react";
import type { PrIndexRow } from "@eforest/pr";
import { AppSheet } from "../../components/overlay.js";
import { navigate, repoLabelsPath, repoSectionPath } from "../../navigation.js";
import { preloadPrDetail } from "../../prs/preload.js";
import {
  branchNameFromStream,
  branchRows,
  openedEvent,
  usePrCreator,
  usePrList,
  type PrListBinding,
} from "../../prs/usePrs.js";
import {
  Box,
  Branch,
  Oct,
  PR_STATE,
  ghButton,
  ghField,
  ghTextarea,
  userOf,
  type Layout,
} from "./parts.js";
import { ItemRow, ListToolbar, StateToggle } from "./lists.js";

// ef: check glyphs follow the stream's review state (approved / conflicted / open), not a mock CI run.
export const CHECK_ICON: Record<string, React.JSX.Element> = {
  approved: <Oct name="check" className="text-[var(--gh-open)]" />,
  conflicted: <Oct name="x" className="text-[var(--gh-closed)]" />,
  open: <span className="mx-1 size-2 rounded-full bg-[var(--gh-attention)]" />,
};
// ef:begin review text for the stream statuses
export const REVIEW_TEXT: Record<string, string> = {
  approved: "Approved",
  conflicted: "Merge conflicts",
  open: "Review required",
  merged: "Merged",
  closed: "Closed",
};
// ef:end

function detailPath(org: string, repo: string, prId: string): string {
  return `${repoSectionPath(org, repo, "pulls")}/${encodeURIComponent(prId)}`;
}

function isClosed(row: PrIndexRow): boolean {
  return row.status === "merged" || row.status === "closed";
}

// ef:begin live PR index projection and the pr.opened dispatch form
// ef: the list is the live pull-request index; the toolbar opens the `pr.opened` dispatch form.
export function PullList({ ui, org, repo }: { ui: Layout; org: string; repo: string }) {
  const binding = usePrList(org, repo);
  const [state, setState] = useState<"open" | "closed">("open");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  // A PR list is one click from a PR detail: start loading its diff chunk now.
  useEffect(() => preloadPrDetail(), []);
  const all = binding.rows;
  const open = all.filter((p) => !isClosed(p)).length;
  const rows = all
    .filter((p) => (state === "open" ? !isClosed(p) : isClosed(p)))
    .filter(
      (p) => !q || `${p.title} ${p.prId} ${p.author}`.toLowerCase().includes(q.toLowerCase()),
    );
  const status = binding.projection.status;
  return (
    <section
      data-testid="pr-list"
      data-ef-stream={binding.streamId}
      data-ef-offset={binding.projection.checkpoint}
      data-ef-digest={binding.projection.digest}
      data-ef-reducer={binding.reducerId}
      data-stream-status={status}
      className={ui.phone ? "px-4 py-4" : undefined}
    >
      <ListToolbar
        ui={ui}
        q={q}
        setQ={setQ}
        placeholder={`is:pr state:${state}`}
        searchLabel="Find pull request"
        newLabel="New pull request"
        onNew={() => setCreating(true)}
        labelsHref={repoLabelsPath(org, repo)}
      />
      <Box
        header={
          <StateToggle
            value={state}
            onChange={setState}
            open={open}
            closed={all.length - open}
            closedIcon="check"
          />
        }
      >
        {status === "loading" ? (
          <p className="m-0 px-4 py-10 text-center text-muted-foreground" role="status">
            Loading pull requests…
          </p>
        ) : status.startsWith("error:") ? (
          <p className="m-0 px-4 py-10 text-center text-destructive" role="alert">
            Pull-request projection refused: {status.slice(6)}
          </p>
        ) : rows.length === 0 ? (
          <p className="m-0 px-4 py-10 text-center text-muted-foreground">
            No pull requests match this view.
          </p>
        ) : null}
        <ul className="m-0 list-none p-0" aria-label="Pull requests">
          {rows.map((p) => (
            <ItemRow
              key={p.prStream}
              ui={ui}
              state={PR_STATE[p.status] ?? "prOpen"}
              title={p.title}
              href={detailPath(org, repo, p.prId)}
              labels={[]}
              status={CHECK_ICON[p.status]}
              onOpen={preloadPrDetail}
              assignees={[userOf(p.author)]}
              comments={0}
              rowProps={{
                "data-testid": "pr-row",
                "data-pr-id": p.prId,
                "data-pr-status": p.status,
              }}
              meta={
                <>
                  #{p.prId} {p.status === "merged" ? "merged" : "opened"} by {p.author} ·{" "}
                  <span
                    className={
                      p.status === "approved"
                        ? "text-[var(--gh-open)]"
                        : p.status === "conflicted"
                          ? "text-[var(--gh-closed)]"
                          : ""
                    }
                  >
                    {REVIEW_TEXT[p.status] ?? p.status}
                  </span>{" "}
                  · <Branch>{branchNameFromStream(p.sourceBranch)}</Branch> →{" "}
                  <Branch>{branchNameFromStream(p.targetBranch)}</Branch>
                  <span className="sr-only"> head {p.headOffset}</span>
                </>
              }
            />
          ))}
        </ul>
      </Box>
      <AppSheet open={creating} onClose={() => setCreating(false)} title="New pull request">
        <CreatePrForm
          org={org}
          repo={repo}
          binding={binding}
          onComplete={() => setCreating(false)}
        />
      </AppSheet>
    </section>
  );
}
// ef:end

// ef: the create form dispatches `pr.opened` onto a fresh PR stream (no local list append).
function CreatePrForm(props: {
  org: string;
  repo: string;
  binding: PrListBinding;
  onComplete?: () => void;
}) {
  const branches = branchRows(props.binding);
  const defaultSource =
    branches.find((branch) => branch.name !== "main")?.streamId ??
    branches[0]?.streamId ??
    `fs:${props.org}/${props.repo}:main:meta`;
  const [source, setSource] = useState("");
  const selectedSource = branches.some((branch) => branch.streamId === source)
    ? source
    : defaultSource;
  // Controlled like the source select: an uncontrolled defaultValue is fixed at first
  // render, before the live branch catalog arrives, and then falls to the first option
  // (alphabetically an agent branch, not main) as branches stream in.
  const defaultTarget =
    branches.find((branch) => branch.name === "main")?.streamId ??
    `fs:${props.org}/${props.repo}:main:meta`;
  const [target, setTarget] = useState("");
  const selectedTarget = branches.some((branch) => branch.streamId === target)
    ? target
    : defaultTarget;
  const [prId, setPrId] = useState(() => `pr-${Date.now().toString(36)}`);
  const [error, setError] = useState<string>();
  const dispatch = usePrCreator(props.org, props.repo, prId);
  const selected = branches.find((branch) => branch.streamId === selectedSource);
  const label = "grid gap-1 text-[13px] font-semibold";
  return (
    <form
      className="grid gap-3"
      aria-label="Create pull request"
      onSubmit={(event) => {
        event.preventDefault();
        setError(undefined);
        const form = new FormData(event.currentTarget);
        void dispatch(
          openedEvent({
            org: props.org,
            repo: props.repo,
            sourceBranch: selectedSource,
            targetBranch: selectedTarget,
            forkOffset: selected?.forkOffset ?? "-1",
            title: String(form.get("title") ?? ""),
            body: String(form.get("body") ?? ""),
            author: props.binding.actor,
            closes: String(form.get("closes") ?? "").split(","),
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
      <div className="grid grid-cols-2 gap-3">
        <label className={label}>
          Source branch
          <select
            name="source"
            className={ghField}
            value={selectedSource}
            onChange={(event) => setSource(event.target.value)}
          >
            {branches.map((branch) => (
              <option key={branch.streamId} value={branch.streamId}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Target branch
          <select
            name="target"
            className={ghField}
            value={selectedTarget}
            onChange={(event) => setTarget(event.target.value)}
          >
            {branches.map((branch) => (
              <option key={branch.streamId} value={branch.streamId}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="m-0 text-[12px] text-muted-foreground">
        Fork offset <code>{selected?.forkOffset ?? "waiting for branch catalog"}</code>
      </p>
      <label className={label}>
        Title
        <input name="title" required placeholder="Describe the change" className={ghField} />
      </label>
      <label className={label}>
        Description
        <textarea
          name="body"
          rows={5}
          placeholder="What does this pull request change?"
          className={ghTextarea}
        />
      </label>
      <label className={label}>
        Closes issues
        <input name="closes" placeholder="issue-12, issue-19" className={ghField} />
      </label>
      {error === undefined ? null : (
        <p className="m-0 text-destructive" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={branches.length === 0} className={ghButton(true)}>
        Create pull request
      </button>
    </form>
  );
}
