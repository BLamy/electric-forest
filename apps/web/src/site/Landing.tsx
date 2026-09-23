import { useEffect, useRef } from "react";
import { RouteLink } from "../navigation.js";
import { GITHUB_URL, roadmap } from "./content.js";
import { SiteShell } from "./SiteShell.js";

function useReveal(): void {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nodes = document.querySelectorAll<HTMLElement>(".site .reveal");
    if (reduced || typeof IntersectionObserver === "undefined") {
      nodes.forEach((node) => node.classList.add("in"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.15 },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);
}

function CountUp(props: { readonly value: number; readonly suffix?: string }): React.JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof IntersectionObserver === "undefined") {
      node.textContent = String(props.value);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        const start = performance.now();
        const tick = (now: number): void => {
          const k = Math.min(1, (now - start) / 1100);
          const eased = 1 - Math.pow(1 - k, 3);
          node.textContent = String(Math.round(props.value * eased));
          if (k < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.6 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [props.value]);
  return (
    <>
      <span ref={ref}>0</span>
      {props.suffix === undefined ? null : <span className="sfx">{props.suffix}</span>}
    </>
  );
}

const features = [
  {
    icon: "🌲",
    title: "Streams instead of git",
    body: "A repo's main branch is an append-only stream. Branches are forks of the log at an offset — not copies of the tree. History is O(events).",
    tag: "// fs.branch.fork @ offset",
  },
  {
    icon: "⚡",
    title: "Live branches",
    body: "Every change to a branch syncs to every user of that branch as it happens. An AI's edits appear while it types, not as a commit afterward.",
    tag: "// long-poll · SSE · watch()",
  },
  {
    icon: "🗄️",
    title: "No database",
    body: "Issues, wiki, pull requests, users, orgs — all events on streams. Every list view is a reducer over the log, rebuildable by replay. Lose every index, lose nothing.",
    tag: "// state = replay(events)",
  },
  {
    icon: "🚪",
    title: "One mutation door",
    body: "The only way to change state is dispatching an event. Every session is a trace, every bug is an offset, time travel is a product feature.",
    tag: "// POST /api/dispatch",
  },
  {
    icon: "🔮",
    title: ".eforest stores the future",
    body: "Each project carries its task queue, its builder/critic loop, and the evidence of what has been proven — on the same streams as the code.",
    tag: "// .eforest/tasks · loop.md",
  },
  {
    icon: "🧾",
    title: "Evidence, not claims",
    body: "Nothing reaches verified on a builder's word. An adversarial critic interrogates the recorded run. Digests are compared with cmp, not eyeballs.",
    tag: "// sha256 · replay · Replay",
  },
] as const;

const layers = [
  {
    level: "L6",
    title: "The web app & ef CLI",
    detail: "repos · trees · files · PRs · issues · wiki · the loop, all live",
  },
  {
    level: "L5",
    title: "Dispatch door + identity",
    detail: "authenticated, validated mutations · Auth0 answers only “who is this?”",
  },
  {
    level: "L4",
    title: "Reducers & derived views",
    detail: "issue boards, PR catalogs, registries — materialized by replay, never stored",
  },
  {
    level: "L3",
    title: "StreamFS",
    detail: "metadata stream + per-file content streams · patches · forks · three-way merge",
  },
  {
    level: "L2",
    title: "Application events",
    detail: "canonical JSON · opaque lexicographic offsets · SHA-256 state digests",
  },
  {
    level: "L1",
    title: "Electric Durable Streams",
    detail: "the substrate — append-only, resumable, forkable; Electric Cloud in production",
    metal: true,
  },
] as const;

export function Landing(props: { readonly session: boolean }): React.JSX.Element {
  useReveal();
  const verified = roadmap.tasks.filter((task) => task.status === "verified").length;
  const total = roadmap.tasks.length;
  const epics = roadmap.epics.length;
  return (
    <SiteShell session={props.session} page="landing" wide>
      <header className="site-hero">
        <div className="site-wrap site-hero-in">
          <span className="site-eyebrow">
            <span className="site-pulse" aria-hidden="true" /> Durable streams · no git · no
            database
          </span>
          <h1>
            GitHub,
            <br />
            <span className="grad">with the git ripped out.</span>
          </h1>
          <p className="site-lede">
            A code host where every repository is an <b>append-only stream</b>, every branch is a{" "}
            <b>fork of the log</b>, and every issue, review, and merge is an <b>event</b>. Nothing
            is stored twice; everything is <b>replay(events)</b>.
          </p>
          <div className="site-cta-row">
            {props.session ? (
              <RouteLink href="/">
                <span className="site-btn site-btn-lg">
                  Open the forest <span className="site-arrow">→</span>
                </span>
              </RouteLink>
            ) : (
              <a className="site-btn site-btn-lg" href="/auth/login" data-testid="hero-login">
                Log in <span className="site-arrow">→</span>
              </a>
            )}
            <RouteLink href="/docs">
              <span className="site-btn site-btn-ghost site-btn-lg">Read the docs</span>
            </RouteLink>
          </div>
          <div className="site-stats">
            <div className="site-stat">
              <div className="n">
                0<span className="u">db</span>
              </div>
              <div className="l">no Postgres, no side tables</div>
            </div>
            <div className="site-stat">
              <div className="n">
                1<span className="u">door</span>
              </div>
              <div className="l">one way to mutate anything</div>
            </div>
            <div className="site-stat">
              <div className="n">
                {verified}
                <span className="u">/{total}</span>
              </div>
              <div className="l">tasks adversarially verified</div>
            </div>
            <div className="site-stat">
              <div className="n">
                replay<span className="u">≡</span>state
              </div>
              <div className="l">deterministic by construction</div>
            </div>
          </div>
        </div>
      </header>

      <section className="site-block site-sheet" id="features">
        <div className="site-wrap">
          <div className="reveal">
            <span className="site-kicker">What it does</span>
            <h2 className="site-h2">Not a git wrapper. A different substrate.</h2>
            <p className="site-sub">
              Everything GitHub keeps in Postgres lives on the same streams as the code, under one
              unifying model — and the model is small enough to hold in your head.
            </p>
          </div>
          <div className="site-grid">
            {features.map((feature, index) => (
              <div className={`site-card reveal d${String((index % 3) + 1)}`} key={feature.title}>
                <div className="ico" aria-hidden="true">
                  {feature.icon}
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
                <span className="tag">{feature.tag}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="site-block" id="numbers">
        <div className="site-wrap">
          <div className="reveal">
            <span className="site-kicker">By the numbers</span>
            <h2 className="site-h2">Built the long way. On purpose.</h2>
          </div>
          <div className="site-nums reveal d1">
            <div className="site-num">
              <div className="big">
                <CountUp value={total} />
              </div>
              <div className="lbl">engineered tasks, ledger-tracked</div>
            </div>
            <div className="site-num">
              <div className="big">
                <CountUp value={verified} />
              </div>
              <div className="lbl">verified by an adversarial critic</div>
            </div>
            <div className="site-num">
              <div className="big">
                <CountUp value={epics} />
              </div>
              <div className="lbl">epics, the seed → the mirror</div>
            </div>
            <div className="site-num">
              <div className="big">
                <CountUp value={1} suffix="×" />
              </div>
              <div className="lbl">external service — Auth0, identity only</div>
            </div>
          </div>
        </div>
      </section>

      <section className="site-block site-sheet" id="model">
        <div className="site-wrap">
          <div className="reveal">
            <span className="site-kicker">How it works</span>
            <h2 className="site-h2">One model to hold them all.</h2>
            <p className="site-sub">
              Every noun — file, branch, repo, issue, wiki page, pull request, task, evidence — is
              the same thing: an entity defined by <code>(stream, reducer)</code> whose state is{" "}
              <code>replay(events)</code>. The whole stack, top to bottom:
            </p>
          </div>
          <div className="site-stack">
            {layers.map((layer, index) => (
              <div
                className={`site-layer reveal d${String(Math.min(3, Math.floor(index / 2) + 1))}${"metal" in layer && layer.metal ? " metal" : ""}`}
                key={layer.level}
              >
                <span className="lv">{layer.level}</span>
                <div className="ly-main">
                  <div className="lt">{layer.title}</div>
                  <div className="ld">{layer.detail}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="site-term reveal d1">
            <div className="site-term-bar">
              <i className="r" />
              <i className="y" />
              <i className="g" />
              <span>ef — two terminals, one log</span>
            </div>
            <pre>
              <span className="d">
                # terminal A dispatches; terminal B replays to the same digest
              </span>
              {"\n"}
              <span className="m">A $</span> ef dispatch fs:maple/reading-room:main:meta{" "}
              {'\'{"type":"fs.file.write","payload":{"path":"README.md"}}\''}
              {"\n"}
              <span className="c">accepted</span> offset=000000000000000042 digest=
              <span className="c">9f2c…e1a0</span>
              {"\n"}
              <span className="m">B $</span> ef replay dump.jsonl --digest
              {"\n"}
              <span className="c">9f2c…e1a0</span>
              {"\n"}
              <span className="m">B $</span> ef bisect log-a.jsonl log-b.jsonl
              {"\n"}
              first divergent offset: <span className="c">none</span> — logs are identical
              {"\n"}
              <span className="m">$</span> <span className="d">_</span>
            </pre>
          </div>
        </div>
      </section>

      <section className="site-block" id="different">
        <div className="site-wrap">
          <div className="reveal">
            <span className="site-kicker">What it isn't</span>
            <h2 className="site-h2">A real stream system — not an event log bolted on.</h2>
            <p className="site-sub">Plenty of things emit events. This one is made of them.</p>
          </div>
          <div className="site-diff">
            <div className="d reveal d1">
              <div className="no">// not a git wrapper</div>
              <div className="yes">The log is the repo</div>
              <p>
                There is no `.git`. A branch is `(parent, forkOffset)`; merge is log-aware; “who
                changed what when” is a digest bisect, not archaeology.
              </p>
            </div>
            <div className="d reveal d2">
              <div className="no">// not a database with a changelog</div>
              <div className="yes">Indexes are disposable</div>
              <p>
                Repo lists, issue boards, PR catalogs are derived streams. If a feature seems to
                need a database, the feature is misdesigned.
              </p>
            </div>
            <div className="d reveal d3">
              <div className="no">// not a demo</div>
              <div className="yes">It builds itself</div>
              <p>
                This repo dogfoods its product: the tasks on the roadmap page are the real{" "}
                <code>.eforest/tasks</code> board, rendered live from the tree.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="site-block site-sheet site-final">
        <div className="site-wrap">
          <div className="reveal">
            <span className="site-kicker">Ready when you are</span>
            <h2 className="site-h2">Walk into the forest.</h2>
            <p className="site-sub site-center">
              Sign in with Auth0 and you're on a stream. Every click from here is an offset.
            </p>
            <div className="site-cta-row site-center-row">
              {props.session ? (
                <RouteLink href="/">
                  <span className="site-btn site-btn-lg">
                    Open the forest <span className="site-arrow">→</span>
                  </span>
                </RouteLink>
              ) : (
                <a className="site-btn site-btn-lg" href="/auth/login">
                  Log in <span className="site-arrow">→</span>
                </a>
              )}
              <a
                className="site-btn site-btn-ghost site-btn-lg"
                href={GITHUB_URL}
                target="_blank"
                rel="noopener"
              >
                Star on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}
