import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import { CopyCommand } from "@/components/CopyCommand";
import { INSTALL_COMMAND } from "@/site";

const STEPS = [
  {
    n: "01",
    title: "Clone it, run setup",
    body: "One script. It checks the things it needs before it changes anything, and it's safe to re-run — a second pass only asks for what's still missing.",
  },
  {
    n: "02",
    title: "Answer six questions",
    body: "The folder your repos live in, how much autonomy Claude gets — it asks rather than defaulting you into running commands unprompted — and whether to install the free-provider CLI the fallback ladder hands off to. It also wants a Telegram bot token, left over from what this used to be: the dashboard doesn't use it, but setup won't finish without one, so make a throwaway and move on.",
  },
  {
    n: "03",
    title: "Open the dashboard",
    body: "Setup prints the URL at the end, generates its token, and puts mystical on your PATH. Starting the bridge builds the dashboard UI if it's stale, so the first start needs npm and takes a minute longer. It finds the sessions already on your machine straight away.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="relative scroll-mt-20 px-5 py-20 sm:py-28">
      <div className="mx-auto max-w-5xl">
        <SectionHead
          eyebrow="Setup"
          title="Two minutes, then it already has something to show you."
          lede="The claude CLI, Python 3.10+ and npm — the first two you almost certainly have, and the third only builds the dashboard UI. Nothing gets migrated: it reads the sessions that are already on your machine."
        />

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <Reveal key={s.n} delay={i * 90}>
              <div className="panel panel-hover h-full p-5 sm:p-6">
                <span className="font-[var(--mono)] text-2xl text-[color-mix(in_srgb,var(--acc)_45%,transparent)]">
                  {s.n}
                </span>
                <h3 className="mt-3 text-[0.95rem] font-medium text-[var(--txb)]">{s.title}</h3>
                <p className="mt-2 text-[0.82rem] leading-relaxed text-[var(--txm)]">{s.body}</p>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal delay={140}>
          <div className="mx-auto mt-10 max-w-xl">
            <CopyCommand command={INSTALL_COMMAND} />
          </div>
        </Reveal>

        <Reveal delay={180}>
          <div className="mx-auto mt-8 max-w-2xl">
            <p className="eyebrow mb-3 text-center">And then, day to day</p>
            <div className="panel overflow-hidden">
              {[
                ["mystical", "start in the background"],
                ["mystical status", "running? ports, dashboard URL, public link"],
                ["mystical logs", "follow along"],
                ["mystical doctor", "check the prerequisites"],
              ].map(([cmd, what], i) => (
                <div
                  key={cmd}
                  className={`flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-[0.75rem] ${
                    i > 0 ? "border-t border-[var(--border-soft)]" : ""
                  }`}
                >
                  <code className="text-[var(--acc)]">{cmd}</code>
                  <span className="text-[var(--txd)]">{what}</span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
