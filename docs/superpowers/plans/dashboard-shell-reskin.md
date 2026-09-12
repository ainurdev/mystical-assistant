# Dashboard Shell Re-skin + Unified Visual Identity (Sub-project A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the desktop dashboard to the "Mystical Assistant Dashboard" mockup and re-unify the shared palette + Geist typography across the dashboard and the Telegram Mini App, wired entirely to existing backend data.

**Architecture:** Frontend-only. Re-point CSS design tokens (keep names, change values) in both `index.css` files so existing Tailwind utility classes adopt the new look; add self-hosted Geist fonts. Restructure the dashboard into focused components (`Header`, `Sidebar` sub-parts, `ChatHeader`, `RightPanel`, restyled `Transcript`/`RunStream`/`Composer`/`Logs`). `App.tsx` stays the orchestrator and lifts the `/local/running` poll so `Header` and `Sidebar` share one source.

**Tech Stack:** React 19, Vite 6, Tailwind CSS v4, TypeScript 5.7, lucide-react, `@fontsource/geist` + `@fontsource/geist-mono`.

## Global Constraints

- Both clients keep token **names** identical and **values** in sync — the "keep in sync" contract in each `index.css` header. Every token change lands in BOTH `bridge/dashboard/web/src/index.css` and `bridge/miniapp/web/src/index.css`.
- No backend / Python changes in Sub-project A. Frontend only.
- No fake data. The three flagged placeholders (inert ⌘K button, empty git-badge slot, read-only accept-edits chip) render as visuals only; git/issues/diff tabs are NOT rendered.
- No new runtime deps beyond the two `@fontsource/*` packages.
- Per-task verification is **type-check + production build** (`npm --prefix <web> run build`, which runs `tsc -b && vite build`) — these apps have no unit-test harness; do not invent one.
- Mini App receives palette + font ONLY; no Mini App layout/component changes.
- Match existing code style (functional components, Tailwind utilities, `cn()` helper, `lucide-react` icons).

---

## File Structure

**Shared theme (both clients):**
- Modify `bridge/dashboard/web/src/index.css` — tokens, `@theme inline`, Geist body font, glow, scrollbar, keyframes.
- Modify `bridge/miniapp/web/src/index.css` — same `:root` + `@theme inline` block + Geist body font (no layout).
- Modify `bridge/dashboard/web/package.json` and `bridge/miniapp/web/package.json` — add `@fontsource/geist`, `@fontsource/geist-mono`.
- Modify `bridge/dashboard/web/src/main.tsx` and `bridge/miniapp/web/src/main.tsx` — import font CSS.

**Dashboard shell:**
- Create `bridge/dashboard/web/src/lib/surfaces.ts` — surface (origin→chip) + `ago`/`fmtDuration` helpers.
- Create `bridge/dashboard/web/src/components/Header.tsx`.
- Create `bridge/dashboard/web/src/components/ChatHeader.tsx`.
- Create `bridge/dashboard/web/src/components/RightPanel.tsx`.
- Modify `bridge/dashboard/web/src/App.tsx` — orchestrator: lift `/local/running`, use new components.
- Modify `bridge/dashboard/web/src/components/Sidebar.tsx` — restructure; consume running props.
- Modify `bridge/dashboard/web/src/components/Composer.tsx` — restyle + real context strip + accept-edits chip.
- Modify `bridge/dashboard/web/src/components/Transcript.tsx` and `RunStream.tsx` — restyle.
- Modify `bridge/dashboard/web/src/components/Logs.tsx` — restyle (rendered inside `RightPanel`).
- Modify `bridge/dashboard/web/src/api.ts` — add `permission_mode` to `DashState`.

---

## Task 1: Shared design tokens + Geist font (both clients)

**Files:**
- Modify: `bridge/dashboard/web/package.json`, `bridge/miniapp/web/package.json`
- Modify: `bridge/dashboard/web/src/main.tsx`, `bridge/miniapp/web/src/main.tsx`
- Modify: `bridge/dashboard/web/src/index.css`, `bridge/miniapp/web/src/index.css`

**Interfaces:**
- Produces: CSS tokens usable as Tailwind utilities — `bg-panel`, `border-panel-border`, `text-muted-2`, `text-success`, `text-warning`, `text-danger`, `bg-card`, `text-muted-foreground`, `bg-primary`, `border-border`, `font-mono`; surface color vars `--surface-vs/-tg/-ma/-web` (+ `-bg`); keyframes `mpulse`/`mfade`/`mpop`; CSS custom props `--success`, `--warning`, `--danger`, `--muted-2`, `--brand-soft`, etc.

- [ ] **Step 1: Add font deps to both package.json**

In `bridge/dashboard/web/package.json` and `bridge/miniapp/web/package.json`, add to `dependencies`:
```json
"@fontsource/geist": "^5.1.0",
"@fontsource/geist-mono": "^5.1.0",
```

- [ ] **Step 2: Install**

Run:
```bash
npm --prefix bridge/dashboard/web install
npm --prefix bridge/miniapp/web install
```
Expected: both add `@fontsource/geist*` without errors.

- [ ] **Step 3: Import fonts in both main.tsx**

Add these imports at the TOP of `bridge/dashboard/web/src/main.tsx` and `bridge/miniapp/web/src/main.tsx` (before `./index.css`):
```ts
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
```

- [ ] **Step 4: Rewrite the dashboard index.css**

