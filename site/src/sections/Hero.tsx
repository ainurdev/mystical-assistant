import { Star } from "lucide-react";
import { Band } from "@/components/Band";
import { CopyCommand } from "@/components/CopyCommand";
import { GithubMark } from "@/components/GithubMark";
import { Reveal } from "@/components/Reveal";
import { INSTALL_COMMAND, REPO_URL } from "@/site";

/**
 * Facts, not adjectives — every number here is checkable against the repo, and
 * that's the bar for anything that goes in this row. If one stops being true,
 * change the number or delete the entry; do not soften it into a claim.
 *
 *   0  → the badge in the README: the server imports nothing off PyPI
 *   1  → the whole positioning, said as a number
 *   3  → account → free agent → the reset (bridge/ladder.py)
 *   14 → the tab list in Workspace.tsx, which is the same list the README ships
 */
const LEDGER = [
  { n: "0", unit: "deps", what: "on the server. Python standard library, end to end." },
  { n: "1", unit: "page", what: "for every session, wherever you started it." },
  { n: "3", unit: "ways on", what: "when a limit lands, before the work is lost." },
  { n: "14", unit: "panes", what: "editor, git, terminal, issues, map, preview." },
];

const PROOF = ["MIT licensed", "No API key", "No account", "No telemetry", "macOS · Linux · WSL"];

export function Hero() {
  return (
    <section id="top" className="relative pt-32 sm:pt-40">
      <div className="shell">
        <div className="g12">
          {/* The headline is offset left and oversized; the deck sits in its own
              columns to the right rather than centred underneath. That asymmetry
              is the layout — a centred hero block would undo the whole page. */}
          <div className="col-span-12 lg:col-span-8">
            <Reveal>
              <p className="label">
                <span className="accent" aria-hidden>
                  ●
                </span>{" "}
                A local dashboard for Claude Code
              </p>
            </Reveal>

            <Reveal delay={60}>
              <h1 className="display mt-7">
                You're running six
                <br />
                Claude Code sessions.
                <br />
                <span className="accent">You can see one.</span>
              </h1>
            </Reveal>

            {/* One primary action on the page, and this is it. It follows the
                headline directly rather than sitting in its own row — the grid
                row is as tall as the deck beside it, so a separate CTA row
                leaves a dead band under the display type. */}
            <Reveal delay={180}>
              <div id="get-started" className="mt-10 max-w-[38rem] scroll-mt-24 sm:mt-12">
                <CopyCommand command={INSTALL_COMMAND} />
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn btn-ghost">
                    <GithubMark />
                    READ THE SOURCE
                  </a>
                  <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn btn-ghost">
                    <Star size={14} aria-hidden />
                    STAR IT
                  </a>
                </div>
              </div>
            </Reveal>
          </div>

          <div className="col-span-12 mt-9 lg:col-span-4 lg:col-start-9 lg:mt-2">
            <Reveal delay={120}>
              <p className="deck max-w-[46ch]">
                The one in VS Code. The one you left in a repo last Tuesday. Claude Code will run
                all of them and never tell you they exist.
              </p>
              <p className="deck mt-4 max-w-[46ch]">
                This reads Claude Code's own session registry and puts every session on one page,
                grouped by repo, marked alive or not. Open one, answer it, carry it on from your
                desk or your phone, without reopening the project it came from.
              </p>
              <p className="body mt-4 max-w-[46ch]">
                When a usage limit kills a turn, it parks the session and finds another way on:
                another Claude account of yours, a free agent, or the reset.
              </p>

              <ul className="mt-7 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-[var(--line)] pt-5">
                {PROOF.map((p) => (
                  <li key={p} className="label text-[0.6rem] normal-case">
                    {p}
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>

        {/* The masthead ledger — four facts, set as figures. Ogilvy's rule that
            specifics sell and adjectives don't, laid out as a row you can read
            in two seconds. */}
        <Reveal delay={240}>
          <dl className="mt-16 grid grid-cols-2 border-t border-[var(--line)] sm:mt-20 lg:grid-cols-4">
            {LEDGER.map((l, i) => (
              <div
                key={l.n}
                className={`border-b border-[var(--line)] py-6 pr-5 lg:py-7 ${
                  i > 0 ? "lg:border-l lg:pl-6" : ""
                } ${i % 2 === 1 ? "border-l pl-5 lg:pl-6" : ""}`}
              >
                <dt className="flex items-baseline gap-2">
                  <span className="font-mono text-[2.4rem] leading-none font-semibold tracking-[-0.05em] text-[var(--ink)] sm:text-[3rem]">
                    {l.n}
                  </span>
                  <span className="label">{l.unit}</span>
                </dt>
                <dd className="caption mt-3 max-w-[26ch]">{l.what}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>

      {/* The first band. Above the fold the strongest thing this page can do is
          show the actual product, so the screenshot is a real capture rather
          than the hand-built HeroMock (still in the repo, unmounted). */}
      <div className="mt-20 sm:mt-28">
        <Band
          priority
          src="./shots/dashboard.png"
          alt="The dashboard: every session on the machine down the left side, a live turn streaming in the middle with model, effort and permission pickers beneath it, and repos grouped by folder on the right."
          kicker="The main screen · 127.0.0.1:8790"
          caption="Every session on the machine, grouped by the repo it belongs to and marked alive or not. VS Code, a terminal, or started right here: they all arrive the same way. Pick one and its whole history is there to read, answer and carry on."
        />
      </div>
    </section>
  );
}
