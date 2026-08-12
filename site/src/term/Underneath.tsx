import { Head } from "./Head";
import { Reveal } from "@/components/Reveal";
import { Window } from "./Window";

/** The other side of the `dependencies: 0` badge: the server needs nothing
 *  installed *because* the work goes to tools already on your machine. */
const STACK = [
  ["Editor", "CodeMirror 6", "Selection, folding and keymaps behave the way they do everywhere else CodeMirror runs."],
  ["Terminal", "xterm.js", "In front of a real PTY. Curses apps and colour work because it is a terminal, not a command box."],
  ["Git · Worktrees", "your git", "Invoked the way you would invoke it. Nothing is modelled twice, so nothing drifts."],
  ["Issues", "the gh CLI", "Under the auth you already granted it. No second token to mint."],
  ["Map", "graphify", "Repo structure from tree-sitter ASTs. No LLM pass, no embedding bill."],
  ["Skills", "community SKILL.md", "Installing one downloads the maintained original from GitHub, verbatim."],
  ["The engine", "claude", "The CLI you already logged into, reading the transcripts it already writes."],
  ["Fallback", "opencode", "The open-source CLI itself, headless on a free provider."],
];

export function Underneath() {
  return (
    <section id="underneath" className="shell scroll-mt-24 pt-28 sm:pt-36">
      <Reveal>
        <Head
          path="~/underneath"
          title="Nothing here is a homemade version of a tool you already use"
          deck="Where a good one exists, that is the one running. Where the work belongs on your machine, it is your git, your gh and your claude login doing it."
        />
      </Reveal>

      <div className="g12 mt-14 items-start gap-y-12">
        <div className="col-span-12 lg:col-span-7">
          <dl className="border-t border-[var(--rule)]">
            {STACK.map(([pane, runs, why], i) => (
              <Reveal key={pane} delay={i < 3 ? 0 : 40}>
                <div className="row flex flex-wrap items-baseline gap-x-4 gap-y-1.5 border-t-0 py-4">
                  <dt className="label w-[8.5rem] shrink-0 text-[var(--ink-dim)]">{pane}</dt>
                  <dd className="min-w-0 flex-1">
                    <span className="font-mono text-[0.86rem] font-bold text-[var(--live)]">
                      {runs}
                    </span>
                    <span className="body mt-1 block text-[0.82rem]">{why}</span>
                  </dd>
                </div>
              </Reveal>
            ))}
          </dl>
        </div>

        <div className="col-span-12 lg:col-span-5">
          <Reveal delay={100}>
            <Window
              route="workspace — terminal"
              state="Live"
              src="./shots/terminal.png"
              alt="The TERMINAL tab: xterm.js running a real shell on the session's own worktree."
            />
            <p className="mt-3 font-mono text-[0.7rem] leading-[1.7] text-[var(--ink-dim)]">
              A real PTY on the session's own worktree. The browser UI is a normal Vite app, built
              once on first start — nothing Node runs at runtime.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