Replace the entire contents of `bridge/dashboard/web/src/index.css` with:
```css
@import "tailwindcss";

:root {
  color-scheme: dark;

  /* === Mystical — shared identity (dashboard + Mini App). Keep BOTH index.css
     files' :root and @theme blocks in sync, names AND values. === */

  /* Surfaces */
  --background: #0e0c14;
  --foreground: #e9e7f0;
  --panel: #120f1a;
  --panel-border: #221d30;
  --card: #15121f;
  --card-foreground: #e9e7f0;
  --popover: #1a1527;
  --popover-foreground: #e9e7f0;

  /* Brand */
  --primary: #7458ff;
  --primary-foreground: #ffffff;
  --brand: #7458ff;
  --brand-strong: #6a47ff;
  --brand-soft: #8b6dff;
  --brand-glow: rgba(124, 88, 255, 0.26);

  /* Secondary / muted */
  --secondary: #1c1729;
  --secondary-foreground: #e9e7f0;
  --muted: #181423;
  --muted-foreground: #9c95b0;
  --muted-2: #6a6380;
  --accent: #1a1527;
  --accent-foreground: #e9e7f0;

  /* Status */
  --success: #5ad18c;
  --warning: #e2b15a;
  --danger: #e5736b;
  --destructive: #e5736b;
  --destructive-foreground: #ffffff;

  /* Surface chips */
  --surface-vs: #8b6dff;  --surface-vs-bg: rgba(139, 109, 255, 0.14);
  --surface-tg: #6fb5ff;  --surface-tg-bg: rgba(111, 181, 255, 0.13);
  --surface-ma: #b08bff;  --surface-ma-bg: rgba(176, 139, 255, 0.13);
  --surface-web: #5ad18c; --surface-web-bg: rgba(90, 209, 140, 0.13);

  /* Borders / inputs / focus */
  --border: #241f33;
  --input: #2e2742;
  --ring: #8b6dff;

  /* Legacy tg-* aliases (still referenced by some shared components) */
  --tg-bg: var(--background);
  --tg-text: var(--foreground);
  --tg-hint: var(--muted-foreground);
  --tg-secondary-bg: var(--card);
  --tg-button: var(--primary);
  --tg-button-text: var(--primary-foreground);
  --tg-link: var(--brand-soft);
  --surface-2: var(--popover);

  --radius: 0.7rem;
}

@theme inline {
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);

  --font-sans: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-panel: var(--panel);
  --color-panel-border: var(--panel-border);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted-2: var(--muted-2);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-danger: var(--danger);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-brand: var(--brand);
  --color-brand-soft: var(--brand-soft);
  --color-surface-vs: var(--surface-vs);
  --color-surface-tg: var(--surface-tg);
  --color-surface-ma: var(--surface-ma);
  --color-surface-web: var(--surface-web);
}

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
  background-color: var(--background);
  color: var(--foreground);
  font-family: "Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}

* {
  box-sizing: border-box;
}

/* Signature violet aura pooling toward the top, retuned for the darker bg. */
body::before {
  content: "";
  position: fixed;
  inset: 0 0 auto 0;
  height: 55vh;
  pointer-events: none;
  z-index: 0;
  background: radial-gradient(120% 70% at 50% -12%, var(--brand-glow), transparent 60%);
}

#root {
  position: relative;
  z-index: 1;
}

::-webkit-scrollbar {
  width: 9px;
  height: 9px;
}
::-webkit-scrollbar-thumb {
  background: #2c2640;
  border-radius: 6px;
  border: 2px solid transparent;
  background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover {
  background: #3a3352;
  background-clip: content-box;
}
::-webkit-scrollbar-track {
  background: transparent;
}
* {
  scrollbar-width: thin;
  scrollbar-color: #2c2640 transparent;
}

@keyframes mpulse {
  0% { box-shadow: 0 0 0 0 rgba(90, 209, 140, 0.5); }
  70% { box-shadow: 0 0 0 5px rgba(90, 209, 140, 0); }
  100% { box-shadow: 0 0 0 0 rgba(90, 209, 140, 0); }
}
@keyframes mfade {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@keyframes mpop {
  from { opacity: 0; transform: translateY(8px) scale(0.985); }
  to { opacity: 1; transform: none; }
}

textarea,
input {
  font-family: inherit;
}
```

- [ ] **Step 5: Update the Mini App index.css (palette + font only)**

In `bridge/miniapp/web/src/index.css`, replace the `:root { ... }` block and the `@theme inline { ... }` block with the SAME two blocks from Step 4 (identical token names and values). Then update its `body` rule's `font-family` to the Geist stack from Step 4. Keep the Mini App's existing `body::before` glow, `#root`, and `textarea, input` rules (its glow already uses `--brand-glow`, which now resolves to the new value). Do NOT add the dashboard's scrollbar block unless already present. Leave all other Mini App files untouched.

- [ ] **Step 6: Build both apps**

Run:
```bash
npm --prefix bridge/dashboard/web run build && npm --prefix bridge/miniapp/web run build
```
Expected: both builds succeed (TypeScript clean, Vite emits `dist/`). Geist `font-mono` utility resolves; no "unknown utility" errors for `bg-panel`/`text-success`.

- [ ] **Step 7: Commit**

```bash
git add bridge/dashboard/web/package.json bridge/dashboard/web/package-lock.json \
        bridge/miniapp/web/package.json bridge/miniapp/web/package-lock.json \
        bridge/dashboard/web/src/main.tsx bridge/miniapp/web/src/main.tsx \
        bridge/dashboard/web/src/index.css bridge/miniapp/web/src/index.css
git commit -m "feat(ui): unified mystical palette + Geist tokens across dashboard and mini app"
```

---

## Task 2: Surface helper + lifted running poll + Header

**Files:**
- Create: `bridge/dashboard/web/src/lib/surfaces.ts`
- Modify: `bridge/dashboard/web/src/api.ts` (add `permission_mode` to `DashState`)
- Create: `bridge/dashboard/web/src/components/Header.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx` (lift running poll; render `<Header/>`)

**Interfaces:**
- Produces: `surfaceFor(origin: string | null | undefined): { code: string; label: string; color: string; bg: string }`; `ago(sec: number | null): string`; `fmtDuration(sec: number): string` from `lib/surfaces.ts`.
- Produces: `<Header/>` with props `{ projectName, port, view, onView, vscodeLive, server, preview, onServer, onPreview }`.
- Consumes (App→Header): running data lifted into App (`external`, `bridgeIds`, `awaiting`) and passed down; `DashState`.

- [ ] **Step 1: Create `lib/surfaces.ts`**

