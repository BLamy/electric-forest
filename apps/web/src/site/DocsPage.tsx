import { Markdown } from "../components/markdown/Markdown.js";
import { RouteLink } from "../navigation.js";
import { docPages, docSections } from "./content.js";
import { SiteShell } from "./SiteShell.js";

export function DocsPage(props: {
  readonly session: boolean;
  readonly slug: string | undefined;
}): React.JSX.Element {
  const page =
    props.slug === undefined ? docPages[0] : docPages.find((item) => item.slug === props.slug);
  const index = page === undefined ? -1 : docPages.indexOf(page);
  const previous = index > 0 ? docPages[index - 1] : undefined;
  const next = index >= 0 ? docPages[index + 1] : undefined;
  return (
    <SiteShell session={props.session} page="docs">
      <div className="site-wrap site-docs" data-testid="docs">
        <nav className="site-docs-nav" aria-label="Documentation">
          {docSections.map((section) => (
            <div key={section.title} className="site-docs-section">
              <h4>{section.title}</h4>
              <ul>
                {section.pages.map((item) => (
                  <li key={item.slug} data-active={item.slug === page?.slug ? "true" : undefined}>
                    <RouteLink href={`/docs/${item.slug}`}>{item.title}</RouteLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <article
          className="site-docs-article"
          data-testid="docs-article"
          data-doc-slug={page?.slug}
        >
          {page === undefined ? (
            <h1 data-testid="route-not-found">404 — no doc at {props.slug ?? ""}</h1>
          ) : (
            <>
              <p className="site-crumbs">
                <RouteLink href="/docs">Docs</RouteLink> / {page.section} / {page.title}
              </p>
              <Markdown source={page.body} className="site-docstream" data-testid="docs-markdown" />
              <footer className="site-docs-pager">
                {previous === undefined ? (
                  <span />
                ) : (
                  <RouteLink href={`/docs/${previous.slug}`}>← {previous.title}</RouteLink>
                )}
                {next === undefined ? (
                  <span />
                ) : (
                  <RouteLink href={`/docs/${next.slug}`}>{next.title} →</RouteLink>
                )}
              </footer>
            </>
          )}
        </article>
      </div>
    </SiteShell>
  );
}
