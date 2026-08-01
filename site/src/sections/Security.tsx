import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";

/**
 * Risk reversal, stated as risk. The honest version of this section converts
 * better than a padlock icon and a promise, because the reader has already
 * worked out that a thing which runs `claude` on their machine can run anything
 * — meeting them there is the only credible move. Amber, the page's one second
 * hue, means caution here and nowhere else.
 */
const POINTS = [
  {
    title: "It never leaves localhost",
    body: "The dashboard binds 127.0.0.1 and is not published. A Host allow-list blocks DNS rebinding and a token blocks CSRF, so a page you happen to have open in another tab can't drive it.",
  },
  {
    title: "It runs real commands as you",
    body: "That's the point of it, and it's also the risk: Claude Code runs with your user's permissions in your own repos, so anything that can slip a prompt past you runs as you too. Setup makes you pick a posture rather than defaulting you into full autonomy, and RUN_TIMEOUT caps anything that runs away.",
  },
  {
    title: "Read-only where it counts",
    body: "The parts that watch your existing sessions only read. Subagent views derive from files Claude Code already wrote, and never touch a live run.",
  },
  {
    title: "Secrets stay in .env",
    body: "Setup writes .env git-ignored and chmod 600, and generates the dashboard token for you. Nothing is sent anywhere the claude CLI wasn't already sending it.",
  },
];

export function Security() {
  return (
    <section className="shell relative py-24 sm:py-32">
      <SectionHead
        n="05"
        chapter="The honest part"
        title="A thing on your machine that runs commands."
        deck={
          <>
            Worth knowing what you're installing. No telemetry, no account, and the whole server is
            a few thousand lines of standard-library Python you can read yourself.
          </>
        }
      />

      <div className="mt-14 grid gap-x-10 gap-y-9 sm:mt-20 sm:grid-cols-2">
        {POINTS.map((p, i) => (
          <Reveal key={p.title} delay={i * 55}>
            <article className="border-t border-[color-mix(in_srgb,var(--warn)_28%,transparent)] pt-5">
              <h3 className="text-[0.98rem] font-medium text-[var(--ink)]">{p.title}</h3>
              <p className="body mt-2.5">{p.body}</p>
            </article>
          </Reveal>
        ))}
      </div>

      <Reveal delay={120}>
        <p className="caption mt-12 max-w-[68ch]">
          One caveat: the memory, teacher, auto-title and relevance checks each run a cheap Haiku
          pass through your CLI after a turn, so they send that turn's output to Anthropic in a
          second call. Small, but not free on your quota. Each is one env var away from off:{" "}
          <span className="font-mono text-[0.92em]">
            MEMORY_ENABLE, LEARNING_ENABLE, TITLE_ENABLE, RELEVANCE_CHECK
          </span>
          .
        </p>
      </Reveal>
    </section>
  );
}
