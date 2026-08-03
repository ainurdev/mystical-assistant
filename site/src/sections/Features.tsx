import type { ReactNode } from "react";
import { LimitLadder, StateLedger } from "@/components/FeatureFigures";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";

/**
 * This runs directly after the hero, so it's the pitch, not an appendix — the
 * order is the argument: see everything running, catch up on one of them, work
 * the project, run two at once, move fast, survive a limit.
 *
 * Eight features carry a picture, the rest carry a title — fourteen equal
 * paragraphs read as a spec sheet and got skimmed, so the section is written to
 * be scanned: the title is the claim, and anything under it is a tail short
 * enough to take in without stopping.
 *
 * Titles are short on purpose. If one needs a sentence to make sense, the title
 * is wrong — rewrite the title rather than growing the line under it.
 *
 * Everything here is reachable today and checkable in the source; the small ones
 * are what makes it stay open all day, not padding for a count. Nothing
 * aspirational goes in this section.
 *
 * Shots are real captures off a running install (`site/tools/shot/`), clipped to
 * the panel rather than the whole 1512×950 window — a full dashboard shrunk into
 * seven columns is unreadable, which defeats the point of showing it. Repo names
 * are swapped for a demo set. They go stale when the UI moves; re-take them
 * rather than writing around them.
 */
// Either a capture (src + its pixel size) or a drawn figure — see
// components/FeatureFigures.tsx for why two of them are drawn. `alt` describes
// whichever it is.
type Shown = {
  title: string;
  line: string;
  alt: string;
  src?: string;
  w?: number;
  h?: number;
  figure?: ReactNode;
};

const SHOWN: Shown[] = [
  {
    title: "Every session, and where",
    line: "Grouped by repo, live or idle. Nothing hides in a terminal tab you closed.",
    src: "./shots/sessions.png",
    w: 1148,
    h: 883,
    alt: "The dashboard with the session rail switched to BY PROJECT: each repo with its session count and the live or idle state of each session.",
  },
  {
    title: "You know the second one needs you",
    line: "Every row carries its own state — WORK, WAIT, LIVE, IDLE, DONE — so the one stopped on a question or an approval says so, in a list you already have open. Telegram pings you with which session it was, whether or not you're at the dashboard.",
    figure: <StateLedger />,
    alt:
      "Five session rows, one per state: WORK, WAIT, LIVE, DONE and IDLE, with the WAIT row in amber and the same alert repeated as a Telegram message.",
  },
  {
    title: "Skim a session in seconds",
    line: "Checkpoints list every prompt, every question it asked and every mid-run steer. Jump to one instead of scrolling an hour of transcript.",
    src: "./shots/checkpoints.png",
    w: 1148,
    h: 700,
    alt: "The checkpoints dropdown open over a session, listing its prompts and questions in order.",
  },
  {
    title: "Two features at once",
    line: "Branch into its own worktree from here, with session, diff and shell already pointed at it. No stashing, no second clone.",
    src: "./shots/worktrees.png",
    w: 1760,
    h: 1280,
    alt: "The WORKTREES tab: six branches each checked out in their own worktree, with their own sessions and ahead/behind counts, one row expanded onto its directory and merge target, and a box to open a new branch in its own checkout.",
  },
  {
    title: "The project, not just the chat",
    line: "Diff, editor, terminal, issues and a map of the repo, beside the session that's changing them. Read the hunks, write the commit, push.",
    src: "./shots/git.png",
    w: 1586,
    h: 996,
    alt: "The GIT tab: changed files with a diff beside them, a commit message box, and push and pull buttons.",
  },
  {
    title: "⌘K and you're there",
    line: "New chat, compact, switch model, jump between chat and history. It all runs on localhost, so nothing waits on a server.",
    src: "./shots/palette.png",
    w: 1176,
    h: 1032,
    alt: "The command palette open over the dashboard, listing session, view and model commands.",
  },
  {
    title: "Limits park the turn",
    line: "Another account of yours, a free agent, or the real reset time off the usage endpoint. Then it picks the turn back up, context intact.",
    figure: <LimitLadder />,
    alt:
      "What a usage limit triggers: the turn is parked, then three rungs — another account of yours, a free agent on another provider, or the reset time itself — plus the retry ladder for server errors.",
  },
  {
    title: "It maps your repo",
    line: "Subsystems, hub files and how they connect, read off tree-sitter ASTs. No embedding bill.",
    src: "./shots/map.png",
    w: 1586,
    h: 996,
    alt: "The MAP tab: a force-directed graph of the repo with a communities list beside it.",
  },
];