```ts
// Maps a session/run origin to its surface chip (code + colors) and shared time helpers.
export interface Surface {
  code: string;
  label: string;
  color: string; // CSS var reference
  bg: string;    // CSS var reference
}

const SURFACES: Record<string, Surface> = {
  vscode:    { code: "VS",  label: "VS Code",  color: "var(--surface-vs)",  bg: "var(--surface-vs-bg)" },
  bot:       { code: "TG",  label: "Telegram", color: "var(--surface-tg)",  bg: "var(--surface-tg-bg)" },
  miniapp:   { code: "MA",  label: "Mini App", color: "var(--surface-ma)",  bg: "var(--surface-ma-bg)" },
  dashboard: { code: "WEB", label: "Desktop",  color: "var(--surface-web)", bg: "var(--surface-web-bg)" },
  terminal:  { code: "CLI", label: "Terminal", color: "var(--muted-foreground)", bg: "rgba(156,149,176,.12)" },
};

const FALLBACK: Surface = {
  code: "··", label: "Bridge", color: "var(--muted-foreground)", bg: "rgba(156,149,176,.12)",
};

export function surfaceFor(origin: string | null | undefined): Surface {
  return SURFACES[origin ?? ""] ?? FALLBACK;
}

export function ago(sec: number | null): string {
  if (!sec) return "";
  const s = Math.max(0, Date.now() / 1000 - sec);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "2h 14m" / "47m" / "30s" from a positive duration in seconds. */
export function fmtDuration(sec: number): string {
  if (sec <= 0) return "now";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(sec)}s`;
}
```

- [ ] **Step 2: Add `permission_mode` to `DashState`**

In `bridge/dashboard/web/src/api.ts`, the `DashState` interface (currently ends at `preview: PreviewInfo;`) — add a field:
```ts
export interface DashState {
  project: Project | null;
  busy: boolean;
  busy_chat: number | null;
  server: ServerInfo;
  preview: PreviewInfo;
  permission_mode?: string | null;
}
```

- [ ] **Step 3: Create `components/Header.tsx`**

```tsx
import { Search } from "lucide-react";
import type { DashState } from "../api";

const SURFACE_CHIPS: { code: string; color: string; bg: string; title: string }[] = [
  { code: "TG", color: "var(--surface-tg)", bg: "var(--surface-tg-bg)", title: "Telegram bot" },
  { code: "MA", color: "var(--surface-ma)", bg: "var(--surface-ma-bg)", title: "Telegram Mini App" },
];

