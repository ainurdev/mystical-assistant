import { MessageSquare } from "lucide-react";
import { CopyCommand } from "@/components/CopyCommand";
import { GithubMark } from "@/components/GithubMark";
import { Reveal } from "@/components/Reveal";
import { INSTALL_COMMAND, ISSUES_URL, REPO_URL } from "@/site";

export function FinalCta() {
  return (
    <section className="relative border-t border-[var(--line)] bg-[var(--bg-sunk)]">
      <div className="shell py-24 sm:py-32">
        <div className="g12">
          <div className="col-span-12 lg:col-span-7">
            <Reveal>
              <p className="chapter">
                <span className="chapter-n" aria-hidden>
                  ◆
                </span>{" "}
                Get started
              </p>
              <h2 className="display mt-7 text-[clamp(2.4rem,6vw,4.6rem)]">
                Stop hunting for
                <br />
                <span className="accent">the window it's in.</span>
              </h2>
            </Reveal>
          </div>

          <div className="col-span-12 mt-8 lg:col-span-4 lg:col-start-9 lg:mt-2">
            <Reveal delay={80}>
              <p className="deck max-w-[44ch]">
                One clone and one script. It reads the sessions you've already got, so there's
                something to see a minute after it starts.
              </p>
              <p className="body mt-4 max-w-[44ch]">
                If you don't like it, it's a folder you can delete. Nothing was migrated and nothing
                was signed up for.
              </p>
            </Reveal>
          </div>
        </div>

        <Reveal delay={140}>
          <div className="g12 mt-12">
            <div className="col-span-12 lg:col-span-7">
              <CopyCommand command={INSTALL_COMMAND} />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn btn-ghost">
                  <GithubMark />
                  BROWSE THE SOURCE
                </a>
                <a href={ISSUES_URL} target="_blank" rel="noreferrer" className="btn btn-ghost">
                  <MessageSquare size={14} aria-hidden />
                  ASK A QUESTION
                </a>
              </div>
            </div>
            <p className="caption col-span-12 mt-6 max-w-[40ch] self-end lg:col-span-4 lg:col-start-9 lg:mt-0">
              Needs the claude CLI, Python 3.10+ and npm. Everything else, setup handles. macOS,
              Linux and WSL.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
