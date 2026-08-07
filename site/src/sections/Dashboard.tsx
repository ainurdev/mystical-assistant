import { Band } from "@/components/Band";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";

/** Two pillars, not three: "the repo, right there" is feature 04 with a picture. */
const PILLARS = [
  {
    title: "Sessions, grouped by repo",
    body: "Every session keyed to the project it belongs to, so a repo's whole history sits in one place: turn counts, cost, which models ran, when it was last touched. No more guessing which of nine was the one.",
  },
  {
    title: "One list of what's alive",
    body: "Read from Claude Code's own session registry and checked against the running process, so liveness is exact rather than a guess from file timestamps. VS Code, terminal, or started here: they all show up the same way.",
  },
];

/**
 * Everything the workspace actually opens: the three main views, the four
 * sidebar panels and the seven tabs in a project's analyze modal (SKILLS is in
 * both). Every name here is reachable today — nothing
 * aspirational goes in this list, and the count is quoted in the hero ledger.
 */
const PANES = [
  "CHAT",
  "HISTORY",
  "PROJECTS",
  "FILES",
  "QUEUE",
  "EDITOR",
  "GIT",
  "WORKTREES",
  "TERMINAL",
  "ISSUES",
  "SKILLS",
  "MAP",
];

/** All four share one SQLite store, which is the only reason the claim holds. */
const SURFACES = [
  {
    name: "Desktop dashboard",
    where: "127.0.0.1:8790",
    what: "Where the work happens. Localhost only, never published.",
  },
  {
    name: "Telegram Mini App",
    where: "bot menu → Open Panel",
    what: "The same panel, off your machine. Prompts, screenshots, live stream, answer cards.",
  },
  {
    name: "Telegram bot",
    where: "DM your bot",
    what: "Quick plain-text prompts when a full panel is more than you need.",
  },
  {
    name: "Native Claude Code",
    where: "the claude you already run",
    what: "Found on its own, and resumable from the three above.",
  },
];

export function Dashboard() {
  return (
    <>
      <section id="workspace" className="shell relative scroll-mt-20 py-24 sm:py-32">
        <SectionHead
          n="02"
          chapter="The workspace"
          title="Everything you'd go looking for is already open."
          deck={
            <>
              It runs on localhost and is never published. Point it at the folder your repos live in
              and it picks up the sessions already there. Nothing to migrate, nothing to re-create,
              and something to show you a minute after it starts.
            </>
          }
        />

        <div className="mt-14 grid sm:mt-20 lg:grid-cols-2">
          {PILLARS.map((p, i) => (
            <Reveal key={p.title} delay={i * 65}>
              <article
                className={`h-full border-t border-[var(--line)] py-7 pr-6 lg:py-8 ${
                  i > 0 ? "lg:border-l lg:pl-7" : ""
                }`}
              >
                <span className="counter text-[1.7rem]">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="mt-5 text-[1.05rem] leading-snug font-semibold text-[var(--ink)]">
                  {p.title}
                </h3>
                <p className="body mt-3">{p.body}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal delay={140}>
          <div className="mt-12 border-t border-[var(--line)] pt-7">
            <p className="label mb-4">Everything the workspace opens</p>
            <ul className="flex flex-wrap gap-x-1.5 gap-y-1.5">
              {PANES.map((name) => (
                <li
                  key={name}
                  className="border border-[var(--line)] px-2 py-1 font-mono text-[0.62rem] tracking-[0.1em] text-[var(--ink-2)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
                >
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={180}>
          <div className="mt-14">
            <p className="label mb-1">Four surfaces, one session store</p>
            <p className="body mb-6 max-w-[62ch]">
              A session started on any of them continues on any other. The run never leaves your
              machine, and there's no app to install.
            </p>
            <dl>
              {SURFACES.map((s, i) => (
                <div
                  key={s.name}
                  className={`row g12 items-baseline gap-y-1 py-4 ${
                    i === SURFACES.length - 1 ? "row-last" : ""
                  }`}
                >
                  <dt className="col-span-12 text-[0.92rem] font-medium text-[var(--ink)] lg:col-span-3">
                    {s.name}
                  </dt>
                  <dd className="col-span-12 font-mono text-[0.68rem] text-[var(--accent)] lg:col-span-3">
                    {s.where}
                  </dd>
                  <dd className="body col-span-12 lg:col-span-6">{s.what}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>
      </section>

      <Band
        src="./shots/themes.png"
        alt="The Appearance tab: ten theme cards split into dark and light, above toggles for CRT scanlines and scan sweep."
        kicker="Appearance · ten display profiles"
        caption="Dark and light, from plain daylight to newsprint to a drafting table, with the CRT effects on their own switches. You'll stare at it all day. It may as well look like something you chose."
      />
    </>
  );
}