export function Header({
  projectName,
  view,
  onView,
  vscodeLive,
  state,
  onServer,
  onPreview,
}: {
  projectName: string;
  view: "chat" | "history";
  onView: (v: "chat" | "history") => void;
  vscodeLive: boolean;
  state: DashState | null;
  onServer: () => void;
  onPreview: () => void;
}) {
  const serverRunning = state?.server.status === "running";
  const previewUrl = state?.preview.url ?? null;
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-4 border-b border-panel-border bg-panel px-4">
      <div className="flex items-center gap-2.5">
        <div className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px] bg-gradient-to-br from-brand-soft to-brand text-sm font-bold text-white shadow-[0_2px_8px_rgba(124,88,255,.4)]">
          m
        </div>
        <div className="font-semibold tracking-tight">{projectName || "mystical-assistant"}</div>
      </div>

      <div className="flex items-center gap-1.5 rounded-[7px] border border-border bg-muted px-2.5 py-1">
        <span className="h-[7px] w-[7px] rounded-full bg-success [animation:mpulse_2.2s_infinite]" />
        <span className="text-xs text-muted-foreground">bridge connected</span>
        <span className="font-mono text-xs text-muted-2">· {location.host}</span>
      </div>

      <div className="flex gap-0.5 rounded-lg border border-border bg-muted p-[3px]">
        {(["chat", "history"] as const).map((v) => (
          <button
            key={v}
            onClick={() => onView(v)}
            className={`rounded-md px-3.5 py-1 text-[13px] font-medium capitalize ${
              view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {v}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1.5">
        {SURFACE_CHIPS.map((c) => (
          <div
            key={c.code}
            title={c.title}
            className="flex items-center gap-1.5 rounded-[7px] border border-border bg-muted px-2.5 py-1.5"
          >
            <span className="font-mono text-[10px] font-medium tracking-wider" style={{ color: c.color }}>
              {c.code}
            </span>
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
          </div>
        ))}
        <div
          title="VS Code on this machine"
          className="flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1.5"
          style={{
            background: vscodeLive ? "var(--surface-vs-bg)" : "var(--muted)",
            borderColor: vscodeLive ? "#3a2f6b" : "var(--border)",
          }}
        >
          <span className="font-mono text-[10px] font-medium tracking-wider" style={{ color: "var(--surface-vs)" }}>
            VS
          </span>
          <span
            className={`h-1.5 w-1.5 rounded-full ${vscodeLive ? "bg-success [animation:mpulse_2.2s_infinite]" : "bg-muted-2"}`}
          />
        </div>
      </div>

      <div className="h-6 w-px bg-border" />

      <button
        title="Command palette (coming soon)"
        className="flex items-center gap-2.5 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-[12.5px] text-muted-foreground hover:bg-accent"
      >
        <Search size={13} aria-hidden />
        <span>Search & commands</span>
        <span className="rounded-[5px] border border-input px-1.5 font-mono text-[11px] text-muted-2">⌘K</span>
      </button>

      <button
        onClick={onServer}
        className="rounded-lg border border-input bg-secondary px-3 py-1.5 text-[13px] font-medium text-foreground hover:bg-accent"
      >
        {serverRunning ? "Stop server" : "Start server"}
      </button>
      <button
        onClick={onPreview}
        className="rounded-lg border border-brand-soft bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-white hover:opacity-90"
      >
        {previewUrl ? "Stop preview" : "Preview"}
      </button>
    </header>
  );
}
```

- [ ] **Step 4: Lift the running poll into App and render Header**

In `bridge/dashboard/web/src/App.tsx`:
1. Add imports:
```tsx
import { Header } from "./components/Header";
import type { RunningSession } from "./api";
```
2. Add state near the other `useState`s:
```tsx
const [external, setExternal] = useState<RunningSession[]>([]);
const [bridgeIds, setBridgeIds] = useState<Set<string>>(new Set());
const [awaiting, setAwaiting] = useState<Map<string, "question" | "permission">>(new Map());
```
3. Add a running poll effect (alongside the other effects):
```tsx
// Machine-wide running sessions: powers the sidebar dots + header VS chip.
useEffect(() => {
  let live = true;
  const tick = async () => {
    try {
      const r = await api.running();
      if (!live) return;
      setExternal(r.external);
      setBridgeIds(new Set(r.bridge_running));
      setAwaiting(new Map((r.awaiting ?? []).map((a) => [a.session_id, a.kind])));
    } catch {
      /* ignore */
    }
  };
  void tick();
  const id = setInterval(tick, 4000);
  return () => { live = false; clearInterval(id); };
}, []);
const vscodeLive = external.some((r) => r.source === "vscode");
```
4. Replace the existing inline `<header>...</header>` block (the one containing the project name + chat/history toggle + `<ServerControls/>`) with:
```tsx
<Header
  projectName={state?.project?.name ?? ""}
  view={view}
  onView={setView}
  vscodeLive={vscodeLive}
  state={state}
  onServer={() => void api.server(state?.server.status === "running" ? "stop" : "start").catch(() => {})}
  onPreview={() => void api.preview(state?.preview.url ? "stop" : "start").catch(() => {})}
/>
```
5. Delete the now-unused `ServerControls` function at the bottom of `App.tsx`.
6. Pass the lifted running data into `<Sidebar>` by adding these props to the existing `<Sidebar ... />` usage (Sidebar consumes them in Task 4):
```tsx
external={external}
bridgeIds={bridgeIds}
awaiting={awaiting}
```
   (Sidebar still type-checks now because Task 4 adds the props; until then, if building between tasks, keep Sidebar's own poll. To keep Task 2 independently building, do NOT pass these props yet — add them in Task 4 together with Sidebar's signature change.)

   For Task 2's build to pass, render `<Header/>` and keep `<Sidebar/>` unchanged.

- [ ] **Step 5: Build**

Run:
```bash
npm --prefix bridge/dashboard/web run build
```
Expected: success. Header renders; no unused-symbol TS errors (ensure `ServerControls` removal didn't leave dangling references; `DashState` import still used).

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/web/src/lib/surfaces.ts bridge/dashboard/web/src/api.ts \
        bridge/dashboard/web/src/components/Header.tsx bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): redesigned header with bridge status, surface chips, server controls"
```

---

## Task 3: RightPanel container + restyled Logs

**Files:**
- Create: `bridge/dashboard/web/src/components/RightPanel.tsx`
- Modify: `bridge/dashboard/web/src/components/Logs.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx` (use `<RightPanel/>`)

**Interfaces:**
- Produces: `interface PanelTab { id: string; label: string; badge?: string | null; render: () => ReactNode }` and `<RightPanel tabs={PanelTab[]} />` (exported from `RightPanel.tsx`). Sub-projects B/C push tabs onto the array.
- Consumes: `<Logs lines={string[]} />`.

- [ ] **Step 1: Create `components/RightPanel.tsx`**

```tsx
import { useState, type ReactNode } from "react";

export interface PanelTab {
  id: string;
  label: string;
  badge?: string | null;
  render: () => ReactNode;
}

export function RightPanel({ tabs }: { tabs: PanelTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <aside className="flex min-h-0 w-[372px] shrink-0 flex-col border-l border-panel-border bg-panel">
      <div className="flex shrink-0 gap-0.5 border-b border-border px-3 pt-2.5">
        {tabs.map((t) => {
          const on = t.id === current?.id;
          return (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-[12.5px] font-medium ${
                on ? "border-brand-soft text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {t.badge ? (
                <span className="rounded-md bg-primary/15 px-1.5 font-mono text-[10px] text-brand-soft">
                  {t.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{current?.render()}</div>
    </aside>
  );
}
```

- [ ] **Step 2: Restyle `components/Logs.tsx`**

Replace the contents of `bridge/dashboard/web/src/components/Logs.tsx` with:
```tsx
import { useEffect, useRef } from "react";

export function Logs({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length]);
  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center gap-2 text-[11px] text-success">
        <span className="h-[7px] w-[7px] rounded-full bg-success [animation:mpulse_2.2s_infinite]" />
        <span className="font-mono">dev server logs</span>
      </div>
      <div
        ref={ref}
        className="min-h-0 flex-1 overflow-y-auto rounded-[9px] border border-border bg-[#100d18] p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
      >
        {lines.length === 0 ? (
          <div className="text-muted-2">no output</div>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="whitespace-pre-wrap">
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Use RightPanel in App**

In `bridge/dashboard/web/src/App.tsx`:
1. Replace the import of `Logs` with:
```tsx
import { RightPanel, type PanelTab } from "./components/RightPanel";
import { Logs } from "./components/Logs";
```
2. Build the tabs array just before `return (` in `App`:
```tsx
const panelTabs: PanelTab[] = [
  { id: "logs", label: "Logs", render: () => <Logs lines={logs} /> },
];
```
3. Replace the existing right-hand `<section ...><Logs .../></section>` block with:
```tsx
<RightPanel tabs={panelTabs} />
```

- [ ] **Step 4: Build**

Run:
```bash
npm --prefix bridge/dashboard/web run build
```
Expected: success. Right panel shows a "Logs" tab with restyled log box.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src/components/RightPanel.tsx \
        bridge/dashboard/web/src/components/Logs.tsx \
        bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): tabbed right panel with restyled logs (logs tab only)"
```

---

## Task 4: Sidebar restructure (ProjectSwitcher / Projects / Active sessions / Recent chats)

**Files:**
- Modify: `bridge/dashboard/web/src/components/Sidebar.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx` (pass lifted running props; remove duplicate running poll from Sidebar)
- Remove usage of: `bridge/dashboard/web/src/components/RunningNow.tsx` (folded into Sidebar's Active sessions; leave the file in place, unreferenced — do not delete pre-existing file in Sub-project A)

**Interfaces:**
- Consumes: `surfaceFor`, `ago` from `lib/surfaces.ts`; running props from App: `external: RunningSession[]`, `bridgeIds: Set<string>`, `awaiting: Map<string,"question"|"permission">`.
- Produces: `<Sidebar/>` with props `{ projectRel, sessions, selectedId, onSelectSession, onNewSession, onProjectChanged, external, bridgeIds, awaiting }`.

- [ ] **Step 1: Rewrite `components/Sidebar.tsx`**

Replace the whole file with the version below. It keeps the existing project-browse/select behavior and `byProject` grouping, removes the internal `/local/running` poll (now lifted to App), and renders three labelled sections: a project switcher + New chat, **Active sessions** (from running props), and **Recent chats** (per-repo from `sessions`).
```tsx
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { api, type ProjectsListing, type RunningSession, type SessionBrief } from "../api";
import { ago, surfaceFor } from "../lib/surfaces";

export function Sidebar({
  projectRel,
  sessions,
  selectedId,
  onSelectSession,
  onNewSession,
  onProjectChanged,
  external,
  bridgeIds,
  awaiting,
}: {
  projectRel: string | null;
  sessions: SessionBrief[];
  selectedId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onProjectChanged: () => void;
  external: RunningSession[];
  bridgeIds: Set<string>;
  awaiting: Map<string, "question" | "permission">;
}) {
  const [listing, setListing] = useState<ProjectsListing | null>(null);
  const [browsing, setBrowsing] = useState(false);

  async function load(dir: string) {
    try {
      setListing(await api.projects(dir === "/" ? undefined : dir));
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    if (browsing && !listing) void load("/");
  }, [browsing, listing]);

  async function useFolder() {
    if (!listing) return;
    try {
      await api.select(listing.rel);
      setBrowsing(false);
      onProjectChanged();
    } catch {
      /* ignore */
    }
  }

  // Sessions arrive ordered by (project, updated DESC) — each group is latest-first.
  const byProject = new Map<string, SessionBrief[]>();
  for (const s of sessions) {
    const a = byProject.get(s.project) ?? [];
    a.push(s);
    byProject.set(s.project, a);
  }

  // Active sessions: bridge runs (clickable) + external (read-only).
  const bridgeRows = sessions.filter((s) => bridgeIds.has(s.id));

  return (
    <aside className="flex h-full w-[312px] shrink-0 flex-col border-r border-panel-border bg-panel">
      <div className="relative shrink-0 p-3.5 pb-2.5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <button
            onClick={() => setBrowsing((v) => !v)}
            className="flex min-w-0 items-center gap-2"
            title={projectRel ?? ""}
          >
            <span className="truncate font-mono text-[13px] font-medium text-foreground">
              /{projectRel ?? "no project"}
            </span>
            <ChevronDown size={12} className="shrink-0 text-muted-2" aria-hidden />
          </button>
          <button
            onClick={() => setBrowsing((v) => !v)}
            className="shrink-0 text-xs text-brand-soft hover:text-foreground"
          >
            {browsing ? "close" : "change"}
          </button>
        </div>

        {browsing && listing && (
          <div className="mb-2 rounded-md border border-border bg-popover p-2 text-xs [animation:mpop_.14s_ease]">
            <div className="mb-1 font-mono text-muted-foreground">{listing.rel}</div>
            <div className="max-h-40 space-y-0.5 overflow-y-auto">
              {listing.can_up && (
                <button
                  className="block w-full text-left text-muted-foreground hover:text-foreground"
                  onClick={() => void load(listing.rel.replace(/\/[^/]+$/, "") || "/")}
                >
                  ⬆ ..
                </button>
              )}
              {listing.dirs.map((d) => (
                <button
                  key={d}
                  className="block w-full truncate text-left hover:text-foreground"
                  onClick={() => void load(listing.rel === "/" ? `/${d}` : `${listing.rel}/${d}`)}
                >
                  📁 {d}
                </button>
              ))}
            </div>
            <button
              className="mt-2 w-full rounded bg-primary py-1 text-primary-foreground hover:opacity-90"
              onClick={() => void useFolder()}
            >
              Use {listing.rel}
            </button>
          </div>
        )}

        <button
          onClick={onNewSession}
          className="flex w-full items-center justify-center gap-2 rounded-[9px] border border-border bg-popover py-2.5 text-[13px] font-medium text-foreground hover:border-ring"
        >
          <span className="text-base leading-none text-brand-soft">+</span> New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        {(bridgeRows.length > 0 || external.length > 0) && (
          <>
            <SectionLabel pulse>Active sessions</SectionLabel>
            {bridgeRows.map((s) => {
              const surf = surfaceFor(s.origin);
              const kind = awaiting.get(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => onSelectSession(s.id)}
                  className="mb-0.5 flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left hover:bg-accent"
                >
                  <SurfaceTag surf={surf} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-foreground">{s.title || "New chat"}</span>
                    <span className="block font-mono text-[10.5px] text-muted-2">this machine · {ago(s.updated)}</span>
                  </span>
                  <StatusTag color={kind ? "var(--warning)" : "var(--success)"} label={kind ? "waiting" : "running"} />
                </button>
              );
            })}
            {external.map((r) => {
              const surf = surfaceFor(r.source);
              return (
                <div
                  key={r.session_id}
                  title={r.cwd}
                  className="mb-0.5 flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left"
                >
                  <SurfaceTag surf={surf} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-foreground">{r.project}</span>
                    <span className="block font-mono text-[10.5px] text-muted-2">{r.source} · {ago(r.started)}</span>
                  </span>
                  <StatusTag
                    color={r.status === "waiting" ? "var(--warning)" : "var(--success)"}
                    label={r.status === "waiting" ? "waiting" : "running"}
                  />
                </div>
              );
            })}
          </>
        )}

        <SectionLabel>Recent chats</SectionLabel>
        {[...byProject.entries()].map(([proj, ss]) => (
          <div key={proj} className="mb-2.5">
            <div className="flex items-center justify-between px-1.5 py-1">
              <span className="truncate font-mono text-[10.5px] text-muted-foreground" title={proj}>
                /{proj}
              </span>
              <span className="shrink-0 rounded-[5px] bg-popover px-1.5 text-[10px] text-muted-2">{ss.length}</span>
            </div>
            {ss.map((s) => {
              const on = s.id === selectedId;
              const running = bridgeIds.has(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => onSelectSession(s.id)}
                  className={`mb-1 flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left ${
                    on ? "border-ring bg-[#1c162c]" : "border-transparent hover:bg-accent"
                  }`}
                >
                  {running && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />}
                  <span className={`min-w-0 flex-1 truncate text-[12.5px] ${on ? "text-foreground" : "text-card-foreground"}`}>
                    {s.title || "New chat"}
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-2">{ago(s.updated)}</span>
                </button>
              );
            })}
          </div>
        ))}
        {sessions.length === 0 && <div className="p-3 text-xs text-muted-foreground">No sessions yet.</div>}
      </div>
    </aside>
  );
}

function SectionLabel({ children, pulse }: { children: React.ReactNode; pulse?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-1.5 pb-2 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-muted-2">
      {children}
      {pulse && <span className="h-1.5 w-1.5 rounded-full bg-success [animation:mpulse_2.2s_infinite]" />}
    </div>
  );
}

function SurfaceTag({ surf }: { surf: { code: string; color: string; bg: string } }) {
  return (
    <span
      className="flex w-6 shrink-0 justify-center rounded-[5px] py-[3px] text-center font-mono text-[9.5px] font-medium tracking-wide"
      style={{ color: surf.color, background: surf.bg }}
    >
      {surf.code}
    </span>
  );
}

function StatusTag({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span className="h-[7px] w-[7px] rounded-full" style={{ background: color }} />
      <span className="text-[10px]" style={{ color }}>{label}</span>
    </span>
  );
}
```

- [ ] **Step 2: Wire lifted running props into `<Sidebar/>`**

In `bridge/dashboard/web/src/App.tsx`, update the `<Sidebar ... />` usage to pass the lifted running data (added to App in Task 2):
```tsx
<Sidebar
  projectRel={projectRel}
  sessions={sessions}
  selectedId={sessionId}
  onSelectSession={openSession}
  onNewSession={() => void newSession()}
  onProjectChanged={() => void loadSessions()}
  external={external}
  bridgeIds={bridgeIds}
  awaiting={awaiting}
/>
```

- [ ] **Step 3: Build**

Run:
```bash
npm --prefix bridge/dashboard/web run build
```
Expected: success. (Note: `RunningNow.tsx` and `ChevronRight`/`CircleHelp` are no longer imported by Sidebar — ensure no leftover imports remain in `Sidebar.tsx`. `RunningNow.tsx` stays on disk, unreferenced; that's fine and produces no build error since unused files aren't compiled into the bundle.)

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/web/src/components/Sidebar.tsx bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): restructured sidebar — project switcher, active sessions, recent chats"
```

---

## Task 5: ChatHeader + restyled Transcript / RunStream

**Files:**
- Create: `bridge/dashboard/web/src/components/ChatHeader.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx` (render `<ChatHeader/>`)
- Modify: `bridge/dashboard/web/src/components/Transcript.tsx`
- Modify: `bridge/dashboard/web/src/components/RunStream.tsx`

**Interfaces:**
- Produces: `<ChatHeader/>` with props `{ title, origin, model, turnCount }`.
- Consumes: `surfaceFor` from `lib/surfaces.ts`; `Turn[]` (for count) from `chat.ts`.

- [ ] **Step 1: Create `components/ChatHeader.tsx`**

```tsx
import { surfaceFor } from "../lib/surfaces";

export function ChatHeader({
  title,
  origin,
  model,
  turnCount,
}: {
  title: string;
  origin: string | null | undefined;
  model: string;
  turnCount: number;
}) {
  const surf = surfaceFor(origin);
  return (
    <div className="flex h-[46px] shrink-0 items-center gap-3 border-b border-[#1c1828] px-5">
      <span className="truncate text-sm font-semibold">{title || "New chat"}</span>
      <span
        className="shrink-0 rounded-md border px-2 py-0.5 font-mono text-[11px]"
        style={{ color: surf.color, background: surf.bg, borderColor: surf.color + "55" }}
      >
        {surf.label} · this machine
      </span>
      <div className="flex-1" />
      <span className="shrink-0 font-mono text-[11.5px] text-muted-2">
        {model} · {turnCount} {turnCount === 1 ? "turn" : "turns"}
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Render ChatHeader in App**

In `bridge/dashboard/web/src/App.tsx`:
1. Import:
```tsx
import { ChatHeader } from "./components/ChatHeader";
```
2. Derive the selected session brief near the top of `App` body:
```tsx
const selected = sessions.find((s) => s.id === sessionId) ?? null;
```
3. In the `chat` branch (the `<> ... </>` that renders Transcript + Composer), add `<ChatHeader/>` as the FIRST child, before the transcript scroll div:
```tsx
<ChatHeader
  title={selected?.title ?? ""}
  origin={selected?.origin}
  model={model}
  turnCount={turns.length}
/>
```

- [ ] **Step 3: Restyle `components/Transcript.tsx`**

Replace its body's JSX styling — the user-prompt bubble and "Working…" — to match the mockup. Replace the file with:
```tsx
import type { AnswerSelection } from "../api";
import type { PendingRequest, Turn } from "../chat";
import { RunStream } from "./RunStream";

type Respond = (
  requestId: string,
  opts: { behavior?: "allow" | "deny"; answers?: AnswerSelection[] },
) => void;

export function Transcript({
  turns,
  activeId,
  onRespond,
}: {
  turns: Turn[];
  activeId: string | null;
  onRespond: Respond;
}) {
  if (!turns.length) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No messages in this session yet.
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-[18px] px-6">
      {turns.map((turn) => {
        const isActive = turn.id === activeId;
        const working = isActive && turn.status === "running" && turn.pending.length === 0;
        return (
          <div key={turn.id} className="flex flex-col gap-2.5">
            {turn.prompt && (
              <div className="self-end max-w-[78%] whitespace-pre-wrap rounded-[14px] rounded-br-[4px] bg-primary px-[15px] py-[11px] text-[13.5px] leading-relaxed text-primary-foreground shadow-[0_4px_14px_rgba(116,88,255,.25)]">
                {turn.prompt}
              </div>
            )}
            {(turn.events.length > 0 || turn.status === "running") && (
              <RunStream
                events={turn.events}
                pending={turn.pending as PendingRequest[]}
                onRespond={isActive ? onRespond : undefined}
              />
            )}
            {working && <div className="text-xs text-muted-foreground">Working…</div>}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Restyle the message rows in `components/RunStream.tsx`**

In `bridge/dashboard/web/src/components/RunStream.tsx`, update only the `text`, `tool`, and `result`(`FinalResult`) renderings (keep permission/question/error/stopped logic untouched):

Replace the `text` case JSX:
```tsx
case "text":
  return (
    <div key={i} className="max-w-[92%] text-[14px] leading-[1.62] text-card-foreground">
      {event.text}
    </div>
  );
```
Replace the `tool` case JSX:
```tsx
case "tool":
  return (
    <div
      key={i}
      className="flex max-w-[92%] items-center gap-2.5 rounded-[10px] border border-border bg-card px-3 py-2 font-mono"
    >
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-muted">
        <ToolIcon name={event.name} />
      </span>
      <span className="shrink-0 text-[11px] font-medium text-brand-soft">{event.name}</span>
      {event.summary && (
        <span className="min-w-0 truncate text-[12px] text-muted-foreground">{event.summary}</span>
      )}
    </div>
  );
```
Replace the `FinalResult` component body with the gradient-bar summary card:
```tsx
function FinalResult({
  result,
  elapsed,
  cost,
}: {
  result: string;
  elapsed?: number;
  cost?: number;
}) {
  return (
    <div className="flex max-w-[92%] gap-3 rounded-xl border border-[#2a2540] bg-card px-4 py-3.5">
      <span className="w-2 shrink-0 rounded-[5px] bg-gradient-to-b from-brand-soft to-success" />
      <div className="min-w-0">
        <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-card-foreground">{result}</div>
        {(typeof elapsed === "number" || typeof cost === "number") && (
          <div className="mt-1.5 text-xs text-muted-2">
            {typeof elapsed === "number" ? `${elapsed.toFixed(1)}s` : ""}
            {typeof elapsed === "number" && typeof cost === "number" ? " · " : ""}
            {typeof cost === "number" ? `$${cost.toFixed(4)}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Remove the now-redundant transcript wrapper padding in App**

In `App.tsx`, the transcript scroll container currently is `<div className="flex-1 overflow-y-auto px-4 py-4">`. Since `Transcript` now centers itself with `max-w-[760px]`, change that wrapper to:
```tsx
<div className="flex-1 overflow-y-auto py-6">
```
(Keep the `error` block inside it; wrap the error in `mx-auto max-w-[760px] px-6` so it stays aligned:)
```tsx
{error && (
  <div className="mx-auto mt-2 max-w-[760px] px-6">
    <div className="rounded bg-red-500/15 px-2 py-1 text-sm text-red-300">{error}</div>
  </div>
)}
```

- [ ] **Step 6: Build**

Run:
```bash
npm --prefix bridge/dashboard/web run build
```
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add bridge/dashboard/web/src/components/ChatHeader.tsx \
        bridge/dashboard/web/src/components/Transcript.tsx \
        bridge/dashboard/web/src/components/RunStream.tsx \
        bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): chat header + restyled message stream"
```

---

## Task 6: Composer restyle + real context strip + accept-edits chip

**Files:**
- Modify: `bridge/dashboard/web/src/components/Composer.tsx`
- Modify: `bridge/dashboard/web/src/components/UsageStrip.tsx` (replace with a richer `ContextStrip`, or extend in place)
- Modify: `bridge/dashboard/web/src/App.tsx` (pass `permissionMode` to Composer)

**Interfaces:**
- Consumes: `UsageInfo` from `api.ts` (`five_hour.percent`, `five_hour.resets_at`), `fmtDuration` from `lib/surfaces.ts`, `state.permission_mode`.
- Produces: `<Composer ... permissionMode={string | null | undefined} />`.

- [ ] **Step 1: Replace `UsageStrip.tsx` with a context meter**

Replace the contents of `bridge/dashboard/web/src/components/UsageStrip.tsx` with a `ContextStrip` that shows a meter (percent remaining of the 5h window), the reset countdown, and the read-only accept-edits chip:
```tsx
import { useEffect, useState } from "react";
import { api, type UsageInfo } from "../api";
import { fmtDuration } from "../lib/surfaces";

const MODE_LABEL: Record<string, string> = {
  default: "ask each time",
  acceptEdits: "accept edits",
  plan: "plan mode",
  bypassPermissions: "bypass perms",
};

function resetsIn(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  return fmtDuration((t - Date.now()) / 1000);
}

export function ContextStrip({ permissionMode }: { permissionMode?: string | null }) {
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const u = await api.usage();
        if (live) setUsage(u);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = setInterval(tick, 60000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const fh = usage?.available ? usage.five_hour : null;
  const left = fh ? Math.max(0, 100 - fh.percent) : null;
  const reset = resetsIn(fh?.resets_at);
  const modeLabel = permissionMode ? MODE_LABEL[permissionMode] ?? permissionMode : null;

  if (left === null && !modeLabel) return null;

  return (
    <div className="mb-2.5 flex items-center gap-3 px-1 font-mono text-[11.5px]">
      {left !== null && (
        <div className="flex flex-1 items-center gap-2">
          <span className="text-muted-foreground">context</span>
          <div className="h-[5px] max-w-[160px] flex-1 overflow-hidden rounded-[3px] bg-panel-border">
            <div
              className="h-full rounded-[3px] bg-gradient-to-r from-success to-brand-soft"
              style={{ width: `${left}%` }}
            />
          </div>
          <span className="text-[#a99fd0]">{left}% left</span>
        </div>
      )}
      {left !== null && reset && <span className="text-muted-2">·</span>}
      {reset && (
        <span className="text-muted-foreground">
          resets <span className="text-[#a99fd0]">in {reset}</span>
        </span>
      )}
      {modeLabel && <span className="text-muted-2">·</span>}
      {modeLabel && (
        <div className="flex items-center gap-1.5 rounded-[7px] border border-ring/40 bg-[#211a39] px-2.5 py-[3px]">
          <span className="h-1.5 w-1.5 rounded-full bg-warning" />
          <span className="text-foreground">{modeLabel}</span>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Restyle `Composer.tsx` and use `ContextStrip`**

In `bridge/dashboard/web/src/components/Composer.tsx`:
1. Change the import `import { UsageStrip } from "./UsageStrip";` to `import { ContextStrip } from "./UsageStrip";`.
2. Add `permissionMode` to the props type and destructure it:
```tsx
permissionMode?: string | null;
```
3. Replace `<UsageStrip />` with `<ContextStrip permissionMode={permissionMode} />`.
4. Update the outer wrapper and the textarea container to the mockup card styling — replace the outer `<div className="border-t border-border bg-card p-3">` with:
```tsx
<div className="shrink-0 border-t border-[#1c1828] px-6 pb-[18px] pt-3.5">
  <div className="mx-auto max-w-[760px]">
```
   and close the extra `</div>` before the component's final closing tag. Wrap the model/effort/attach row and the textarea row inside a card:
```tsx
<div className="rounded-[14px] border border-input bg-[#161220] p-3.5">
  {/* existing model/effort/attach row */}
  {/* existing textarea + Send row */}
</div>
```
   Keep all existing handlers, `MODELS`, `EFFORTS`, `addFiles`, `submit`, the file input, and the Send/Stop buttons exactly as they are — only the wrapping markup/classes change. Ensure the JSX remains balanced (the new `mx-auto max-w-[760px]` div and the card div each get a matching close).

- [ ] **Step 3: Pass permissionMode from App**

In `bridge/dashboard/web/src/App.tsx`, add to the `<Composer ... />` usage:
```tsx
permissionMode={state?.permission_mode}
```

- [ ] **Step 4: Build**

Run:
```bash
npm --prefix bridge/dashboard/web run build
```
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src/components/Composer.tsx \
        bridge/dashboard/web/src/components/UsageStrip.tsx \
        bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): composer redesign with real context meter + accept-edits chip"
```

---

## Task 7: Full-app layout polish + integration verification

**Files:**
- Modify: `bridge/dashboard/web/src/App.tsx` (root layout container classes)

**Interfaces:** none new.

- [ ] **Step 1: Confirm the root layout**

In `App.tsx`, ensure the structure is: a full-height column with `<Header/>` on top, then a `flex min-h-0 flex-1` row containing `<Sidebar/>`, `<main className="flex min-w-0 flex-1 flex-col bg-background">…</main>`, and `<RightPanel/>`. Replace the outermost `return` wrapper `<div className="flex h-full">` with:
```tsx
<div className="flex h-full flex-col">
  <Header ... />
  <div className="flex min-h-0 flex-1">
    <Sidebar ... />
    <main className="flex min-w-0 flex-1 flex-col bg-background">
      {view === "history" ? (
        <HistoryView onOpen={(s) => void openFromHistory(s)} />
      ) : (
        <>
          <ChatHeader ... />
          <div className="flex-1 overflow-y-auto py-6"> ... </div>
          <Composer ... />
        </>
      )}
    </main>
    <RightPanel tabs={panelTabs} />
  </div>
</div>
```
(Move `<Header/>` out of `<main>` to the top-level column; the old `<header>` inside `<main>` is already removed from Task 2. The History view stays inside `<main>` so the sidebar + right panel persist across Chat/History.)

- [ ] **Step 2: Build both apps**

Run:
```bash
npm --prefix bridge/dashboard/web run build && npm --prefix bridge/miniapp/web run build
```
Expected: both succeed.

- [ ] **Step 3: Manual smoke (dashboard)**

Start the bridge per `run.sh` / README, open the dashboard URL (with `?token=`), and verify:
- Header: logo, "bridge connected · host", Chat/History toggle, surface chips, ⌘K button, Start server / Preview.
- Sidebar: project switcher (`change` opens browser), New chat, Active sessions (if any running), Recent chats grouped per repo.
- Center: chat header (title · surface · model·turns), message stream styling, composer with context meter (if usage available) + accept-edits chip.
- Right panel: Logs tab streams dev-server logs.
- A round-trip message still sends and streams.

- [ ] **Step 4: Manual smoke (Mini App)**

Build + screenshot per the project's screenshot-miniapp headless flow; confirm the new palette + Geist apply with no layout regression.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A bridge/dashboard/web bridge/miniapp/web
git commit -m "feat(dashboard): final layout integration for mystical shell re-skin"
```

---

## Self-Review

**Spec coverage:**
- Token re-point (values, keep names), both clients → Task 1. ✓
- New semantic + surface tokens → Task 1. ✓
- Geist self-hosted → Task 1. ✓
- Header (logo, bridge pill, toggle, surface chips w/ real VS, ⌘K inert, server/preview) → Task 2. ✓
- Sidebar (switcher, projects→recent-chats per repo, active sessions) → Task 4. ✓
- ChatHeader (title, origin badge, model·turns) → Task 5. ✓
- Message stream restyle → Task 5. ✓
- Composer context meter (real usage), accept-edits chip (real permission_mode, read-only) → Task 6. ✓
- RightPanel tab container, Logs only → Task 3. ✓
- Layout proportions (312 / flex / 372) → Tasks 3,4,7. ✓
- Verification = build both + smoke → Tasks 1–7. ✓
- Deferred placeholders not faked (⌘K inert, no git/issues/diff tabs, git-badge slot empty) → respected across tasks. ✓

**Placeholder scan:** No "TBD/TODO/handle edge cases"; every code step has concrete code. ✓

**Type consistency:** `surfaceFor`/`ago`/`fmtDuration` signatures match across surfaces.ts, Sidebar, ChatHeader, ContextStrip. `PanelTab` shape consistent between RightPanel and App. `permission_mode` added to `DashState` (Task 2) before consumed (Task 6). Running props (`external`/`bridgeIds`/`awaiting`) added to App in Task 2, consumed by Sidebar in Task 4 with matching types. ✓
