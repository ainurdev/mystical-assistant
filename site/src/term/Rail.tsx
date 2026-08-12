import { useEffect, useState } from "react";
import { SECTIONS } from "./sections";

/**
 * Which of the six sections is currently under the reader, and how far down the
 * page they are.
 *
 * The observer band is a thin strip a third of the way down the viewport, so a
 * section becomes current when it reaches reading position rather than when it
 * first pokes above the fold. Nothing ever deactivates: once past the last
 * section the last row stays live, because a rail with no live row would
 * contradict the headline it exists to illustrate.
 */
export function useActiveSection() {
  const [active, setActive] = useState(0);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (!hit) return;
        const i = SECTIONS.findIndex((s) => s.id === hit.target.id);
        if (i >= 0) setActive(i);
      },
      { rootMargin: "-32% 0px -60% 0px" },
    );

    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    let raf = 0;
    const read = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = document.documentElement.scrollHeight - window.innerHeight;
        setProgress(h > 0 ? Math.min(1, Math.max(0, window.scrollY / h)) : 0);
      });
    };
    read();
    window.addEventListener("scroll", read, { passive: true });
    window.addEventListener("resize", read);
    return () => {
      window.removeEventListener("scroll", read);
      window.removeEventListener("resize", read);
      cancelAnimationFrame(raf);
    };
  }, []);

  return { active, progress };
}

/**
 * The state each row shows, given where the reader is.
 *
 * Straight out of the product's own queue: what you have read has run, what you
 * are reading is running, and the one immediately next is queued and waiting.
 * That puts exactly one amber row on screen at any moment and walks it down the
 * rail as you read — the page's second hue only ever means "this one is next".
 */
function stateOf(i: number, active: number) {
  if (i < active) return { label: "DONE", tone: "done" };
  if (i === active) return { label: "LIVE", tone: "live" };
  if (i === active + 1) return { label: "WAIT", tone: "wait" };
  return { label: "IDLE", tone: "idle" };
}

export function Rail({
  active,
  progress = 0,
  inline = false,
}: {
  active: number;
  progress?: number;
  /** Inline is the hero's copy for phones, where a fixed rail would tax every
   *  section below it. Same rows, no meter, no fixed positioning. */
  inline?: boolean;
}) {
  const rows = SECTIONS.map((s, i) => {
    const { label, tone } = stateOf(i, active);
    return (
      <a
        key={s.id}
        href={`#${s.id}`}
        className="rail-row"
        data-active={i === active}
        aria-current={i === active ? "true" : undefined}
      >
        <span className="rail-path">{s.path}</span>
        <span className="mt-1 flex items-center justify-between gap-2">
          <span className="font-mono text-[0.6rem] text-[var(--ink-dim)]">{s.note}</span>
          <span className={`tag st-${tone}`}>{label}</span>
        </span>
      </a>
    );
  });

  if (inline) {
    return (
      /* Hides at exactly the width the fixed rail appears at — Tailwind's `xl`
         is 1280px and the rail arrives at 1120px, which would show both. */
      <div className="win [@media(min-width:1120px)]:hidden">
        <div className="win-bar">
          <span className="font-mono text-[0.66rem] tracking-[0.06em] text-[var(--ink-dim)]">
            <span className="text-[var(--ink-ghost)]">▸ </span>sessions
          </span>
          <span className="font-mono text-[0.6rem] tracking-[0.16em] text-[var(--ink-dim)]">
            6 FOUND · <span className="lit">1 VISIBLE</span>
          </span>
        </div>
        <div className="divide-y divide-[var(--rule)]">{rows}</div>
      </div>
    );
  }

  return (
    <nav className="rail" aria-label="Sections">
      <div className="border-b border-[var(--rule)] px-[1.35rem] py-4">
        <a href="#top" className="font-mono text-[0.78rem] font-bold text-[var(--ink)]">
          mystical<span className="lit">//</span>assistant
        </a>
        <p className="label mt-2 text-[0.56rem]">6 sessions · 1 live</p>
      </div>

      <div className="flex-1 overflow-y-auto py-1">{rows}</div>

      {/* The product puts a live context meter under every session. Here the
          page is the session, so how far you have read is how full it is. */}
      <div className="border-t border-[var(--rule)] px-[1.35rem] py-4">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="label text-[0.55rem]">context</span>
          <span className="font-mono text-[0.62rem] text-[var(--ink-2)]">
            {Math.round(progress * 100)}%
          </span>
        </div>
        <div className="meter" role="presentation">
          <div className="meter-fill" style={{ width: `${progress * 100}%` }} />
        </div>
        <a href="#setup" className="btn btn-primary mt-4 w-full">
          Install it
        </a>
      </div>
    </nav>
  );
}
