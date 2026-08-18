import { Plus } from "lucide-react";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import { Soon } from "@/components/Soon";

/**
 * Keep these in sync with the FAQPage JSON-LD in index.html, verbatim.
 *
 * Nothing here restates a section above it. "Is the dashboard exposed?" was
 * answered word for word in Security, so it's gone rather than duplicated for
 * the accordion.
 */
const FAQ: { q: string; a: string; soon?: boolean }[] = [
  {
    q: "Do I need an Anthropic API key?",
    a: "No. It shells out to the claude CLI already on your machine and reuses the login you set up the first time you ran it. There's no key to paste anywhere, and no account to make here.",
  },
  {
    q: "What does it install?",
    a: "Nothing to pip install: the server is Python 3.10+ standard library only. The dashboard UI is a Vite app the bridge builds on first start, so you do need npm on the machine; after that it rebuilds only when the sources change.",
  },
  {
    q: "Does it work with the Claude Code I already run in VS Code?",
    a: "That's the main point of it. Sessions under your projects folder are read from Claude Code's own transcripts, and liveness comes from its session registry checked against the real process. A VS Code or terminal session shows as running because it is, not because a file looked recent. Continue one and it carries on from there.",
  },
  {
    q: "What actually happens when I hit a usage limit?",
    a: "The session gets parked rather than dropped, then it looks for a way to keep going: another Claude account of yours with quota left, a free agent on a different provider, or failing both, the reset itself. It reads the reset time from the usage endpoint, waits, and resumes the turn with its context intact. You set whether it asks first, switches on its own, or only ever waits, per session or as the default. Server errors (500, 529, and the 429 that isn't a usage limit) take a separate path: the first retry is immediate and each repeat waits longer, out to thirty minutes. All of it is persisted, so restarting the bridge mid-wait doesn't lose it.",
  },
  {
    q: "Can it use a second Claude account?",
    a: "Yes, if you have one. Add it from the dashboard's Accounts tab: a sign-in link opens, you log in as that account, you paste the code back. Each account lives in its own profile directory, so the login you already had is never touched, and every turn is still the real claude binary spawned per run with that profile. Nothing proxies or pools tokens. When a limit hits, the account with the most quota left goes first, and its meter sits next to the others in that tab.",
  },
  {
    q: "Where does my code actually go?",
    a: "It stays on your machine, and there's no telemetry: the dashboard talks only to localhost, and nothing is sent anywhere the claude CLI wasn't already sending it. One caveat: the auto-title and new-session checks each run a cheap Haiku pass through your CLI after a turn, so they do send that turn's output to Anthropic in a second call. TITLE_ENABLE=0 and RELEVANCE_CHECK=0 turn them off individually.",
  },
  {
    q: "Can I drive it from my phone without Telegram?",
    a: "Not yet. Remote control today goes through Telegram: the bot for quick prompts, the Mini App for the full panel. The dashboard never leaves localhost by design. A signed-in web surface you can reach from anywhere is the plan; until it lands, off-machine access means Telegram.",
    soon: true,
  },
  {
    q: "What does it cost?",
    a: "Nothing to buy. It's MIT licensed and it drives the Claude Code you already pay for. What it costs lands on your quota rather than your wallet, and your live 5-hour and 7-day usage sits on screen so you can watch it.",
  },
  {
    q: "Which operating systems work?",
    a: "macOS and Linux, including WSL.",
  },
  {
    q: "Do I need Telegram?",
    a: "No. Setup asks, and no is an answer: the desktop dashboard runs without a bot token, and the two questions after it disappear. Telegram buys you the bot and the phone Mini App — answering a session from your pocket. Add a token later in the dashboard's SYSTEM tab and the phone half turns on after a restart.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="shell relative scroll-mt-20 py-24 sm:py-32">
      <SectionHead
        n="06"
        chapter="Questions"
        title="The things people ask first."
        deck={<>If yours isn't here, open an issue. That's the fastest way to get it answered.</>}
      />

      <div className="mt-14 sm:mt-20">
        {FAQ.map((item, i) => (
          <Reveal key={item.q} delay={Math.min(i, 6) * 35}>
            <details
              className={`row group [&_summary::-webkit-details-marker]:hidden ${
                i === FAQ.length - 1 ? "row-last" : ""
              }`}
            >
              <summary className="g12 cursor-pointer list-none items-baseline py-5">
                <span className="counter col-span-1 hidden text-[1.1rem] lg:block">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="col-span-12 flex items-baseline gap-4 lg:col-span-10 lg:col-start-2">
                  <span className="min-w-0 flex-1 text-[0.98rem] font-medium text-[var(--ink-2)] transition-colors group-hover:text-[var(--ink)] group-open:text-[var(--ink)]">
                    {item.q}
                  </span>
                  {item.soon && <Soon />}
                  <Plus
                    size={15}
                    aria-hidden
                    className="mt-1 shrink-0 text-[var(--accent)] transition-transform duration-300 group-open:rotate-45"
                  />
                </span>
              </summary>
              <div className="g12 pb-6">
                <p className="body col-span-12 max-w-[72ch] lg:col-span-10 lg:col-start-2">
                  {item.a}
                </p>
              </div>
            </details>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
