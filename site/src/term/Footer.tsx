import { CLAUDE_CODE_URL, ISSUES_URL, LICENSE_URL, README_URL, REPO_URL } from "@/site";

const LINKS = [
  ["Source", REPO_URL],
  ["Readme", README_URL],
  ["Issues", ISSUES_URL],
  ["Licence", LICENSE_URL],
  ["Claude Code", CLAUDE_CODE_URL],
];

export function Footer() {
  return (
    <footer className="border-t border-[var(--rule)] bg-[var(--panel)]">
      <div className="shell flex flex-wrap items-center justify-between gap-x-8 gap-y-4 py-8">
        <p className="font-mono text-[0.72rem] text-[var(--ink-dim)]">
          mystical<span className="lit">//</span>assistant — MIT. Runs on your machine.
        </p>
        <nav className="flex flex-wrap gap-x-5 gap-y-2">
          {LINKS.map(([label, href]) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[0.7rem] text-[var(--ink-dim)] transition-colors hover:text-[var(--live)]"
            >
              {label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
