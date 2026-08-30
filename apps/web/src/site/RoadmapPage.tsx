import { useEffect, useState } from "react";
import { Markdown } from "../components/markdown/Markdown.js";
import { RouteLink } from "../navigation.js";
import {
  documents,
  loadTaskReadme,
  milestoneLadder,
  roadmap,
  type EpicIndexEntry,
  type TaskIndexEntry,
} from "./content.js";
import { parseFrontmatter } from "./frontmatter.js";
import { SiteShell, StatusBadge } from "./SiteShell.js";

function epicName(epic: EpicIndexEntry): string {
  return epic.slug.replace(/-/g, " ");
}

function epicState(tasks: readonly TaskIndexEntry[]): "done" | "in-progress" | "next" | "pending" {
  const live = tasks.filter((task) => task.status !== "cancelled");
  if (live.length > 0 && live.every((task) => task.status === "verified")) return "done";
  if (live.some((task) => task.status !== "pending")) return "in-progress";
  return "pending";
}

function EpicSection(props: {
  readonly epic: EpicIndexEntry;
  readonly milestone: string | undefined;
  readonly description: string | undefined;
  readonly tasks: readonly TaskIndexEntry[];
  readonly next: boolean;
}): React.JSX.Element {
  const verified = props.tasks.filter((task) => task.status === "verified").length;
  const live = props.tasks.filter((task) => task.status !== "cancelled").length;
  const state =
    props.next && epicState(props.tasks) === "pending" ? "next" : epicState(props.tasks);
  const stateLabel =
    state === "done"
      ? "Done"
      : state === "in-progress"
        ? "In progress"
        : state === "next"
          ? "Next"
          : "Planned";
  return (
    <section
      className="site-epic"
      id={props.epic.folder}
      data-testid={`roadmap-epic-${String(props.epic.number)}`}
      data-epic-state={state}
    >
      <header className="site-epic-head">
        <div className="site-epic-id">E{props.epic.number}</div>
        <div className="site-epic-title">
          <span className={`site-epic-state site-epic-state-${state}`}>{stateLabel}</span>
          <h3>{epicName(props.epic)}</h3>
          {props.milestone === undefined ? null : (
            <p>
              <b>{props.milestone}</b>
              {props.description === undefined ? null : <> — {props.description}</>}
            </p>
          )}
        </div>
        <div
          className="site-epic-progress"
          aria-label={`${String(verified)} of ${String(live)} tasks verified`}
        >
          <div className="site-epic-bar">
            <span
              style={{ width: `${String(live === 0 ? 0 : Math.round((verified / live) * 100))}%` }}
            />
          </div>
          <small>
            {verified} / {live} verified
          </small>
        </div>
      </header>
      <ol className="site-task-list">
        {props.tasks.map((task) => (
          <li key={task.id} className={`site-task site-task-${task.status}`}>
            <RouteLink href={`/roadmap/${encodeURIComponent(task.id)}`}>
              <span className="site-task-id">{task.id}</span>
              <span className="site-task-title">
                {task.title}
                {task.capstone ? <span className="site-capstone">capstone</span> : null}
              </span>
              <StatusBadge status={task.status} />
            </RouteLink>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RoadmapPage(props: { readonly session: boolean }): React.JSX.Element {
  const ladder = milestoneLadder();
  const verified = roadmap.tasks.filter((task) => task.status === "verified").length;
  const total = roadmap.tasks.length;
  let nextAssigned = false;
  return (
    <SiteShell session={props.session} page="roadmap">
      <section className="site-page-hero">
        <div className="site-wrap">
          <span className="site-eyebrow">Product roadmap · the road to the mirror</span>
          <h1>
            Nine epics, <span className="grad">one log.</span>
          </h1>
          <p className="site-lede">
            This board is the repository's real <code>.eforest/tasks</code> queue, indexed at build
            time and rendered here with Docstream. <b>{verified}</b> of <b>{total}</b> tasks have
            survived an adversarial critic. Click any task to read its full spec, its claim, and its
            verification log.
          </p>
          <div className="site-cta-row">
            <RouteLink href="/roadmap/document">
              <span className="site-btn site-btn-ghost">Read the canonical roadmap</span>
            </RouteLink>
          </div>
        </div>
      </section>
      <section className="site-block-tight">
        <div className="site-wrap">
          <span className="site-kicker">The milestone ladder</span>
          <h2 className="site-h2">Every epic ends in something you can run.</h2>
          <div className="site-ladder">
            {ladder.map((row) => (
              <a
                className="site-rung"
                href={`#epic-${row.epic.slice(1)}-${row.name}`}
                key={row.epic}
              >
                <span className="site-rung-id">{row.epic}</span>
                <span className="site-rung-name">{row.name.replace(/-/g, " ")}</span>
                <span className="site-rung-milestone">{row.milestone}</span>
              </a>
            ))}
          </div>
        </div>
      </section>
      <section className="site-block-tight" data-testid="roadmap-board">
        <div className="site-wrap">
          <span className="site-kicker">The board</span>
          <h2 className="site-h2">{total} tasks, in priority order.</h2>
          {roadmap.epics.map((epic) => {
            const tasks = roadmap.tasks.filter((task) => task.epic === epic.number);
            const row = ladder.find((item) => item.epic === `E${String(epic.number)}`);
            const next = !nextAssigned && epicState(tasks) === "pending";
            if (next) nextAssigned = true;
            return (
              <EpicSection
                key={epic.folder}
                epic={epic}
                milestone={row?.milestone}
                description={row?.description}
                tasks={tasks}
                next={next}
              />
            );
          })}
        </div>
      </section>
    </SiteShell>
  );
}

export function RoadmapDocumentPage(props: { readonly session: boolean }): React.JSX.Element {
  return (
    <SiteShell session={props.session} page="roadmap">
      <article className="site-wrap site-article" data-testid="roadmap-document">
        <p className="site-crumbs">
          <RouteLink href="/roadmap">Roadmap</RouteLink> / ROADMAP.md
        </p>
        <Markdown
          source={documents.roadmap}
          className="site-docstream"
          data-testid="roadmap-markdown"
        />
      </article>
    </SiteShell>
  );
}

export function TaskPage(props: {
  readonly session: boolean;
  readonly id: string;
}): React.JSX.Element {
  const task = roadmap.tasks.find((item) => item.id === props.id);
  const [body, setBody] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setBody(undefined);
    if (task === undefined) {
      setBody(null);
      return;
    }
    void loadTaskReadme(task.folder).then(
      (text) => {
        if (cancelled) return;
        setBody(text === undefined ? null : parseFrontmatter(text).body);
      },
      () => {
        if (!cancelled) setBody(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [task]);
  if (task === undefined) {
    return (
      <SiteShell session={props.session} page="roadmap">
        <article className="site-wrap site-article">
          <p className="site-crumbs">
            <RouteLink href="/roadmap">Roadmap</RouteLink> / {props.id}
          </p>
          <h1 data-testid="route-not-found">404 — no task named {props.id}</h1>
        </article>
      </SiteShell>
    );
  }
  const epic = roadmap.epics.find((item) => item.number === task.epic);
  return (
    <SiteShell session={props.session} page="roadmap">
      <article className="site-wrap site-article" data-testid="roadmap-task" data-task-id={task.id}>
        <p className="site-crumbs">
          <RouteLink href="/roadmap">Roadmap</RouteLink> /{" "}
          <a href={`/roadmap#${epic?.folder ?? ""}`}>
            E{task.epic} {epic === undefined ? "" : epicName(epic)}
          </a>{" "}
          / {task.id}
        </p>
        <header className="site-task-head">
          <div className="site-task-head-row">
            <span className="site-task-id">{task.id}</span>
            <StatusBadge status={task.status} />
            {task.capstone ? <span className="site-capstone">capstone</span> : null}
          </div>
          <h1>{task.title}</h1>
          <dl className="site-task-facts">
            <dt>Priority</dt>
            <dd>{task.priority}</dd>
            <dt>Estimate</dt>
            <dd>{task.estimate ?? "—"}</dd>
            <dt>Depends on</dt>
            <dd>
              {task.dependsOn.length === 0
                ? "—"
                : task.dependsOn.map((dep, index) => (
                    <span key={dep}>
                      {index > 0 ? ", " : ""}
                      {roadmap.tasks.some((item) => item.id === dep) ? (
                        <RouteLink href={`/roadmap/${encodeURIComponent(dep)}`}>{dep}</RouteLink>
                      ) : (
                        dep
                      )}
                    </span>
                  ))}
            </dd>
            <dt>Folder</dt>
            <dd>
              <code>.eforest/tasks/{task.folder}</code>
            </dd>
          </dl>
        </header>
        {body === undefined ? (
          <p data-testid="route-loading">Loading task spec…</p>
        ) : body === null ? (
          <p role="alert">The task readme could not be loaded.</p>
        ) : (
          <Markdown source={body} className="site-docstream" data-testid="task-markdown" />
        )}
      </article>
    </SiteShell>
  );
}
