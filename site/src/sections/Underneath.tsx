import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";

/**
 * The reason-to-believe section: every pane names the real tool behind it.
 *
 * Each row is a claim someone can check by reading the source, so keep them
 * that way — no "powered by" logos for things that aren't actually running.
 * The closing note is load-bearing: without it this section reads as a
 * contradiction of the dependencies-0 claim in Different.tsx, when in fact
 * it's the same point (nothing reimplemented, nothing bundled).
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
    body: "Repo structure read from tree-sitter ASTs — no LLM pass and no embedding bill to see how a codebase fits together.",
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
    body: "When every Claude account you own is out of quota, a parked turn can go to opencode on a free provider — the open-source CLI itself, run headlessly. Not a second route into your subscription.",
  },
];

export function Underneath() {
  return (
    <section id="underneath" className="relative scroll-mt-20 px-5 py-20 sm:py-28">
      <div className="mx-auto max-w-4xl">
        <SectionHead
          eyebrow="What's underneath"
          title={
            <>
              The editor is <span className="glow-acc">CodeMirror</span>. The terminal is{" "}
              <span className="glow-acc">xterm.js</span>.
            </>
          }
          lede="No pane here is a homemade version of a tool you already use. Where a good one exists, that's the one running — and where the work belongs on your machine, it's your git, your gh, your claude login doing it. You inherit what each of them is already good at: the keybindings you know still work, curses apps still draw, and no pane is the one you put up with."
        />

        <Reveal delay={80}>
          <div className="panel brackets mt-12 p-5 sm:p-7">
            <dl className="divide-y divide-[var(--border-soft)]">
              {STACK.map((s) => (
                <div key={s.pane} className="grid gap-1.5 py-4 first:pt-0 last:pb-0 sm:grid-cols-[9.5rem_1fr] sm:gap-5">
                  <dt className="font-mono text-[0.62rem] tracking-[0.14em] text-[var(--txd)] sm:pt-0.5">
                    {s.pane}
                  </dt>
                  <dd className="min-w-0">
                    <span className="text-[0.9rem] font-medium text-[var(--txb)]">{s.tool}</span>
                    <p className="mt-1.5 text-[0.8rem] leading-relaxed text-[var(--txm)]">
                      {s.body}
                    </p>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </Reveal>

        <Reveal delay={160}>
          <p className="mx-auto mt-6 max-w-2xl text-center text-[0.8rem] leading-relaxed text-[var(--txd)]">
            This is the same claim as{" "}
            <a href="#different" className="text-[var(--txm)] underline underline-offset-4 decoration-[var(--border-soft)] transition-colors hover:text-[var(--txb)]">
              zero dependencies
            </a>
            , seen from the other side: the server needs nothing installed{" "}
            <em className="text-[var(--txm)] not-italic">because</em> the work goes to tools that
            are already on your machine, and the browser panes are the real projects rather than
            lookalikes. Nothing reimplemented, nothing bundled.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
