import { Star } from "lucide-react";
import { CopyCommand } from "@/components/CopyCommand";
import { GithubMark } from "@/components/GithubMark";
import { Reveal } from "@/components/Reveal";
import { INSTALL_COMMAND, REPO_URL } from "@/site";

const PROOF = [
  "MIT licensed",
  "Reads the sessions you already have",
  "No API key",
  "Python stdlib only",
];

export function Hero() {
  return (
    <section id="top" className="relative px-5 pt-28 pb-16 sm:pt-36 sm:pb-24">
      <div className="mx-auto max-w-4xl text-center">
        <Reveal>
          <p className="eyebrow mb-5">Open source · a dashboard for Claude Code</p>
        </Reveal>

        <Reveal delay={60}>
          <h1 className="h1">
            Claude stops at your limit.
            <br />
            <span className="glow-acc">This picks the work back up.</span>
          </h1>
        </Reveal>

        <Reveal delay={120}>
          <p className="lede mx-auto mt-6 max-w-2xl">
            A local dashboard for every Claude Code session on your machine, grouped by repo and
            marked alive or not. When a usage limit kills a turn it parks the session and finds a way
            on — another account of yours, a free agent, or the reset — instead of leaving the work dead.
          </p>
        </Reveal>

        <Reveal delay={180}>
          <div id="get-started" className="mx-auto mt-9 max-w-xl scroll-mt-24">
            <CopyCommand command={INSTALL_COMMAND} />
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2.5">
              <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn btn-ghost">
                <GithubMark />
                Read the source
              </a>
              <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn btn-ghost">
                <Star size={15} aria-hidden />
                Star it if it helps
              </a>
            </div>
          </div>
        </Reveal>

        <Reveal delay={240}>
          <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[0.72rem] text-[var(--txd)]">
            {PROOF.map((p) => (
              <li key={p} className="flex items-center gap-1.5">
                <span className="h-1 w-1 rounded-full bg-[var(--acc)]" aria-hidden />
                {p}
              </li>
            ))}
          </ul>
        </Reveal>
      </div>

      {/* A real capture rather than HeroMock, on the theory that the strongest
          thing this page can do above the fold is show the actual product.
          HeroMock is still in the repo, unmounted — see tools/shot/ to re-take
          this when the UI moves. */}
      <Reveal delay={300} className="mt-16 sm:mt-20">
        <div className="relative mx-auto w-full max-w-[62rem]">
          <div className="panel panel-lit overflow-hidden p-1.5 shadow-[0_30px_90px_-20px_rgb(0_0_0/0.9)]">
            <img
              src="./shots/dashboard.png"
              alt="The dashboard: every session on the machine down the left side, a live turn streaming in the middle with model, effort and permission pickers beneath it, and repos grouped by folder on the right."
              width={1512}
              height={950}
              fetchPriority="high"
              decoding="async"
              className="block w-full rounded-[3px]"
              style={{ aspectRatio: "1512 / 950" }}
            />
          </div>
        </div>
      </Reveal>
    </section>
  );
}