/**
 * The ones that are a title, not a picture — grouped by when you'd hit them.
 * The tail is a fragment, never a sentence: twenty explanations is the spec
 * sheet this section is trying not to be.
 */
const REST: { group: string; items: [string, string][] }[] = [
  {
    group: "While a turn is running",
    items: [
      ["Answer it without stopping it", "Permission cards, acted on in place"],
      ["Steer mid-run", "Fold a correction into the live turn"],
      ["See the subagents", "A live feed per agent"],
      ["Watch the context fill", "Per cent, tokens, /compact one tap away"],
      ["Per-message controls", "Model, effort, permission posture"],
      ["Something to watch", "Equaliser, nyan cat, a playable piano"],
    ],
  },
  {
    group: "The queue",
    items: [
      ["Stack the next prompts", "They run in order, unattended"],
      ["Reorder before they run", "Bump, move, edit or drop"],
      ["Retry what failed", "One tap, no retyping"],
      ["Pause the line", "Hold it after the running turn"],
    ],
  },
  {
    group: "Around the session",
    items: [
      ["Sessions name themselves", "Auto-titled, not a wall of UUIDs"],
      ["It remembers the repo", "Keep or skip what it learned"],
      ["Usage in plain sight", "Live 5-hour and 7-day meters"],
      ["A second account", "Overlay profile, first login untouched"],
      ["Issues become prompts", "Through the gh CLI you already authorised"],
      ["Skills, per repo", "Plus a catalog to add more from"],
      ["A real terminal", "xterm.js on the session's own worktree"],
      ["It can look at the page", "A headless shot of your dev server"],
      ["A public preview URL", "cloudflared, no port forwarding"],
      ["The same session on your phone", "A Telegram bot and Mini App"],
      ["Ten display profiles", "Light, dark, CRT scanlines"],
    ],
  },
];

export function Features() {
  return (
    <section id="features" className="shell relative scroll-mt-20 py-24 sm:py-32">
      <SectionHead
        n="01"
        chapter="In the box"
        title="Every one of these started as something missing."
        deck={
          <>
            The eight with a picture are why you'd install it. The rest are why it stays open all
            day. No plans, no free tier, no paid one.
          </>
        }
      />

      <div className="mt-14 sm:mt-20">
        {SHOWN.map((f, i) => {
          // Alternating sides, so the eye zig-zags down the column rather than
          // reading seven identical rows.
          const flip = i % 2 === 1;
          return (
            <Reveal key={f.title}>
              <article className="row g12 items-center gap-y-7 py-10 sm:py-14">
                <figure
                  className={`col-span-12 m-0 lg:col-span-7 ${flip ? "lg:col-start-6" : ""}`}
                >
                  <div className="frame overflow-hidden">
                    {!f.src ? (
                      <div role="img" aria-label={f.alt}>
                        {f.figure}
                      </div>
                    ) : (
                      <img
                        src={f.src}
                        alt={f.alt}
                        width={f.w}
                        height={f.h}
                        loading="lazy"
                        decoding="async"
                        className="block w-full"
                      />
                    )}
                  </div>
                </figure>

                <div
                  className={`col-span-12 lg:col-span-4 ${flip ? "lg:col-start-1 lg:row-start-1" : "lg:col-start-9"}`}
                >
                  {/* The outlined numeral instead of a "01 FEATURE" label: same
                      counter the other sections use, and it carries at a glance. */}
                  <span className="counter block text-[1.7rem]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3 className="h3 mt-4">{f.title}</h3>
                  <p className="body mt-3 max-w-[38ch]">{f.line}</p>
                </div>
              </article>
            </Reveal>
          );
        })}
      </div>

      {REST.map((g) => (
        <Reveal key={g.group}>
          <p className="label row mt-14 pt-4">{g.group}</p>
          <div className="grid gap-x-8 gap-y-7 pt-6 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map(([title, tail]) => (
              <div key={title}>
                <h3 className="flex gap-2.5 text-[1.02rem] leading-tight font-bold tracking-[-0.015em] text-[var(--ink)]">
                  <span aria-hidden className="accent select-none">
                    ▍
                  </span>
                  {title}
                </h3>
                <p className="caption mt-1.5 pl-[1.15rem]">{tail}</p>
              </div>
            ))}
          </div>
        </Reveal>
      ))}
    </section>
  );
}
