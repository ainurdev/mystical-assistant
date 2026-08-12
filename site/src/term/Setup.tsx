import { Cmd } from "./Cmd";
import { Head } from "./Head";
import { Reveal } from "@/components/Reveal";
import { CLAUDE_CODE_URL, INSTALL_COMMAND } from "@/site";

const NEEDS = [
  ["claude CLI", "installed and logged in", "reuses that login — no API key"],
  ["Python 3.10+", "runs the bridge", "stdlib only, nothing to pip install"],
  ["npm", "builds the UI on first start", "the build only; nothing Node runs after"],
  ["A Telegram account", "for the phone surfaces", "setup asks for a bot token"],
];

const STEPS = [
  ["Clone it and run setup.sh", "It checks what it needs before it changes anything, and a second pass only asks for what is still missing."],
  ["Answer six questions", "Bot token, projects root, permission posture, Mini App, free-provider fallback, start now. Everything else runs itself."],
  ["Open the URL it prints", "It reads the sessions already on your machine, so there is something to look at a minute after it starts."],
];

export function Setup() {
  return (
    <section id="setup" className="shell scroll-mt-24 pt-28 sm:pt-36">
      <Reveal>
        <Head
          path="~/setup"
          title="Two minutes, and it has something to show you"
          deck="Nothing gets migrated. Point it at the folder your repos live in and it picks up the sessions already there."
        />
      </Reveal>

      <div className="g12 mt-14 items-start gap-y-12">
        <div className="col-span-12 lg:col-span-7">
          <Reveal>
            <Cmd command={INSTALL_COMMAND} />
          </Reveal>

          <ol className="mt-10 border-t border-[var(--rule)]">
            {STEPS.map(([title, body], i) => (
              <Reveal key={title} delay={i * 50}>
                <li className="row flex gap-5 border-t-0 py-6">
                  <span className="font-display text-[1.5rem] leading-none font-extrabold text-transparent [font-stretch:75%] [-webkit-text-stroke:1px_var(--live)]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="min-w-0">
                    <p className="h4">{title}</p>
                    <p className="body mt-2 max-w-[52ch] text-[0.84rem]">{body}</p>
                  </div>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>

        <div className="col-span-12 lg:col-span-5">
          <Reveal delay={100}>
            <div className="win">
              <div className="win-bar">
                <span className="font-mono text-[0.66rem] tracking-[0.06em] text-[var(--ink-dim)]">
                  <span className="text-[var(--ink-ghost)]">▸ </span>prerequisites
                </span>
                <span className="tag st-idle">4 checks</span>
              </div>
              <dl className="divide-y divide-[var(--rule)]">
                {NEEDS.map(([what, why, note]) => (
                  <div key={what} className="px-4 py-3.5">
                    <dt className="font-mono text-[0.78rem] font-bold text-[var(--ink)]">
                      {what === "claude CLI" ? (
                        <a href={CLAUDE_CODE_URL} target="_blank" rel="noreferrer" className="link">
                          {what}
                        </a>
                      ) : (
                        what
                      )}
                    </dt>
                    <dd className="mt-1 font-mono text-[0.68rem] leading-[1.65] text-[var(--ink-dim)]">
                      {why} — <span className="text-[var(--ink-2)]">{note}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            <p className="mt-4 border-l-2 border-[var(--wait)] pl-4 font-mono text-[0.68rem] leading-[1.7] text-[var(--ink-dim)]">
              <span className="text-[var(--wait)]">Heads up.</span> The project began as a Telegram
              bridge, so setup still requires a bot token even if you only want the dashboard.
              Making it optional is on the list; until then a throwaway bot takes a minute and
              nothing will message it.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
