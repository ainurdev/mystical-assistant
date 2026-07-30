import { Eye, KeyRound, Lock, ShieldAlert } from "lucide-react";
import { Reveal } from "@/components/Reveal";

const POINTS = [
  {
    icon: Lock,
    title: "It never leaves localhost",
    body: "The dashboard binds 127.0.0.1 and is not published. A Host allow-list blocks DNS rebinding and a token blocks CSRF, so a page you happen to have open in another tab can't drive it.",
  },
  {
    icon: ShieldAlert,
    title: "It runs real commands as you",
    body: "That's the point of it, and it's also the risk: Claude Code runs with your user's permissions in your own repos, so anything that can slip a prompt past you runs as you too. Setup makes you pick a posture rather than defaulting you into full autonomy, and RUN_TIMEOUT caps anything that runs away.",
  },
  {
    icon: Eye,
    title: "Read-only where it counts",
    body: "The parts that watch your existing sessions only read. Subagent views derive entirely from files Claude Code already wrote, and never touch a live run.",
  },
  {
    icon: KeyRound,
    title: "Secrets stay in .env",
    body: "Setup writes .env git-ignored and chmod 600, and generates the dashboard token for you. Nothing is sent anywhere the claude CLI wasn't already sending it.",
  },
];

export function Security() {
  return (
    <section className="relative px-5 py-20 sm:py-28">
      <div className="mx-auto max-w-5xl">
        <Reveal>
          <div className="panel panel-lit brackets overflow-hidden">
            <div className="grid gap-8 p-6 sm:p-9 md:grid-cols-[1fr_1.3fr] md:gap-12">
              <div>
                <p className="eyebrow mb-4">The honest part</p>
                <h2 className="h2">A thing on your machine that runs commands.</h2>
                <p className="lede mt-4">
                  Worth knowing exactly what you're installing. There's no telemetry and no account,
                  the security notes sit at the bottom of the entry point, and the whole server is a
                  few thousand lines of standard-library Python you can read yourself.
                </p>
              </div>

              <ul className="space-y-5">
                {POINTS.map((p) => (
                  <li key={p.title} className="flex gap-3.5">
                    <p.icon size={16} className="mt-0.5 shrink-0 text-[var(--warn)]" aria-hidden />
                    <div className="min-w-0">
                      <h3 className="text-[0.85rem] font-medium text-[var(--txb)]">{p.title}</h3>
                      <p className="mt-1 text-[0.78rem] leading-relaxed text-[var(--txm)]">
                        {p.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
