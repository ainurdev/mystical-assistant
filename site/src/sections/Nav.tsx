import { useEffect, useState } from "react";
import { GithubMark } from "@/components/GithubMark";
import { REPO_URL } from "@/site";

const LINKS = [
  { href: "#different", label: "Why this one" },
  { href: "#dashboard", label: "Dashboard" },
  { href: "#screens", label: "Screens" },
  { href: "#underneath", label: "Underneath" },
  { href: "#features", label: "Features" },
  { href: "#faq", label: "FAQ" },
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
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        solid
          ? "border-b border-[var(--border-soft)] bg-[var(--canvas)]/85 backdrop-blur-lg"
          : "border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-5">
        <a href="#top" className="flex items-center gap-2.5">
          <img src="./mystical.svg" alt="" width={26} height={26} aria-hidden />
          <span className="font-[var(--mono)] text-sm tracking-[0.14em] text-[var(--txb)]">
            mystical<span className="text-[var(--txl)]">//</span>assistant
          </span>
        </a>

        <ul className="ml-auto hidden items-center gap-6 md:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="text-[0.8rem] text-[var(--txd)] transition-colors hover:text-[var(--txb)]"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-2 md:ml-0">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="btn btn-ghost px-3 py-2 text-[0.8rem]"
          >
            <GithubMark />
            <span className="hidden sm:inline">GitHub</span>
          </a>
          <a href="#get-started" className="btn btn-primary px-3.5 py-2 text-[0.8rem]">
            Get started
          </a>
        </div>
      </nav>
    </header>
  );
}
