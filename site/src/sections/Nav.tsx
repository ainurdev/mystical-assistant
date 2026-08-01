import { useEffect, useState } from "react";
import { GithubMark } from "@/components/GithubMark";
import { REPO_URL } from "@/site";

/** Numbered to match the chapter markers, so the nav reads as a contents page. */
const LINKS = [
  { href: "#features", n: "01", label: "In the box" },
  { href: "#workspace", n: "02", label: "Workspace" },
  { href: "#underneath", n: "03", label: "Underneath" },
  { href: "#setup", n: "04", label: "Setup" },
  { href: "#faq", n: "06", label: "FAQ" },
];

export function Nav() {
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 border-b transition-colors duration-300 ${
        solid ? "border-[var(--line)] bg-[var(--bg)]/88 backdrop-blur-md" : "border-transparent"
      }`}
    >
      <nav className="shell flex h-14 items-center gap-6">
        <a href="#top" className="flex items-center gap-2.5">
          <img src="./mystical.svg" alt="" width={22} height={22} aria-hidden />
          <span className="font-mono text-[0.78rem] tracking-[0.12em] text-[var(--ink)]">
            mystical<span className="text-[var(--ink-faint)]">//</span>assistant
          </span>
        </a>

        <ul className="ml-auto hidden items-center gap-5 lg:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="group flex items-baseline gap-1.5 font-mono text-[0.7rem] tracking-[0.06em] text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
              >
                <span className="text-[0.58rem] text-[var(--ink-muted)] transition-colors group-hover:text-[var(--accent)]">
                  {l.n}
                </span>
                {l.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-2 lg:ml-6">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost px-3 py-1.5 text-[0.7rem]"
          >
            <GithubMark />
            <span className="hidden sm:inline">GITHUB</span>
          </a>
          <a href="#get-started" className="btn btn-primary px-3 py-1.5 text-[0.7rem]">
            INSTALL
          </a>
        </div>
      </nav>
    </header>
  );
}
