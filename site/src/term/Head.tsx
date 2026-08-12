/**
 * A section head. The kicker is the section's own rail path, so the rail and
 * the page name each destination identically — the nav is not a separate set
 * of labels you have to map onto the content.
 */
export function Head({ path, title, deck }: { path: string; title: string; deck?: string }) {
  return (
    <header>
      <p className="label flex items-center gap-3">
        <span className="text-[var(--ink-ghost)]">▸</span>
        {path}
        <span className="h-px flex-1 bg-gradient-to-r from-[var(--rule-hi)] to-transparent" />
      </p>
      <h2 className="h2 mt-5 max-w-[20ch]">{title}</h2>
      {deck && <p className="deck mt-5 max-w-[56ch]">{deck}</p>}
    </header>
  );
}
