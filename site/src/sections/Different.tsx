import { Brain, GraduationCap, PackageOpen, RadioTower, TimerReset } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import { Soon } from "@/components/Soon";

/**
 * The differentiators, checked against the field before they were written down.
 * Session auto-discovery, file explorers, git panes, worktrees and live subagent
 * feeds all exist elsewhere, so none of them are claimed here. Each `elsewhere`
 * line is a factual statement about the rest of the field — if one stops being
 * true, delete the row rather than softening it.
 *
 * `soon` marks a row the build doesn't fully deliver yet — the copy has to say
 * which part is missing, not just wear the badge.
 */
const POINTS: {
  icon: LucideIcon;
  lead: string;
  body: string;
  elsewhere: string;
  soon?: boolean;
}[] = [
  {
    icon: TimerReset,
    lead: "A limit parks the turn, then looks for another way",
    body: "Hit a 5-hour or weekly cap and the work is parked, not lost — and parking is only the floor. It walks a ladder: another Claude account you own, if one still has quota; a free agent on a different provider, if none do; otherwise it reads the real reset time off the usage endpoint, waits for it, and picks the turn back up with its context intact. Each session decides whether it asks you first or just switches. Server errors take their own path — the first retry is immediate, then a minute, out to thirty. All of it survives a restart.",
    elsewhere: "Claude Code has an open request for the resume, and today's answers are shell wrappers watching the terminal from outside. The account-switchers swap one global credential file, which changes the account under every session already running.",
  },
  {
    icon: GraduationCap,
    lead: "It teaches you what it just wrote",
    body: "After a turn that changed code, a cheap pass picks at most two things you probably accepted without fully reading, and offers them as Keep or Skip cards. The review itself — an explanation, a graded explain-back, a quiz, an exercise — is written and served by the bridge, but the dashboard doesn't open it yet.",
    elsewhere: "Other dashboards show you the diff and leave it there.",
    soon: true,
  },
  {
    icon: Brain,
    lead: "Memory you approve, scoped to the branch",
    body: "Facts are proposed as Keep or Skip cards and typed as a convention, decision, preference, goal or gotcha. Only what you keep gets injected, and it's scoped to that project and that branch, so a spike doesn't leak its assumptions into main.",
    elsewhere: "The popular memory plugins ingest your sessions automatically into one bank per project.",
  },
  {
    icon: RadioTower,
    lead: "Liveness from the process, not a timestamp",
    body: "It reads Claude Code's own session registry and asks the OS whether that PID is alive. A VS Code session shows as running because the process is running. Nothing is inferred from how recently a file changed.",
    elsewhere: "Detection elsewhere leans on file modification times, which go stale and lie about long, quiet turns.",
  },
  {
    icon: PackageOpen,
    lead: "The standard library, and nothing else",
    body: "No pip install and no Node on the server — it's Python 3.10+ and the files Claude Code already writes. Nothing sits between your machine and the CLI at runtime, and you can read the whole server in an afternoon and audit what it touches. (The browser UI is a normal Vite app, built once on first start.)",
    elsewhere: "The comparable web UIs ship a Node server and its dependency tree.",
  },
];

export function Different() {
  return (
    <section id="different" className="relative scroll-mt-20 px-5 py-20 sm:py-28">
      <div className="mx-auto max-w-4xl">
        <SectionHead
          eyebrow="Why this one"
          title="Five things the other dashboards don't do."
          lede="Session lists, file explorers, git panes, worktrees, live subagent feeds — plenty of good tools have those, so they're not the pitch. These five are the reasons to pick this one."
        />

        <ol className="mt-12 space-y-3">
          {POINTS.map((p, i) => (
            <Reveal key={p.lead} delay={Math.min(i, 4) * 60}>
              <li className="panel panel-hover brackets p-5 sm:p-6">
                <div className="flex gap-4 sm:gap-5">
                  <span
                    className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[color-mix(in_srgb,var(--acc)_28%,transparent)] bg-[color-mix(in_srgb,var(--acc)_8%,transparent)] text-[var(--acc)] sm:flex"
                    aria-hidden
                  >
                    <p.icon size={18} />
                  </span>

                  <div className="min-w-0">
                    <h3 className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[1.02rem] leading-snug font-semibold text-[var(--txb)] sm:text-[1.1rem]">
                      <span className="glow-acc">{p.lead}</span>
                      {p.soon && <Soon />}
                    </h3>
                    <p className="mt-2.5 text-[0.85rem] leading-relaxed text-[var(--txm)]">
                      {p.body}
                    </p>
                    <p className="mt-3 flex gap-2 border-t border-[var(--border-soft)] pt-3 text-[0.75rem] leading-relaxed text-[var(--txd)]">
                      <span className="shrink-0 font-mono text-[0.65rem] tracking-widest text-[var(--txd)] uppercase">
                        Elsewhere
                      </span>
                      <span>{p.elsewhere}</span>
                    </p>
                  </div>
                </div>
              </li>
            </Reveal>
          ))}
        </ol>
      </div>
    </section>
  );
}
