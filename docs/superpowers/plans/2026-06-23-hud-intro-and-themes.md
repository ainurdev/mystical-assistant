# HUD Boot Intro + Phosphor Themes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a CRT boot-intro splash (every load, skippable) and a phosphor theme switcher (Teal/Amber/Green/Violet) to the HUD dashboard.

**Architecture:** Frontend-only. Make accent-tinted CSS values derive from `--accent-rgb` + `--primary` so a `[data-theme]` override of four variables recolors everything; sweep component literals onto named accent vars; add `lib/theme.ts` + a Strip switcher; add a `BootIntro` overlay gated by App state.

**Tech Stack:** React 19 + Vite + Tailwind v4 + TS.

## Global Constraints

- Both `index.css` files keep token NAMES; the accent refactor lands in both (Mini App default teal, no switcher/intro).
- Theme overrides only `--accent-rgb`, `--primary`, `--foreground`, `--foreground-bright`; secondary semantic hues (success/warning/danger/violet/blue) stay fixed.
- Named accent vars (`var(--ac-XX)`) are single-token so they work in BOTH Tailwind arbitrary classes (`bg-[var(--ac-12)]`) and inline style objects.
- SVG `stroke`/`fill` presentation attributes do NOT resolve `var()` — convert those to Tailwind `[stroke:var(--…)]` classes by hand.
- `localStorage` wrapped in try/catch. Per-task verify = `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`.

## File Structure

- Modify `bridge/dashboard/web/src/index.css` + `bridge/miniapp/web/src/index.css` (accent derivation + named vars + data-theme blocks + primitives).
- Create `bridge/dashboard/web/src/lib/theme.ts`.
- Modify `bridge/dashboard/web/src/main.tsx` (early `applyTheme`).
- Modify HUD + feature components (literal-teal sweep): `components/hud/*`, `Composer`, `RunStream`, `RightPanel`, `CommandPalette`, `GitTab`, `IssuesTab`, `DiffTab`, `UsageStrip`.
- Create `bridge/dashboard/web/src/components/hud/ThemeSwitcher.tsx`; wire into `Strip.tsx`.
- Create `bridge/dashboard/web/src/components/hud/BootIntro.tsx`; wire into `App.tsx`.

---

## Task 1: Accent derivation + themes (index.css ×2, theme.ts, main.tsx)

- [ ] **Step 1: Refactor the dashboard `:root`** — in `bridge/dashboard/web/src/index.css`, replace the accent-related token declarations so they derive from `--accent-rgb`/`--primary` (keep `--background`, `--panel`, `--card`, `--popover*`, `--card-foreground`, and the semantic/surface hues as they are):
```css
  --accent-rgb: 127 233 216;
  --primary: #7fe9d8;
  --primary-foreground: #060a0a;
  --foreground: #bfe6de;
  --foreground-bright: #dff8f2;

  --brand: var(--primary);
  --brand-soft: var(--primary);
  --brand-bright: var(--foreground-bright);
  --brand-glow: rgb(var(--accent-rgb) / .25);
  --ring: var(--primary);
  --surface-vs: var(--primary);
  --surface-vs-bg: rgb(var(--accent-rgb) / .08);

  --secondary: rgb(var(--accent-rgb) / .08);
  --muted: rgb(var(--accent-rgb) / .05);
  --accent: rgb(var(--accent-rgb) / .08);
  --border: rgb(var(--accent-rgb) / .16);
  --border-bright: rgb(var(--accent-rgb) / .4);
  --input: rgb(var(--accent-rgb) / .2);

  /* extra named accent fills (single-token; class- and style-safe) */
  --ac-03: rgb(var(--accent-rgb) / .03);
  --ac-06: rgb(var(--accent-rgb) / .06);
  --ac-12: rgb(var(--accent-rgb) / .12);
  --ac-22: rgb(var(--accent-rgb) / .22);
```
Keep `--card-foreground: #bfe6de;`, `--secondary-foreground`, `--accent-foreground`, `--muted-foreground: #6f938d`, `--muted-2: #3c544f`, the `--success/--warning/--danger/--violet/--blue` block, `--surface-tg/-ma/-web(+bg)`, the `--tg-*` aliases, and `--radius:0`. Remove the now-duplicated old `--brand-soft: #7fe9d8` etc. lines.

