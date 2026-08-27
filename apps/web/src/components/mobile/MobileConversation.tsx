import { Avatar, IndexBar } from "@brett_lamy/ui";
import { useId, type ReactNode } from "react";

export interface MobileConversationTurn {
  readonly id: string;
  readonly author: string;
  readonly avatar?: { readonly first: string; readonly last: string };
  readonly timestamp: ReactNode;
  readonly dateTime?: string;
  readonly summary: string;
  /** Canonical app-rendered @brett_lamy/docstream body; never package-owned chat markup. */
  readonly docstreamBody: ReactNode;
  readonly metadata?: ReactNode;
  readonly actions?: ReactNode;
}

export interface MobileConversationProps {
  readonly title: string;
  readonly turns: readonly MobileConversationTurn[];
  readonly empty?: ReactNode;
  readonly composer?: ReactNode;
  readonly className?: string;
}

function inferredAvatar(author: string): { f: string; l: string } {
  const parts = author.trim().split(/\s+/u);
  return { f: parts[0] ?? author, l: parts.slice(1).join(" ") };
}

/**
 * App-owned issue/PR conversation markup around canonical Docstream articles.
 * TouchKit supplies identity and long-thread navigation without inventing a chat export.
 */
export function MobileConversation(props: MobileConversationProps): React.JSX.Element {
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const titleId = `mobile-conversation-${instanceId}`;
  const turnDomId = (turnId: string, index: number): string =>
    `${titleId}-turn-${turnId.replace(/[^a-zA-Z0-9_-]/g, "-")}-${String(index)}`;
  return (
    <section
      className={["mobile-conversation", props.className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
    >
      <h2 id={titleId} className="mobile-conversation-title">
        {props.title}
      </h2>
      {props.turns.length === 0 ? (
        <div className="mobile-conversation-empty">{props.empty ?? "No conversation yet."}</div>
      ) : (
        <ol className="mobile-conversation-list">
          {props.turns.map((turn, index) => {
            const avatar = turn.avatar
              ? { f: turn.avatar.first, l: turn.avatar.last }
              : inferredAvatar(turn.author);
            const articleId = turnDomId(turn.id, index);
            const headingId = `${articleId}-heading`;
            return (
              <li key={turn.id}>
                <article
                  id={articleId}
                  className="mobile-conversation-article selectable-content"
                  aria-labelledby={headingId}
                  tabIndex={-1}
                  data-docstream-conversation-article="true"
                >
                  <header className="mobile-conversation-header">
                    <Avatar c={avatar} size={34} />
                    <div className="mobile-conversation-byline">
                      <h3 id={headingId}>{turn.author}</h3>
                      {turn.dateTime === undefined ? (
                        <span>{turn.timestamp}</span>
                      ) : (
                        <time dateTime={turn.dateTime}>{turn.timestamp}</time>
                      )}
                    </div>
                    {turn.metadata === undefined ? null : (
                      <div className="mobile-conversation-metadata">{turn.metadata}</div>
                    )}
                  </header>
                  <div className="mobile-conversation-docstream">{turn.docstreamBody}</div>
                  {turn.actions === undefined ? null : (
                    <footer className="mobile-conversation-actions">{turn.actions}</footer>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      )}
      {props.turns.length < 2 ? null : (
        <IndexBar
          items={props.turns.map((turn) => ({
            key: turn.id,
            caption: turn.author,
            preview: <span>{turn.summary}</span>,
          }))}
          label={`Jump through ${props.title}`}
          bottom={82}
          onJump={(id: string) => {
            const index = props.turns.findIndex((turn) => turn.id === id);
            const article = index < 0 ? null : document.getElementById(turnDomId(id, index));
            article?.scrollIntoView({ block: "center", behavior: "smooth" });
            article?.focus({ preventScroll: true });
          }}
        />
      )}
      {props.composer === undefined ? null : (
        <div className="mobile-conversation-composer">{props.composer}</div>
      )}
    </section>
  );
}
