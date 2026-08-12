import type { CSSProperties } from "react";
import { Head } from "./Head";
import { Reveal } from "@/components/Reveal";
import { Window } from "./Window";

/**
 * The three rungs of bridge/ladder.py, in the order the bridge walks them.
 * Order is the whole content here, so the spine and the travelling pulse are
 * carrying information rather than decorating a list.
 */
const RUNGS = [
  {
    k: "01",
    title: "Another account you own",
    body: "Extra logins live in their own CLAUDE_CONFIG_DIR as thin overlays — that account's credentials are a real file, everything else symlinks back to your ~/.claude. Your existing login is never redirected.",
  },
  {
    k: "02",
    title: "A free agent elsewhere",
    body: "opencode, the open-source CLI itself, run headless on a non-Anthropic provider. Not a second route into your subscription — a different model finishing the turn.",
  },
  {
    k: "03",
    title: "The reset itself",
    body: "The real reset time, read off the usage endpoint rather than guessed. It waits, then picks the turn back up with context intact.",
  },
];

export function Ladder() {
  return (
    <section id="limits" className="shell scroll-mt-24 pt-28 sm:pt-36">
      <Reveal>
        <Head
          path="~/limits"
          title="A limit stops the turn. It shouldn't stop the work."
          deck="Hit a 5-hour or weekly cap and the session is parked, not lost. Parking is the floor — from there it walks a ladder, and each session decides whether it asks first or just switches."
        />
      </Reveal>

      <div className="g12 mt-14 items-start gap-y-12">
        <div className="col-span-12 lg:col-span-7">
          <Reveal>
            {/* The pulse falls down the spine and each rung lights as it passes.
                Staggered animation-delays rather than JS: the sequence is fixed,
                so there is nothing for a timer to decide. */}
            <div className="ladder">
              <p className="ladder-head tag st-wait">Usage limit · turn parked</p>

              <div className="ladder-spine">
                {RUNGS.map((r, i) => (
                  <div
                    key={r.k}
                    className="rung"
                    style={{ "--rd": `${i * 1.15}s` } as CSSProperties}
                  >
                    <span className="rung-dot" aria-hidden />
                    <div className="min-w-0">
                      <p className="flex items-baseline gap-3">
                        <span className="font-mono text-[0.66rem] font-bold text-[var(--ink-ghost)]">
                          {r.k}
                        </span>
                        <span className="h4">{r.title}</span>
                      </p>
                      <p className="body mt-2.5 max-w-[52ch] text-[0.84rem]">{r.body}</p>
                    </div>
                  </div>
                ))}
              </div>

              <p className="ladder-foot tag st-live">Turn resumed · context intact</p>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <p className="mt-8 max-w-[60ch] border-l-2 border-[var(--rule-hi)] pl-4 font-mono text-[0.68rem] leading-[1.7] text-[var(--ink-dim)]">
              Server errors take their own path — the first retry immediate and each repeat longer,
              out to thirty minutes. All of it survives a restart of the bridge.
            </p>
          </Reveal>
        </div>

        <div className="col-span-12 lg:col-span-5">
          <Reveal delay={120}>
            <Window
              route="dashboard — accounts"
              state="Wait"
              tone="wait"
              src="./shots/accounts.png"
              alt="The Accounts tab: an ask / auto / wait picker, a Claude login with quota remaining, and a list of free-agent providers."
            />
            <p className="mt-3 font-mono text-[0.7rem] leading-[1.7] text-[var(--ink-dim)]">
              Ask, auto or wait — per session. Live 5-hour and 7-day meters, per account.
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
