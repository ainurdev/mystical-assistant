import { useState } from "react";
import { AURORA_KEYS, CLAUDE_KEYS, THEMES, applyTheme, loadTheme, type ThemeKey } from "../lib/theme";

// AURORA and CLAUDE are one profile each in several colours, so each gets one
// card with a colour row (the dashboard's picker does the same).
const CARDS: { key: ThemeKey; variants: ThemeKey[] }[] = [
  { key: "aqua", variants: AURORA_KEYS },
  { key: "claude", variants: CLAUDE_KEYS },
];

/** Pick the palette. applyTheme paints :root directly and persists, so the only
 *  React state here is which key to draw as ON — no provider, no context.
 *  Lives in the SYSTEM tab, next to the other machine-wide controls. */
export function ThemeCards() {
  const [theme, setTheme] = useState<ThemeKey>(loadTheme);

  function pick(key: ThemeKey) {
    applyTheme(key);
    setTheme(key);
  }

  return (
    <div className="space-y-1">
      {CARDS.map((card) => {
        // A family card wears whichever variant is live (the first otherwise).
        const live = card.variants.includes(theme) ? theme : card.key;
        const def = THEMES.find((t) => t.key === live)!;
        const on = card.variants.includes(theme);
        return (
          <div
            key={card.key}
            className={`bg-[var(--tg-secondary-bg)] ${on ? "ring-1 ring-[var(--brand-soft)]" : ""}`}
          >
            <button
              onClick={() => pick(def.key)}
              className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left active:opacity-70"
            >
              {/* The swatch is a true colour on a true ground: the card
                  preview IS the theme, so it shows its own page bg. */}
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center border border-black/40"
                style={{ background: def.page }}
              >
                <span className="h-3.5 w-3.5 rounded-full" style={{ background: def.sw }} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm" style={{ fontFamily: def.font }}>
                  {THEMES.find((t) => t.key === card.key)!.name}
                </div>
                <div className="truncate text-[11px] text-[var(--tg-hint)]">{def.feel}</div>
              </div>
              {on && (
                <span className="shrink-0 text-[10px] tracking-widest text-[var(--brand-soft)]">ON</span>
              )}
            </button>
            <div className="flex gap-1.5 px-3 pb-2.5">
              {card.variants.map((k) => {
                const v = THEMES.find((t) => t.key === k)!;
                return (
                  <button
                    key={k}
                    onClick={() => pick(k)}
                    aria-label={v.name}
                    className={`h-4 flex-1 border ${theme === k ? "border-white" : "border-black/40"}`}
                    style={{ background: v.sw }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
