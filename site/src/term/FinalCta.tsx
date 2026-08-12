import { Cmd } from "./Cmd";
import { Decrypt } from "./Decrypt";
import { GithubMark } from "@/components/GithubMark";
import { Reveal } from "@/components/Reveal";
import { INSTALL_COMMAND, REPO_URL } from "@/site";

export function FinalCta() {
  return (
    <section className="shell pt-28 pb-24 sm:pt-36">
      <Reveal>
        <div className="border-t border-[var(--rule-hi)] pt-12">
          <p className="label">
            <span className="text-[var(--ink-ghost)]">▸ </span>one page for all of them
          </p>

          {/* The headline resolves a second time here, on scroll rather than on
              load — the page opened on the claim and closes on it. */}
          <h2 className="display mt-6 max-w-[16ch]">
            <Decrypt as="div" text="Go and look" />
            <Decrypt as="div" text="at the other five." delay={220} className="lit" />
          </h2>

          <div className="g12 mt-10 items-end gap-y-6">
            <div className="col-span-12 lg:col-span-7">
              <Cmd command={INSTALL_COMMAND} />
            </div>
            <div className="col-span-12 lg:col-span-5">
              <p className="body max-w-[42ch]">
                Six questions, then it reads the sessions you already have. MIT licensed, no
                account, no telemetry, and nothing to migrate.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <a href={REPO_URL} target="_blank" rel="noreferrer" className="btn btn-ghost">
                  <GithubMark />
                  Read the source
                </a>
              </div>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
