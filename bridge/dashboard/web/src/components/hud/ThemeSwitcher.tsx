import { useState } from "react";
import { applyTheme, getTheme, THEMES, type Phosphor } from "../../lib/theme";

const SWATCH: Record<Phosphor, { color: string; name: string }> = {
  aqua: { color: "#7fe9d8", name: "AQUA" },
  green: { color: "#5fdd8f", name: "PHOSPHOR" },
  amber: { color: "#e8b04a", name: "AMBER" },
  magenta: { color: "#ff7ad9", name: "SYNTH" },
};

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<Phosphor>(getTheme());
  const pick = (t: Phosphor) => {
    applyTheme(t);
    setTheme(t);
  };
  return (
    <div className="flex items-center gap-2">
      <span className="text-[9px] tracking-[1.5px] text-muted-2">DISPLAY</span>
      <div className="flex items-center gap-1.5">
        {THEMES.map((t) => (
          <button
            key={t}
            onClick={() => pick(t)}
            title={SWATCH[t].name}
            aria-label={`${SWATCH[t].name} theme`}
            className="h-3.5 w-3.5 border"
            style={{
              background: SWATCH[t].color,
              borderColor: theme === t ? "var(--foreground-bright)" : "transparent",
              boxShadow: theme === t ? `0 0 8px ${SWATCH[t].color}` : "none",
              opacity: theme === t ? 1 : 0.55,
            }}
          />
        ))}
      </div>
    </div>
  );
}
