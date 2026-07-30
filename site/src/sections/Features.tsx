import {
  Brain,
  Gauge,
  Globe,
  GraduationCap,
  ListPlus,
  Radio,
  SlidersHorizontal,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";
import { Soon } from "@/components/Soon";

const FEATURES: { icon: LucideIcon; title: string; body: string; soon?: boolean }[] = [
  {
    icon: Radio,
    title: "Live stream, answerable inline",
    body: "Text, tool calls, results and errors land as they happen. When Claude needs permission or asks you something, it renders as a card you answer in place instead of a prompt you have to go find.",
  },
  {
    icon: Workflow,
    title: "You can see the subagents",
    body: "When a run fans out, a pill shows how many agents are working. Open it for what each one is doing and a live feed per agent, read straight from Claude Code's own transcripts.",
  },
  {
    icon: ListPlus,
    title: "Queue it up, or steer mid-run",
    body: "Stack the next few prompts while a turn is still going and they run in order. Or fold a correction into the turn that's already running, instead of stopping it and starting over.",
  },
  {
    icon: SlidersHorizontal,
    title: "Per-message controls",
    body: "Pick opus, sonnet or haiku, choose the reasoning effort, and set the permission posture — for this message, not forever. Whatever you choose sticks to the session.",
  },
  {
    icon: Brain,
    title: "It remembers the repo",
    body: "After a turn, a cheap Haiku pass proposes durable facts — conventions, decisions, what you're actually working towards — as Keep or Skip cards. Kept ones ride along in every future turn, scoped to that project and branch.",
  },
  {
    icon: Globe,
    title: "The dev server, in the same window",
    body: "Start or stop the project's dev server from the session that's working on it, and tail its logs in the pane next door. No second terminal, no hunting for which port it grabbed.",
  },
  {
    icon: Gauge,
    title: "Usage in plain sight",
    body: "Live 5-hour and 7-day utilisation on screen, so the first sign you're near a limit isn't Claude stopping mid-task.",
  },
  {
    icon: GraduationCap,
    title: "Teacher mode, if you want it",
    body: "After a turn that changed code, it proposes a concept or two worth reviewing, as Keep or Skip cards. Working through a kept one — Explain, Explain-back with a grade, a quiz, an exercise — is built but not yet wired into the dashboard. Off with one env var.",
    soon: true,
  },
];

export function Features() {
  return (
    <section id="features" className="relative scroll-mt-20 px-5 py-20 sm:py-28">
      <div className="mx-auto max-w-5xl">
        <SectionHead
          eyebrow="What's in the box"
          title="Built by someone who kept wanting these."
          lede="None of it is behind a plan, because there are no plans. It's the tool, and you're running it."
        />

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((f, i) => (
            <Reveal key={f.title} delay={(i % 4) * 60}>
              <article className="panel panel-hover h-full p-5">
                <div className="flex items-start justify-between gap-2">
                  <f.icon size={18} className="text-[var(--acc)]" aria-hidden />
                  {f.soon && <Soon />}
                </div>
                <h3 className="mt-3.5 text-[0.88rem] font-medium text-[var(--txb)]">{f.title}</h3>
                <p className="mt-2 text-[0.78rem] leading-relaxed text-[var(--txm)]">{f.body}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
