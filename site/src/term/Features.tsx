import { Head } from "./Head";
import { Reveal } from "@/components/Reveal";
import { Window } from "./Window";

/**
 * The eight, in the README's own order — and they genuinely are a sequence:
 * this is the order the argument runs in, from "you cannot see your sessions"
 * to "here is the whole repo beside them". The numbering carries that, which is
 * the only reason it is there.
 *
 * Six of the eight land on a real screenshot. The two without are the two whose
 * value is a keystroke or a worktree, and a still frame of either is a lie.
 */
const FEATURES = [
  {
    n: "01",
    title: "Every session, and where",
    state: "Live",
    tone: "live" as const,
    body: "Grouped by repo, live or idle, with anything waiting on an answer flagged. Liveness comes from Claude Code's own registry checked against the OS — a VS Code session shows as running because the process is running.",
    against:
      "Elsewhere: where a session is listed at all it is dated by its transcript's mtime, which goes stale and lies about long, quiet turns.",
    shot: {
      src: "./shots/sessions.png",
      route: "dashboard — sessions · by project",
      alt: "The session rail switched to BY PROJECT: each repo with its session count and the live or idle state of each session.",
    },
  },
  {
    n: "02",
    title: "You know which one needs you",
    state: "Wait",
    tone: "wait" as const,
    body: "Every row carries its own state — WORK, WAIT, LIVE, IDLE, DONE — so the one stopped on a question or an approval says so, in a list you already have open. Telegram pings you with which session it was.",
    shot: {
      src: "./shots/states.png",
      route: "dashboard — session states",
      alt: "The session rail with rows in different states: WORK, WAIT, LIVE, IDLE and DONE.",
    },
  },
  {
    n: "03",
    title: "Skim a session in seconds",
    state: "Done",
    tone: "idle" as const,
    body: "Checkpoints list every prompt, every question it asked and every mid-run steer. Jump to one instead of scrolling an hour of transcript.",
    shot: {
      src: "./shots/checkpoints.png",
      route: "dashboard — checkpoints",
      alt: "The checkpoints dropdown open over a session, listing its prompts and questions in order.",
    },
  },
  {
    n: "04",
    title: "Two features at once",
    state: "Work",
    tone: "work" as const,
    body: "Branch into its own worktree from here, with session, diff and shell already pointed at it. No stashing, no second clone.",
    shot: {
      src: "./shots/worktrees.png",
      route: "workspace — worktrees",
      alt: "The WORKTREES tab: the base branch, the live worktrees under it, and a box to open a new branch in its own checkout.",
    },
  },
  {
    n: "05",
    title: "The project, not just the chat",
    state: "Work",
    tone: "work" as const,
    body: "Diff, editor, terminal, issues and a map of the repo, beside the session that is changing them. Read the hunks, write the commit, push.",
    shot: {
      src: "./shots/git.png",
      route: "workspace — git",
      alt: "The GIT tab: changed files with a diff beside them, a commit message box, and push and pull buttons.",
    },
  },
  {
    n: "06",
    title: "⌘K and you're there",
    state: "Live",
    tone: "live" as const,
    body: "New chat, compact, switch model, jump between chat and history. It all runs on localhost, so nothing waits on a server.",
    shot: {
      src: "./shots/palette.png",
      route: "dashboard — command palette",
      alt: "The command palette open over the dashboard, listing session, view and model commands.",
    },
  },
  {
    n: "07",
    title: "Sessions name themselves",
    state: "Idle",
    tone: "idle" as const,
    body: "Auto-titled from what they are actually doing, not a wall of UUIDs. It remembers what it learned about the repo too, scoped to project and branch, and you keep or skip that.",
  },
  {
    n: "08",
    title: "It maps your repo",
    state: "Done",
    tone: "idle" as const,
    body: "Subsystems, hub files and how they connect, read off tree-sitter ASTs. No LLM pass, no embedding bill.",
    shot: {
      src: "./shots/map.png",
      route: "workspace — map",
      alt: "The MAP tab: a force-directed graph of the repo with a communities list beside it.",
    },
  },
];

export function Features() {
  return (
    <section id="features" className="shell scroll-mt-24 pt-28 sm:pt-36">
      <Reveal>
        <Head
          path="~/features"
          title="Eight things that were missing"
          deck="Every one of these started as something you could not do. The eight below are why you would install it; the rest are why it stays open all day."
        />
      </Reveal>

      <div className="mt-14">
        {FEATURES.map((f, i) => (
          <Reveal key={f.n} delay={i === 0 ? 0 : 60}>
            <article className="row py-10 sm:py-14">
              <div className="g12 items-start">
                <div className="col-span-12 flex items-center justify-between gap-4 lg:col-span-3 lg:block">
                  <span className="font-display text-[2.6rem] leading-none font-extrabold tracking-[-0.05em] text-transparent [font-stretch:75%] [-webkit-text-stroke:1px_var(--ink-ghost)] sm:text-[3.4rem]">
                    {f.n}
                  </span>
                  <span className={`tag st-${f.tone} lg:mt-4 lg:flex`}>{f.state}</span>
                </div>

                <div className="col-span-12 mt-5 lg:col-span-9 lg:mt-0">
                  <h3 className="h3">{f.title}</h3>
                  <p className="body mt-4 max-w-[62ch]">{f.body}</p>
                  {f.against && (
                    <p className="mt-4 max-w-[62ch] border-l-2 border-[var(--rule-hi)] pl-4 font-mono text-[0.68rem] leading-[1.7] text-[var(--ink-dim)] italic">
                      {f.against}
                    </p>
                  )}
                  {f.shot && (
                    <div className="mt-7">
                      <Window
                        route={f.shot.route}
                        state={f.state}
                        tone={f.tone}
                        src={f.shot.src}
                        alt={f.shot.alt}
                      />
                    </div>
                  )}
                </div>
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
