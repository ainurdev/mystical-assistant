import type { CSSProperties } from "react";
import { Cmd } from "./Cmd";
import { Decrypt } from "./Decrypt";
import { Rail } from "./Rail";
import { Reveal } from "@/components/Reveal";
import { Window } from "./Window";
import { GithubMark } from "@/components/GithubMark";
import { INSTALL_COMMAND, REPO_URL } from "@/site";

/**
 * A line of the boot log, typed by clipping its own width in `ch` units. Exact
 * rather than approximate because the face is monospaced, so `1ch` is the glyph
 * advance and `steps(n)` lands one character at a time with no drift.
 */
function Line({ text, delay, tone = "" }: { text: string; delay: number; tone?: string }) {
  return (
    <span
      className={`type ${tone}`}
      style={{ "--n": text.length, "--d": `${delay}ms` } as CSSProperties}
    >
      {text}
    </span>
  );
}

/** Four figures, each checkable against the repo. If one stops being true,
 *  change the number or cut the row — do not soften it into a claim.
 *    0  → the server imports nothing off PyPI
 *    1  → the positioning, said as a number
 *    3  → account → free agent → the reset (bridge/ladder.py)
 *    12 → the tab list the workspace ships */
const LEDGER = [
  { n: "0", unit: "deps", what: "on the server. Python standard library, end to end." },
  { n: "1", unit: "page", what: "for every session, wherever you started it." },
  { n: "3", unit: "ways on", what: "when a limit lands, before the work is lost." },
  { n: "12", unit: "panes", what: "editor, git, terminal, issues, map, skills." },
];

const PROOF = ["MIT licensed", "No API key", "No account", "No telemetry", "macOS · Linux · WSL"];

export function Hero({ active }: { active: number }) {
  return (
    <section id="overview" className="scroll-mt-24">
      <div id="top" className="shell pt-24 [@media(min-width:1120px)]:pt-16">
        {/* The boot log runs before the headline resolves: by the time the type
            has decrypted, the page has already stated the number the headline
            is about to make an argument out of. One orchestrated moment. */}
        {/* Timed so the headline is fully readable at ~1.6s. The boot log and
            the headline deliberately overlap rather than queueing: run them in
            sequence and the h1 — the one thing above the fold that has to be
            read — is noise for three and a half seconds. */}
        <div className="term mb-8 min-h-[5.1rem] leading-[1.75]" aria-hidden>
          <div>
            <Line text="$ mystical status" delay={0} />
          </div>
          <div>
            <Line text="▸ reading ~/.claude/sessions/ .............. ok" delay={340} />
          </div>
          <div>
            <Line text="▸ 6 sessions found · 1 attached · 5 you forgot" delay={700} tone="lit" />
          </div>
        </div>

        <div className="g12">
          <div className="col-span-12 lg:col-span-8">
            <h1 className="display">
              <Decrypt as="div" text="You're running six" delay={900} />
              <Decrypt as="div" text="Claude Code sessions." delay={1040} />
              <Decrypt as="div" text="You can see one." delay={1180} className="lit" />
            </h1>

            <Reveal delay={300}>
              <div className="mt-8 max-w-[38rem] sm:mt-10">
                <Cmd command={INSTALL_COMMAND} />
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn btn-ghost">
                    <GithubMark />
                    Read the source
                  </a>
                  <a href="#features" className="btn btn-ghost">
                    See what it does
                  </a>
                </div>
              </div>
            </Reveal>
          </div>

          <div className="col-span-12 mt-9 lg:col-span-4 lg:col-start-9 lg:mt-1">
            <Reveal delay={200}>
              <p className="deck max-w-[46ch]">
                The one in VS&nbsp;Code. The one you left in a repo last Tuesday. Claude Code runs
                all of them and never tells you they exist.
              </p>
              <p className="body mt-4 max-w-[46ch]">
                This reads Claude Code's own session registry and puts every session on one page,
                grouped by repo, marked alive or not. Open one, answer it, carry it on — from your
                desk or your phone, without reopening the project it came from.
              </p>

              <ul className="mt-6 flex flex-wrap gap-x-4 gap-y-1.5 border-t border-[var(--rule)] pt-4">
                {PROOF.map((p) => (
                  <li key={p} className="font-mono text-[0.62rem] text-[var(--ink-dim)]">
                    {p}
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>

        {/* Phones get the rail here, as a demonstration rather than as
            navigation — six rows, one lit, which is the headline. */}
        <Reveal delay={120} className="mt-10">
          <Rail active={active} inline />
        </Reveal>

        <Reveal delay={160}>
          <dl className="mt-14 grid grid-cols-2 border-t border-[var(--rule)] lg:grid-cols-4">
            {LEDGER.map((l, i) => (
              <div
                key={l.n}
                className={`border-b border-[var(--rule)] py-5 pr-5 lg:py-6 ${
                  i > 0 ? "lg:border-l lg:pl-6" : ""
                } ${i % 2 === 1 ? "border-l pl-5 lg:pl-6" : ""}`}
              >
                <dt className="flex items-baseline gap-2">
                  <span className="font-display text-[2.1rem] leading-none font-extrabold tracking-[-0.05em] text-[var(--ink)] [font-stretch:75%] sm:text-[2.7rem]">
                    {l.n}
                  </span>
                  <span className="label">{l.unit}</span>
                </dt>
                <dd className="mt-2.5 max-w-[26ch] font-mono text-[0.7rem] leading-[1.6] text-[var(--ink-dim)]">
                  {l.what}
                </dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>

      <Reveal className="shell mt-12 sm:mt-16">
        <Window
          priority
          route="127.0.0.1:8790 — dashboard"
          state="Live"
          src="./shots/dashboard.png"
          alt="The dashboard: every session on the machine down the left side, a live turn streaming in the middle with model, effort and permission pickers beneath it, and repos grouped by folder on the right."
        />
        <p className="mt-3 max-w-[70ch] font-mono text-[0.7rem] leading-[1.7] text-[var(--ink-dim)]">
          Every session on the machine, grouped by the repo it belongs to and marked alive or not.
          VS&nbsp;Code, a terminal, or started right here — they all arrive the same way.
        </p>
      </Reveal>
    </section>
  );
}
