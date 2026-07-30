import { GithubMark } from "@/components/GithubMark";
import { CLAUDE_CODE_URL, ISSUES_URL, LICENSE_URL, README_URL, REPO_URL } from "@/site";

export function Footer() {
  return (
    <footer className="relative border-t border-[var(--border-soft)] px-5 py-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          <img src="./mystical.svg" alt="" width={22} height={22} aria-hidden />
          <span className="font-[var(--mono)] text-[0.78rem] tracking-[0.14em] text-[var(--txd)]">
            mystical<span className="text-[var(--txl)]">//</span>assistant
          </span>
        </div>

        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[0.75rem] text-[var(--txd)]">
          <a href={README_URL} target="_blank" rel="noreferrer" className="hover:text-[var(--txh)]">
            Docs
          </a>
          <a href={ISSUES_URL} target="_blank" rel="noreferrer" className="hover:text-[var(--txh)]">
            Issues
          </a>
          <a href={LICENSE_URL} target="_blank" rel="noreferrer" className="hover:text-[var(--txh)]">
            MIT License
          </a>
          <a
            href={CLAUDE_CODE_URL}
            target="_blank"
            rel="noreferrer"
            className="hover:text-[var(--txh)]"
          >
            Claude Code
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 hover:text-[var(--txh)]"
          >
            <GithubMark size={14} />
            GitHub
          </a>
        </nav>
      </div>

      <p className="mx-auto mt-7 max-w-5xl text-[0.7rem] leading-relaxed text-[var(--txd)]">
        Free and open source under the MIT License, and not affiliated with Anthropic. Claude and
        Claude Code are their trademarks — you bring your own, this just gives you a longer cable.
      </p>
    </footer>
  );
}
