import { useState } from "react";
import { Reveal } from "@/components/Reveal";
import { SectionHead } from "@/components/SectionHead";

/**
 * Real captures, not mockups — `site/tools/shot/` takes them off the running
 * dashboard over CDP, with the repo names swapped for a demo set. They go stale
 * when the UI moves, so re-take them rather than describing around them; the
 * captions are the only thing here that isn't a photograph.
 */
const SHOTS: { id: string; tab: string; src: string; alt: string; caption: string }[] = [
  {
    id: "accounts",
    tab: "ACCOUNTS",
    src: "./shots/accounts.png",
    alt: "The Accounts tab: an ask / auto / wait picker, a Claude login with quota remaining, and a list of free-agent providers.",
    caption:
      "What happens when a limit lands, and what it's allowed to fall back to. Each Claude account you add carries its own meter; the free agents are a different provider, set up once and used only when every account is spent.",
  },
  {
    id: "themes",
    tab: "THEMES",
    src: "./shots/themes.png",
    alt: "The Appearance tab: ten theme cards split into dark and light, above toggles for CRT scanlines and scan sweep.",
    caption:
      "Ten display profiles, dark and light, and the CRT effects on their own switches. It's a tool you'll stare at all day — it may as well look like something you chose.",
  },
];

export function Screens() {
  const [active, setActive] = useState(SHOTS[0].id);
  const shot = SHOTS.find((s) => s.id === active) ?? SHOTS[0];

  return (
    <section id="screens" className="relative scroll-mt-20 px-5 py-20 sm:py-28">
      <div className="mx-auto max-w-5xl">
        <SectionHead
          eyebrow="Screens"
          title="Past the main screen."
          lede="Two more captures off the same running install — the settings that decide what a limit costs you, and what the whole thing can look like. The repo names are a demo set; everything else ships as shown."
        />

        <Reveal delay={80}>
          <div
            className="mt-10 flex flex-wrap justify-center gap-1.5"
            role="tablist"
            aria-label="Screenshots"
          >
            {SHOTS.map((s) => (
              <button
                key={s.id}
                role="tab"
                type="button"
                aria-selected={s.id === active}
                aria-controls={`screen-${s.id}`}
                onClick={() => setActive(s.id)}
                className={`rounded border px-3 py-1.5 font-mono text-[0.65rem] tracking-widest transition-colors ${
                  s.id === active
                    ? "border-[color-mix(in_srgb,var(--acc)_45%,transparent)] bg-[color-mix(in_srgb,var(--acc)_10%,transparent)] text-[var(--acc)]"
                    : "border-[var(--border-soft)] text-[var(--txd)] hover:text-[var(--txm)]"
                }`}
              >
                {s.tab}
              </button>
            ))}
          </div>
        </Reveal>

        <Reveal delay={140}>
          <figure id={`screen-${shot.id}`} role="tabpanel" className="mt-5">
            <div className="panel panel-lit overflow-hidden p-1.5 sm:p-2">
              {/* Fixed aspect box: the shots are all 1512×950, so swapping tabs
                  doesn't reflow the page while the next one decodes. */}
              <img
                src={shot.src}
                alt={shot.alt}
                width={1512}
                height={950}
                loading="lazy"
                decoding="async"
                className="block w-full rounded-[3px]"
                style={{ aspectRatio: "1512 / 950" }}
              />
            </div>
            <figcaption className="mx-auto mt-4 max-w-2xl text-center text-[0.8rem] leading-relaxed text-[var(--txd)]">
              {shot.caption}
            </figcaption>
          </figure>
        </Reveal>
      </div>
    </section>
  );
}
