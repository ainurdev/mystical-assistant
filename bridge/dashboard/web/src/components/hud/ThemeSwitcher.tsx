import { useState } from "react";
import { applyTheme, getTheme, THEMES, type Phosphor } from "../../lib/theme";

const SWATCH: Record<Phosphor, string> = {
  teal: "#7fe9d8",
  amber: "#e8b873",
  green: "#6ee787",
  violet: "#b9a6ff",
};

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<Phosphor>(getTheme());
  const pick = (t: Phosphor) => {
    applyTheme(t);
    setTheme(t);
  };
  return (
    <div className="flex items-center gap-1.5" title="Phosphor theme">
      {THEMES.map((t) => (
        <button
          key={t}
          onClick={() => pick(t)}
          aria-label={`${t} theme`}
          className="h-3 w-3 border"
          style={{
            background: SWATCH[t],
            borderColor: theme === t ? "var(--foreground-bright)" : "transparent",
            opacity: theme === t ? 1 : 0.55,
          }}
        />
      ))}
    </div>
  );
}
