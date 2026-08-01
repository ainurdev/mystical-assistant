import { CopyCommand } from "@/components/CopyCommand";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import { INSTALL_COMMAND } from "@/site";

const STEPS = [
  {
    title: "Clone it, run setup",
    body: "One script. It checks what it needs before it changes anything, and a second pass only asks for what's still missing.",
  },
  {
    title: "Answer six questions",
    body: "The folder your repos live in, how much autonomy Claude gets (it asks rather than defaulting you into unattended commands), and whether to install the free-provider CLI the ladder hands off to. It also wants a Telegram bot token, which the FAQ below explains.",
  },
  {
    title: "Open the dashboard",
    body: "Setup prints the URL at the end, generates its token, and puts mystical on your PATH. The first start builds the dashboard UI, so it needs npm and takes a minute longer.",
  },
];

const DAILY: [string, string][] = [
  ["mystical", "start in the background"],
  ["mystical status", "running? ports, dashboard URL, public link"],
  ["mystical logs", "follow along"],
  ["mystical doctor", "check the prerequisites"],
];

export function HowItWorks() {
  return (
    <section id="setup" className="shell relative scroll-mt-20 py-24 sm:py-32">
      <SectionHead
        n="04"
        chapter="Setup"
        title="Two minutes, and it has something to show you."
        deck={
          <>
            The claude CLI, Python 3.10+ and npm. You already have the first two, and the third only
            builds the dashboard UI. Nothing gets migrated: it reads the sessions already on your
            machine.
          </>
        }
      />

      <div className="mt-14 sm:mt-20">
        {STEPS.map((s, i) => (
          <Reveal key={s.title} delay={i * 70}>
            <div className={`row g12 gap-y-3 py-7 ${i === STEPS.length - 1 ? "row-last" : ""}`}>
              <div className="col-span-12 lg:col-span-3">
                <span className="counter">{String(i + 1).padStart(2, "0")}</span>
              </div>
              <div className="col-span-12 lg:col-span-8 lg:col-start-5">
                <h3 className="text-[1.05rem] font-semibold text-[var(--ink)]">{s.title}</h3>
                <p className="body mt-2.5 max-w-[64ch]">{s.body}</p>
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      <div className="g12 mt-12">
        <Reveal delay={100} className="col-span-12 lg:col-span-7">
          <CopyCommand command={INSTALL_COMMAND} />
          <p className="caption mt-3">macOS, Linux and WSL. Re-run it any time.</p>
        </Reveal>

        <Reveal delay={150} className="col-span-12 mt-8 lg:col-span-4 lg:col-start-9 lg:mt-0">
          <p className="label mb-3">And then, day to day</p>
          <dl>
            {DAILY.map(([cmd, what], i) => (
              <div
                key={cmd}
                className={`flex flex-wrap items-baseline gap-x-3 border-[var(--line)] py-2 ${
                  i > 0 ? "border-t" : ""
                }`}
              >
                <dt className="font-mono text-[0.72rem] text-[var(--accent)]">{cmd}</dt>
                <dd className="caption">{what}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </section>
  );
}