- [ ] **Step 2: Add data-theme blocks** — immediately after the `:root { … }` block:
```css
[data-theme="amber"]  { --accent-rgb: 232 184 115; --primary: #e8b873; --foreground: #ddc7a0; --foreground-bright: #ffeccb; }
[data-theme="green"]  { --accent-rgb: 110 231 135; --primary: #6ee787; --foreground: #b6e6c1; --foreground-bright: #d6ffdf; }
[data-theme="violet"] { --accent-rgb: 185 166 255; --primary: #b9a6ff; --foreground: #d4caf7; --foreground-bright: #efe9ff; }
```

- [ ] **Step 3: Re-point primitives to the accent var** — in the same file's `.glow/.panel::before,.panel::after/.sweep` + scrollbar + `::selection` rules, replace the literal `rgba(127, 233, 216, X)` with `rgb(var(--accent-rgb) / X)`:
  - `.glow` text-shadow `… / .35)`; `.panel::before,.panel::after` border `… / .6)`; `.sweep` gradient middle stop `… / .045)`; scrollbar-thumb `… / .22)`, hover `… / .4)`; `scrollbar-color: rgb(var(--accent-rgb) / .22) transparent`; `::selection` background `… / .25)`. (`.crt` scanlines are black — leave.)

- [ ] **Step 4: Mirror into the Mini App `index.css`** — apply Steps 1–3 identically to `bridge/miniapp/web/src/index.css` (it has the same `:root`, primitives minus `.sweep`; include the data-theme blocks for sync even though there's no switcher).

- [ ] **Step 5: `lib/theme.ts`**
```ts
export type Phosphor = "teal" | "amber" | "green" | "violet";
export const THEMES: Phosphor[] = ["teal", "amber", "green", "violet"];
const KEY = "hud-theme";

export function getTheme(): Phosphor {
  try {
    const t = localStorage.getItem(KEY);
    if (t && (THEMES as string[]).includes(t)) return t as Phosphor;
  } catch {
    /* ignore */
  }
  return "teal";
}

export function applyTheme(t: Phosphor): void {
  const el = document.documentElement;
  if (t === "teal") el.removeAttribute("data-theme");
  else el.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
}
```

- [ ] **Step 6: Apply early in `main.tsx`** — in `bridge/dashboard/web/src/main.tsx`, after the font imports and before `createRoot`, add:
```ts
import { applyTheme, getTheme } from "./lib/theme";
applyTheme(getTheme());
```

- [ ] **Step 7: Build** — `npm --prefix …/dashboard/web run build` and `… miniapp/web run build`. Expected: both succeed.

- [ ] **Step 8: Commit**
```bash
git add bridge/dashboard/web/src/index.css bridge/miniapp/web/src/index.css \
        bridge/dashboard/web/src/lib/theme.ts bridge/dashboard/web/src/main.tsx
git commit -m "feat(ui): phosphor theme tokens (accent-derived) + theme persistence"
```

---

## Task 2: Literal-teal sweep (components follow the theme)

- [ ] **Step 1: Fix SVG strokes manually** — in `components/hud/TelemetryPanel.tsx` and `components/hud/SessionsPanel.tsx`, the `<polyline>`/`<line>` use `stroke="…"` attributes that can't take `var()`. Convert:
  - Sparkline/waveline teal polylines: remove `stroke="#7fe9d8"`, add `className="[stroke:var(--primary)]"`.
  - The violet throughput polyline keeps `stroke="#b9a6ff"` (fixed secondary).
  - Baseline `<line stroke="rgba(127,233,216,.NN)">` → remove the attr, add `className="[stroke:var(--border)]"`.

- [ ] **Step 2: Sweep the remaining literals** — run this mapping over the component files (anchored on `)` so `.2)` never matches `.22)`):
```bash
cd /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web/src/components
FILES=$(grep -rl "127,233,216\|#7fe9d8" . )
for f in $FILES; do
  sed -i -E '
    s/rgba\(127, *233, *216, *0*\.045\)/var(--ac-06)/g;
    s/rgba\(127, *233, *216, *0*\.25\)/var(--brand-glow)/g;
    s/rgba\(127, *233, *216, *0*\.22\)/var(--ac-22)/g;
    s/rgba\(127, *233, *216, *0*\.16\)/var(--border)/g;
    s/rgba\(127, *233, *216, *0*\.12\)/var(--ac-12)/g;
    s/rgba\(127, *233, *216, *0*\.06\)/var(--ac-06)/g;
    s/rgba\(127, *233, *216, *0*\.08\)/var(--accent)/g;
    s/rgba\(127, *233, *216, *0*\.05\)/var(--muted)/g;
    s/rgba\(127, *233, *216, *0*\.03\)/var(--ac-03)/g;
    s/rgba\(127, *233, *216, *0*\.4\)/var(--border-bright)/g;
    s/rgba\(127, *233, *216, *0*\.3\)/var(--border-bright)/g;
    s/rgba\(127, *233, *216, *0*\.2\)/var(--input)/g;
    s/rgba\(127, *233, *216, *0*\.1\)/var(--border)/g;
    s/#7fe9d8/var(--primary)/g;
  ' "$f"
done
```

- [ ] **Step 3: Grep for leftovers** — any remaining literal accents need manual handling:
```bash
grep -rn "127, *233, *216\|#7fe9d8" /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web/src/components || echo "clean"
```
Expected: `clean`. If any remain (e.g. an odd opacity like `.35`/`.6`/`.8`), replace by hand with the nearest token (`.35`→`var(--border-bright)`, `.6`→`var(--border-bright)`, `.8`→`var(--primary)`).

- [ ] **Step 4: Build** — `npm --prefix …/dashboard/web run build`. Expected: success. (Confirm `[stroke:var(--primary)]` compiled — sparklines should keep a stroke.)

- [ ] **Step 5: Commit**
```bash
git add bridge/dashboard/web/src/components
git commit -m "feat(dashboard): components follow the active phosphor accent"
```

---

## Task 3: Theme switcher in the Strip

- [ ] **Step 1: `components/hud/ThemeSwitcher.tsx`**
```tsx
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
```

- [ ] **Step 2: Wire into `Strip.tsx`** — import `ThemeSwitcher` and place it just before the `MAIN SHELL` label:
```tsx
      <ThemeSwitcher />
      <span className="text-[11px] tracking-[2px] text-muted-2">MAIN SHELL</span>
```

- [ ] **Step 3: Build** — success.

- [ ] **Step 4: Commit**
```bash
git add bridge/dashboard/web/src/components/hud/ThemeSwitcher.tsx bridge/dashboard/web/src/components/hud/Strip.tsx
git commit -m "feat(dashboard): phosphor theme switcher in the HUD strip"
```

---

## Task 4: Boot intro

- [ ] **Step 1: `components/hud/BootIntro.tsx`**
```tsx
import { useEffect, useState } from "react";

const LINES = [
  "▸ INIT BRIDGE LINK ............. OK",
  "▸ MOUNT WORKSPACE .............. OK",
  "▸ SYNC SESSIONS ................ OK",
  "▸ READY",
];

export function BootIntro({ onDone }: { onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const fade = setTimeout(() => setLeaving(true), 1900);
    const done = setTimeout(onDone, 2250);
    const skip = () => onDone();
    window.addEventListener("keydown", skip);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
      window.removeEventListener("keydown", skip);
    };
  }, [onDone]);

  return (
    <div
      onClick={onDone}
      className="fixed inset-0 z-[100] flex cursor-pointer flex-col items-center justify-center bg-[#060a0a] transition-opacity duration-300"
      style={{ opacity: leaving ? 0 : 1, animation: "flicker .8s ease both" }}
    >
      <div className="crt" />
      <div className="glow text-[34px] tracking-[6px] text-primary">MYSTICAL//ASSISTANT</div>
      <div className="mt-2 text-[11px] tracking-[4px] text-muted-foreground">REMOTE DEV BRIDGE</div>
      <div
        className="mt-4 h-px w-[280px] origin-left"
        style={{ background: "linear-gradient(90deg,var(--primary),transparent)", animation: "drawline .7s ease both .15s" }}
      />
      <div className="mt-5 flex flex-col gap-1 font-mono text-[12px] text-muted-foreground">
        {LINES.map((l, i) => (
          <div key={i} style={{ animation: `mfadeup .4s ease both ${0.4 + i * 0.35}s` }}>
            <span className="text-success">{l}</span>
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center gap-2 text-[11px] text-primary">
        <span>~ ❯</span>
        <span className="inline-block h-3.5 w-[8px] bg-primary" style={{ animation: "caret 1.05s steps(1) infinite" }} />
      </div>
      <div className="absolute bottom-8 text-[10px] tracking-[2px] text-muted-2">PRESS ANY KEY TO SKIP</div>
    </div>
  );
}
```

- [ ] **Step 2: Wire into `App.tsx`** — import it, add state, and render at the root of the returned tree:
```tsx
import { BootIntro } from "./components/hud/BootIntro";
```
Add near the other `useState`s (before the early `if (!TOKEN)` return is fine — it's a plain state):
```tsx
const [booting, setBooting] = useState(true);
```
Render it just after the opening root `<div className="flex h-full flex-col bg-background">` (or anywhere in the root fragment), e.g. right before `<div className="crt" />`:
```tsx
{booting && <BootIntro onDone={() => setBooting(false)} />}
```

- [ ] **Step 3: Build** — success.

- [ ] **Step 4: Commit**
```bash
git add bridge/dashboard/web/src/components/hud/BootIntro.tsx bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): animated CRT boot intro (every load, skippable)"
```

---

## Task 5: Verify

- [ ] **Step 1: Build both** — dashboard + miniapp. Expected: both succeed.
- [ ] **Step 2: Backend regression** — `for t in test_git test_github test_bridge test_native; do python tests/$t.py | tail -1; done`. Expected: all pass.
- [ ] **Step 3: Leftover-literal check** — `grep -rn "127, *233, *216\|#7fe9d8" bridge/dashboard/web/src/components` → `clean` (the only intended teal literals left should be none; the violet `#b9a6ff` throughput line is fine).
- [ ] **Step 4: Server/visual smoke** — run the dashboard server (as in prior tasks); confirm the SPA serves. If libasound is restored, screenshot each phosphor scheme + the boot intro; otherwise note skipped.
- [ ] **Step 5: Commit any fixes** if needed.

---

## Self-Review

**Spec coverage:** accent-derived tokens + data-theme blocks + primitives (T1) · component literal sweep incl. SVG-stroke special-case (T2) · switcher in Strip (T3) · boot intro every-load/skippable (T4) · persistence via theme.ts + early apply (T1) · Mini App mirror, no switcher (T1) · verify (T5). ✓

**Placeholder scan:** No vague items; sed mapping is explicit and anchored. ✓

**Type consistency:** `Phosphor`/`THEMES`/`applyTheme`/`getTheme` used consistently across `theme.ts`, `main.tsx`, `ThemeSwitcher`. `BootIntro({onDone})` matches App usage. Named accent vars (`--ac-03/06/12/22`) defined in T1 before use in T2. SVG strokes use `[stroke:var(--primary|--border)]` classes (resolve var; presentation attrs would not). ✓

**Risk note:** after T2's sed, run the T2/T5 leftover grep; the only acceptable remaining hex accent is the violet throughput stroke `#b9a6ff`.
