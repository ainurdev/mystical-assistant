import { Plus } from "lucide-react";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import { Soon } from "@/components/Soon";

/** Keep these in sync with the FAQPage JSON-LD in index.html. */
const FAQ: { q: string; a: string; soon?: boolean }[] = [
  {
    q: "Do I need an Anthropic API key?",
    a: "No. It shells out to the claude CLI already on your machine and reuses the login you set up the first time you ran it. There's no key to paste anywhere, and no account to make here.",
  },
  {
    q: "What does it install?",
    a: "Nothing to pip install — the server is Python 3.10+ standard library only. The dashboard UI is a Vite app that the bridge builds for you on first start, so you do need npm on the machine; after that it only rebuilds when the sources change.",
  },
  {
    q: "Does it work with the Claude Code I already run in VS Code?",
    a: "That's the main point of it. Sessions under your projects folder are read from Claude Code's own transcripts, and liveness comes from its session registry checked against the real process — so a VS Code or terminal session shows as running because it is, not because a file looked recent. Continue one and it's picked up from there on.",
  },
  {
    q: "What actually happens when I hit a usage limit?",
    a: "The session gets parked rather than dropped, and then it looks for a way to keep going: another Claude account of yours with quota left, or a free agent on a different provider, or — failing both — the reset itself. It reads the reset time from the usage endpoint, waits for it, and resumes the turn with its context intact. You set whether it asks first, switches on its own, or only ever waits, per session or as the default. Server errors (500, 529, and the 429 that isn't a usage limit) take a separate path — the first retry is immediate and each repeat waits longer, out to thirty minutes. All of it is persisted, so restarting the bridge mid-wait doesn't lose it.",
  },
  {
    q: "Can it use a second Claude account?",
    a: "Yes, if you have one. Add it from the dashboard's Accounts tab: a sign-in link opens, you log in as that account, you paste the code back. Each account lives in its own profile directory — the login you already had is never touched — and every turn is still the real claude binary, spawned per run with that profile. Nothing proxies or pools tokens. When a limit hits, the account with the most quota left goes first, and its meter sits next to the others in that tab.",
  },
  {
    q: "How is the memory different from the memory plugins?",
    a: "Two ways. Nothing is stored until you tap Keep on it, so the bank stays small and true instead of accumulating whatever a summariser thought was interesting. And facts are scoped to a project and a branch, so assumptions from a spike don't follow you back to main.",
  },
  {
    q: "Where does my code actually go?",
    a: "It stays on your machine, and there's no telemetry — the dashboard talks only to localhost, and nothing is sent anywhere the claude CLI wasn't already sending it. One caveat worth stating: the memory, teacher, auto-title and new-session checks each run their own cheap Haiku pass through your CLI after a turn, so they do send that turn's output to Anthropic in a second call. MEMORY_ENABLE=0, LEARNING_ENABLE=0, TITLE_ENABLE=0 and RELEVANCE_CHECK=0 turn them off individually.",
  },
  {
    q: "Is the dashboard exposed to the internet?",
    a: "No. It binds 127.0.0.1 and is never published. A Host allow-list guards against DNS rebinding and a token guards against CSRF.",
  },
  {
    q: "Can I drive it from my phone without Telegram?",
    a: "Not yet. Remote control today goes through Telegram — the bot for quick prompts, the Mini App for the full panel — because the dashboard deliberately never leaves localhost. A signed-in web surface you can reach from anywhere is the plan; until it lands, off-machine access means Telegram, and on-machine means the dashboard.",
    soon: true,
  },
  {
    q: "What does it cost?",
    a: "Nothing to buy — it's free and MIT licensed, and it drives the Claude Code you already pay for. Fair warning on your quota rather than your wallet: the memory, teacher, auto-title and relevance passes are extra Haiku calls on your plan, small but not free. Each is one env var away from off, and your live 5-hour and 7-day usage sits on screen so you can watch it.",
  },
  {
    q: "Which operating systems work?",
    a: "macOS and Linux, including WSL.",
  },
  {
    q: "Can I turn off the memory and teacher features?",
    a: "Yes — MEMORY_ENABLE=0 and LEARNING_ENABLE=0 in your .env. Both run as a cheap Haiku pass after a turn, and both propose rather than decide: nothing is kept until you tap Keep.",
  },
  {
    q: "Setup asks for a Telegram bot token. Why?",
    a: "The project began as a Telegram bridge and setup still requires that token, even though the dashboard doesn't use it. Making it optional for a dashboard-only install is the next thing on the list. Until then, creating a throwaway bot takes about a minute and nothing will message it.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="relative scroll-mt-20 px-5 py-20 sm:py-28">
      <div className="mx-auto max-w-3xl">
        <SectionHead
          eyebrow="Questions"
          title="The things people ask first."
          lede="If yours isn't here, open an issue — that's genuinely the fastest way to get it answered."
        />

        <div className="mt-12 space-y-2.5">
          {FAQ.map((item, i) => (
            <Reveal key={item.q} delay={Math.min(i, 5) * 40}>
              <details className="panel panel-hover group px-5 py-1 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center gap-4 py-4 text-[0.88rem] font-medium text-[var(--txh)] transition-colors hover:text-[var(--txb)]">
                  <span className="min-w-0 flex-1">{item.q}</span>
                  {item.soon && <Soon />}
                  <Plus
                    size={15}
                    aria-hidden
                    className="shrink-0 text-[var(--acc)] transition-transform duration-300 group-open:rotate-45"
                  />
                </summary>
                <p className="pb-4 text-[0.82rem] leading-relaxed text-[var(--txm)]">{item.a}</p>
              </details>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
