import { useState, type CSSProperties } from "react";
import {
  FAMILIES, FAMILY_INFO, applyTheme, colourings, isLight, loadTheme, themeDef, twin,
  type Family, type ThemeKey,
} from "../lib/theme";

// The dashboard's theme section on a phone: one card per family behind a
// Dark/Light switch. The switch shows each family's colourings on that ground;
// it does not change the theme — a tap on a card or a swatch does.

/** The preview's corner, per family — the family's own small radius, so a
 *  card's miniature has PEBBLE's pills and AURORA's hard edges. */
const RAD: Record<Family, string> = { aurora: "0px", claude: "7px", flint: "5px", pebble: "9px", "middle-earth": "6px" };

/** Pick the palette. applyTheme paints :root directly and persists, so the only
 *  React state here is which key is ON and which ground is shown. */
export function ThemeCards() {
  const [theme, setTheme] = useState<ThemeKey>(loadTheme);
  const [light, setLight] = useState(() => isLight(loadTheme()));

  function pick(key: ThemeKey) {
    applyTheme(key);
    setTheme(key);
  }

  return (
    <div className="space-y-2">
      <div className="sseg" role="group" aria-label="Ground">
        {([false, true] as const).map((l) => (
          <button key={String(l)} type="button" aria-pressed={light === l} onClick={() => setLight(l)}>
            {l ? "Light" : "Dark"}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {FAMILIES.map((fam) => {
          const keys = colourings(fam, light);
          const on = themeDef(theme).fam === fam && isLight(theme) === light;
          // The card wears the live colouring when it is this family's, else
          // the current colouring's twin on this ground, else the first.
          const t = twin(theme);
          const live: ThemeKey | undefined = on
            ? theme
            : themeDef(theme).fam === fam && t && keys.includes(t) ? t : keys[0];
          if (!live) {
            // AURORA by day: a tube has no daylight.
            return (
              <div key={fam} className="ftcard" data-off="">
                <div className="ftprev" style={{ "--g": "var(--panel3)" } as CSSProperties} />
                <div className="px-2.5 pb-2.5 pt-2">
                  <div className="truncate text-[13px] text-[var(--txb)]">{FAMILY_INFO[fam].name}</div>
                  <div className="text-[10.5px] leading-snug text-[var(--tg-hint)]">a tube has no daylight</div>
                </div>
              </div>
            );
          }
          const def = themeDef(live);
          const p = def.pal;
          const vars = {
            "--g": p.canvas, "--g2": p.panel, "--g3": p.txg, "--a": p.acc, "--r": RAD[fam],
          } as CSSProperties;
          return (
            <div key={fam} className="ftcard" data-on={on ? "" : undefined}>
              <button
                type="button"
                onClick={() => pick(live)}
                aria-pressed={on}
                className="block w-full text-left active:opacity-80"
              >
                {/* A miniature chat in the colouring's own inks: your prompt on
                    its tint and bar, two lines of reply, the box with SEND. */}
                <div className="ftprev" style={vars} aria-hidden>
                  <span className="p" />
                  <i /><i />
                  <span className="bx"><u /></span>
                </div>
                <div className="px-2.5 pt-2">
                  <div className="truncate text-[13px] text-[var(--txb)]" style={{ fontFamily: def.font }}>
                    {FAMILY_INFO[fam].name}
                  </div>
                  <div className="truncate text-[10.5px] text-[var(--tg-hint)]">
                    {on ? def.name : FAMILY_INFO[fam].feel}
                  </div>
                </div>
              </button>
              <div className="ftsw">
                {keys.map((k) => {
                  const v = themeDef(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => pick(k)}
                      aria-label={v.name}
                      aria-pressed={theme === k}
                      style={{ "--s": v.sw, "--sr": fam === "aurora" ? "0" : "50%" } as CSSProperties}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
