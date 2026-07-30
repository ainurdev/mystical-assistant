import { FolderTree, Radar, SquareTerminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";

const PILLARS: { icon: LucideIcon; title: string; body: string; color: string }[] = [
  {
    icon: FolderTree,
    title: "Sessions, grouped by repo",
    body: "Every session keyed to the project it belongs to, so a repo's whole history sits in one place — turn counts, cost, which models ran, when it was last touched. No more guessing which of nine sessions was the one.",
    color: "var(--acc)",
  },
  {
    icon: Radar,
    title: "One list of what's alive",
    body: "Read from Claude Code's own session registry and checked against the actual process, so liveness is exact rather than a guess from file timestamps. VS Code, terminal, or started here — they all show up the same way.",
    color: "var(--ok)",
  },
  {
    icon: SquareTerminal,
    title: "The repo, right there",
    body: "Jump between the diff, the editor, git, worktrees, open issues, a real terminal and a map of the codebase without leaving the session you're reading. The context you'd go looking for is already open.",
    color: "var(--purple)",
  },
];

/**
 * Everything the dashboard actually opens: the three main views, the four
 * sidebar panels, the seven tabs in a project's analyze modal, and the preview
 * window. `soon` = the pane exists in the codebase but nothing opens it.
 */
const TABS: { name: string; soon?: boolean }[] = [
  { name: "CHAT" },
  { name: "HISTORY" },
  { name: "MEMORY" },
  { name: "PROJECTS" },
  { name: "FILES" },
  { name: "QUEUE" },
  { name: "EDITOR" },
  { name: "GIT" },
  { name: "WORKTREES" },
  { name: "TERMINAL" },
  { name: "ISSUES" },
  { name: "SKILLS" },
  { name: "MAP" },
  { name: "PREVIEW" },
  { name: "TEACHER", soon: true },
];

export function Dashboard() {
  return (
    <section id="dashboard" className="relative scroll-mt-20 px-5 py-20 sm:py-28">
      <div className="mx-auto max-w-5xl">
        <SectionHead
          eyebrow="The dashboard"
          title="Mission control for work you already started."
          lede="It runs on localhost and is never published. Point it at the folder your repos live in and it picks up the sessions that are already there — nothing to migrate, nothing to re-create."
        />

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {PILLARS.map((p, i) => (
            <Reveal key={p.title} delay={i * 80}>
              <article className="panel panel-hover brackets h-full p-5 sm:p-6">
                <span
                  className="flex h-9 w-9 items-center justify-center rounded-lg border"
                  style={{
                    color: p.color,
                    borderColor: `color-mix(in srgb, ${p.color} 30%, transparent)`,
                    background: `color-mix(in srgb, ${p.color} 8%, transparent)`,
                  }}
                >
                  <p.icon size={17} aria-hidden />
                </span>
                <h3 className="mt-4 text-[0.95rem] font-medium text-[var(--txb)]">{p.title}</h3>
                <p className="mt-2 text-[0.82rem] leading-relaxed text-[var(--txm)]">{p.body}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delay={160}>
          <div className="panel mt-4 p-5 sm:p-6">
            <p className="eyebrow mb-4">Everything the workspace opens</p>
            <ul className="flex flex-wrap items-center gap-1.5">
              {TABS.map((t) => (
                <li
                  key={t.name}
                  className={`flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[0.62rem] tracking-wider ${
                    t.soon
                      ? "border-[color-mix(in_srgb,var(--warn)_22%,transparent)] bg-[var(--panel3)]/60 text-[var(--txd)]"
                      : "border-[var(--border-soft)] bg-[var(--panel3)]/60 text-[var(--txm)]"
                  }`}
                >
                  {t.name}
                  {t.soon && <span className="text-[0.55rem] text-[var(--warn)]">soon</span>}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
