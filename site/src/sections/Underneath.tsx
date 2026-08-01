import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";

/**
 * The reason-to-believe section: every pane names the real tool behind it.
 *
 * Each row is a claim someone can check by reading the source, so keep them
 * that way — no "powered by" logos for things that aren't actually running.
 * The closing note is load-bearing: without it this section reads as a
 * contradiction of the hero's "0 deps" figure, when in fact it's the same point
 * (nothing reimplemented, nothing bundled).
 */
const STACK: { pane: string; tool: string; body: string }[] = [
  {
    pane: "EDITOR",
    tool: "CodeMirror 6",
    body: "Selection, folding and keymaps behave the way they do everywhere else CodeMirror runs. JavaScript, TypeScript, Python, HTML, CSS, JSON and Markdown ship with it.",
  },
  {
    pane: "TERMINAL",
    tool: "xterm.js",
    body: "The emulator VS Code's integrated terminal is built on, in front of a real PTY on your machine. Curses apps and colour work because it's a terminal, not a command box.",
  },
  {
    pane: "GIT · WORKTREES",
    tool: "your git",
    body: "Diffs, branches, stashes and worktrees are the git already on your PATH, invoked the way you'd invoke it. Nothing is modelled twice, so nothing drifts.",
  },
  {
    pane: "ISSUES",
    tool: "the gh CLI",
    body: "Issues and pull requests go through GitHub's official CLI, under the auth you already granted it. No second token to mint, no OAuth app to trust.",
  },
  {
    pane: "MAP",
    tool: "graphify",
    body: "Repo structure read from tree-sitter ASTs. No LLM pass and no embedding bill to see how a codebase fits together.",
  },
  {
    pane: "PREVIEW",
    tool: "cloudflared",
    body: "Cloudflare's own tunnel client. Your dev server reaches your phone without opening a port on your router.",
  },
  {
    pane: "SKILLS",
    tool: "community SKILL.md",
    body: "Installing a community skill downloads the maintained original from GitHub, verbatim. You get the author's file, not our paraphrase of it.",
  },
  {
    pane: "THE ENGINE",
    tool: "claude",
    body: "The bridge shells out to the CLI you already logged into and reads the transcripts it already writes. No API key, and no wrapper sitting between you and the model.",
  },
  {
    pane: "FALLBACK",
    tool: "opencode",
    body: "When every Claude account you own is out of quota, a parked turn can go to opencode on a free provider: the open-source CLI itself, run headless. Not a second route into your subscription.",
  },
];

export function Underneath() {
  return (
    <section id="underneath" className="shell relative scroll-mt-20 py-24 sm:py-32">
      <SectionHead
        n="03"
        chapter="What's underneath"
        title={
          <>
            The editor is <span className="accent">CodeMirror</span>. The terminal is{" "}
            <span className="accent">xterm.js</span>.
          </>
        }
        deck={
          <>
            No pane here is a homemade version of a tool you already use. Where a good one exists,
            that's the one running. Where the work belongs on your machine, it's your git, your gh
            and your claude login doing it, so the keybindings you know still work and curses apps
            still draw.
          </>
        }
      />

      <dl className="mt-14 sm:mt-20">
        {STACK.map((s, i) => (
          <Reveal key={s.pane} delay={Math.min(i, 5) * 45}>
            <div className={`row g12 gap-y-2 py-6 ${i === STACK.length - 1 ? "row-last" : ""}`}>
              <dt className="label col-span-12 pt-1 lg:col-span-3">{s.pane}</dt>
              <dd className="col-span-12 lg:col-span-8 lg:col-start-5">
                <span className="text-[1rem] font-medium text-[var(--ink)]">{s.tool}</span>
                <p className="body mt-2 max-w-[64ch]">{s.body}</p>
              </dd>
            </div>
          </Reveal>
        ))}
      </dl>

      <Reveal delay={120}>
        <p className="deck mt-10 max-w-[64ch]">
          This is the other side of{" "}
          <a href="#top" className="link">
            0 deps
          </a>{" "}
          up in the masthead: the server needs nothing installed{" "}
          <em className="text-[var(--ink)] not-italic">because</em> the work goes to tools already
          on your machine. Nothing reimplemented, nothing bundled.
        </p>
      </Reveal>
    </section>
  );
}
