import { GithubMark } from "@/components/GithubMark";
import { CLAUDE_CODE_URL, ISSUES_URL, LICENSE_URL, README_URL, REPO_URL } from "@/site";

export function Footer() {
  return (
    <footer className="relative border-t border-[var(--line)] bg-[var(--bg-sunk)]">
      <div className="shell py-10">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            <img src="./mystical.svg" alt="" width={20} height={20} aria-hidden />
            <span className="font-mono text-[0.74rem] tracking-[0.12em] text-[var(--ink-muted)]">
              mystical<span className="text-[var(--ink-faint)]">//</span>assistant
            </span>
          </div>

          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[0.7rem] text-[var(--ink-muted)]">
            <a href={README_URL} target="_blank" rel="noreferrer" className="hover:text-[var(--ink)]">
              Docs
            </a>
            <a href={ISSUES_URL} target="_blank" rel="noreferrer" className="hover:text-[var(--ink)]">
              Issues
            </a>
            <a href={LICENSE_URL} target="_blank" rel="noreferrer" className="hover:text-[var(--ink)]">
              MIT License
            </a>
            <a
              href={CLAUDE_CODE_URL}
              target="_blank"
              rel="noreferrer"
              className="hover:text-[var(--ink)]"
            >
              Claude Code
            </a>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 hover:text-[var(--ink)]"
            >
              <GithubMark size={13} />
              GitHub
            </a>
          </nav>
        </div>

        <p className="caption mt-8 max-w-[80ch]">
          Free and open source under the MIT License, and not affiliated with Anthropic. Claude and
          Claude Code are their trademarks. You bring your own; this just gives you a longer cable.
        </p>
      </div>
    </footer>
  );
}
