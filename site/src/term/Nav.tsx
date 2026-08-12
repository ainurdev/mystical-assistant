import { REPO_URL } from "@/site";

/**
 * Phones only. On desktop the rail already carries the wordmark and every
 * section link, so a top bar would be a second navigation for the same six
 * destinations — the rail replacing the nav is the point of having it.
 */
export function Nav() {
  return (
    <header className="fixed top-0 right-0 left-0 z-50 border-b border-[var(--rule)] bg-[rgb(4_7_10/0.86)] backdrop-blur-md [@media(min-width:1120px)]:hidden">
      <div className="flex items-center justify-between gap-3 px-[var(--gutter)] py-2.5">
        <a href="#top" className="font-mono text-[0.78rem] font-bold text-[var(--ink)]">
          mystical<span className="lit">//</span>assistant
        </a>
        <div className="flex items-center gap-2">
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn btn-ghost !px-2.5 !py-1.5">
            Source
          </a>
          <a href="#setup" className="btn btn-primary !px-2.5 !py-1.5">
            Install
          </a>
        </div>
      </div>
    </header>
  );
}
