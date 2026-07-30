import { MessageSquare } from "lucide-react";
import { CopyCommand } from "@/components/CopyCommand";
import { GithubMark } from "@/components/GithubMark";
import { Reveal } from "@/components/Reveal";
import { INSTALL_COMMAND, ISSUES_URL, REPO_URL } from "@/site";

export function FinalCta() {
  return (
    <section className="relative px-5 py-20 sm:py-28">
      <Reveal>
        <div className="panel panel-lit brackets mx-auto max-w-3xl px-6 py-12 text-center sm:px-10 sm:py-16">
          <img
            src="./mystical.svg"
            alt=""
            width={56}
            height={56}
            aria-hidden
            className="mx-auto mb-7 opacity-90"
          />
          <h2 className="h2">
            Stop losing turns to <span className="glow-violet">a limit you can't see.</span>
          </h2>
          <p className="lede mx-auto mt-4 max-w-lg">
            One clone and one script. It reads the sessions you've already got, so it has something
            to show you a minute after it starts. If you don't like it, it's a folder you can
            delete.
          </p>

          <div className="mx-auto mt-8 max-w-lg">
            <CopyCommand command={INSTALL_COMMAND} />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn btn-ghost">
              <GithubMark />
              Browse the source
            </a>
            <a href={ISSUES_URL} target="_blank" rel="noreferrer" className="btn btn-ghost">
              <MessageSquare size={15} aria-hidden />
              Ask a question
            </a>
          </div>

          <p className="mt-7 text-[0.72rem] text-[var(--txd)]">
            Needs the claude CLI, Python 3.10+ and npm. Everything else, setup handles.
          </p>
        </div>
      </Reveal>
    </section>
  );
}
