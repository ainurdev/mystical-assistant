import { Head } from "./Head";
import { Reveal } from "@/components/Reveal";

/** The objections, answered where they land rather than in a footer. Kept as
 *  plain Q/A markup so it reads the same to a person and to an answer engine. */
const QA = [
  [
    "Does my code or my prompts leave the machine?",
    "The bridge binds to 127.0.0.1 and is never published. Your repos, transcripts and the claude process all stay put. The only traffic off the machine is Claude Code's own — plus Telegram's, and only if you use the phone surfaces.",
  ],
  [
    "Do I need an API key?",
    "No. It shells out to the claude CLI you already logged into and reuses that login. There is no key to paste and no account to make here.",
  ],
  [
    "Will it pick up sessions I started in VS Code or a terminal?",
    "Yes — that is the whole point. It reads Claude Code's own session registry, so a session started anywhere shows up here and can be answered and carried on from here.",
  ],
  [
    "Does adding a second account change the login I already have?",
    "No. Extra logins live in their own CLAUDE_CONFIG_DIR as thin overlays: that account's credentials are a real file, everything else symlinks back to your ~/.claude. Your first login is never redirected, and because transcripts stay shared, any account can resume any session.",
  ],
  [
    "What does it cost?",
    "Nothing. MIT licensed, no plans, no free tier and no paid one. You are already paying for Claude Code; this is a dashboard on top of it.",
  ],
  [
    "What has to be installed?",
    "The claude CLI, Python 3.10+, and npm for the first UI build. The server itself imports nothing off PyPI. macOS, Linux and WSL.",
  ],
  [
    "Is there a hosted version?",
    "No, and there is not going to be one. The work happens in your repos on your machine; your phone or browser is a remote control for it.",
  ],
];

export function Faq() {
  return (
    <section id="questions" className="shell scroll-mt-24 pt-28 sm:pt-36">
      <Reveal>
        <Head path="~/questions" title="Before you run it" />
      </Reveal>

      <dl className="mt-12 border-t border-[var(--rule)]">
        {QA.map(([q, a], i) => (
          <Reveal key={q} delay={i < 3 ? 0 : 40}>
            <div className="row g12 items-start border-t-0 gap-y-2 py-6">
              <dt className="col-span-12 lg:col-span-5">
                <span className="h4">{q}</span>
              </dt>
              <dd className="body col-span-12 max-w-[60ch] lg:col-span-7">{a}</dd>
            </div>
          </Reveal>
        ))}
      </dl>
    </section>
  );
}
