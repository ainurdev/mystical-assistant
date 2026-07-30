import { Reveal } from "@/components/Reveal";

export function Problem() {
  return (
    <section className="relative px-5 py-20 sm:py-28">
      <div className="mx-auto grid max-w-5xl gap-10 md:grid-cols-2 md:items-center md:gap-16">
        <Reveal>
          <div>
            <p className="eyebrow mb-4">The gap this closes</p>
            <h2 className="h2">Which window was that running in?</h2>
            <div className="lede mt-5 space-y-4">
              <p>
                One session in VS Code, one in a terminal tab behind three others, one in a repo you
                opened this morning and forgot. Claude Code is happy to run all of them. It just
                won't tell you they exist.
              </p>
              <p className="text-[var(--txh)]">
                So the dashboard asks your machine directly. It reads Claude Code's own session
                registry, checks whether each process is actually alive, and puts the answer in one
                list — which repo, which branch, how long, and whether it's working or waiting on
                you.
              </p>
            </div>
          </div>
        </Reveal>

        <Reveal delay={100}>
          <div className="panel panel-lit brackets p-5 sm:p-6">
            <p className="eyebrow mb-4">Before / after</p>
            <div className="space-y-4">
              <Row
                bad
                label="Before"
                items={[
                  "Alt-tab through every window to find the live one",
                  "No idea which repo a session belongs to",
                  "Find out it stopped for an answer 20 minutes ago",
                ]}
              />
              <div className="rule" />
              <Row
                label="After"
                items={[
                  "One list of everything alive, per repo and branch",
                  "Sessions grouped by project, with turns and cost",
                  "A marker on anything sitting there waiting on you",
                ]}
              />
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Row({ label, items, bad }: { label: string; items: string[]; bad?: boolean }) {
  const tone = bad ? "var(--err)" : "var(--ok)";
  return (
    <div>
      <p
        className="mb-2 font-[var(--mono)] text-[0.6rem] tracking-[0.2em] uppercase"
        style={{ color: tone }}
      >
        {label}
      </p>
      <ul className="space-y-1.5">
        {items.map((t) => (
          <li key={t} className="flex gap-2.5 text-[0.82rem] leading-relaxed text-[var(--txm)]">
            <span aria-hidden className="mt-[0.45rem] h-1 w-1 shrink-0 rounded-full" style={{ background: tone }} />
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}
