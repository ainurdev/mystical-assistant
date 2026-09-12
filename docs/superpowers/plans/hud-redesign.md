# Mystical Assistant HUD Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended for this coupled reskin) or superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the violet dashboard shell with the sci-fi CRT terminal HUD — new tokens/fonts/layout, real-derived telemetry, reskinned feature components — and re-theme the Mini App to match.

**Architecture:** Frontend-only. Rewrite shared `index.css` tokens to the HUD palette + primitives; rebuild `App.tsx` into the HUD grid (strip · 344/1fr/368 · status bar) with new `components/hud/*` panels; reskin existing feature components (RunStream/Transcript/Composer/GitTab/IssuesTab/DiffTab/Logs/CommandPalette/RightPanel) keeping their props/logic. Telemetry derives from real state via a `useTelemetry` hook.

**Tech Stack:** React 19 + Vite + Tailwind v4 + TS; `@fontsource/share-tech-mono` + `@fontsource/jetbrains-mono` (installed).

## Global Constraints

- Both `index.css` files keep token NAMES, swap VALUES to HUD; stay in sync.
- Re-theme BOTH clients (tokens+fonts+`.crt`); Mini App keeps its layout.
- No backend changes; backend suites must stay green.
- Telemetry is real-derived — no fabricated metrics; omit latency/raw-token-counts.
- Per-task verify = `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build` (and miniapp where noted).
- Preserve existing behavior: Markdown in RunStream, scroll-to-latest, commit/push, issue-create, palette, model/effort.
- Reuse `lib/surfaces.ts` (`surfaceFor`, `ago`). Match existing functional-component style.

## File Structure

New: `src/lib/telemetry.ts`; `src/components/hud/{Panel,Strip,StatusBar,WorkspacePanel,TelemetryPanel,ContextMatrixPanel,ProjectsPanel,SessionsPanel,Terminal}.tsx`.
Rewrite: `src/index.css` (×2), `src/main.tsx` (×2), `src/App.tsx`.
Reskin: `RunStream,Transcript,Composer,GitTab,IssuesTab,DiffTab,Logs,CommandPalette,RightPanel`.
Retire: `Header.tsx`, `ChatHeader.tsx`, `Sidebar.tsx` (delete once App no longer imports them).

---

## Task 1: HUD theme foundation (both clients)

**Files:** `src/main.tsx` (×2), `src/index.css` (×2).

- [ ] **Step 1: Swap font imports** in BOTH `bridge/dashboard/web/src/main.tsx` and `bridge/miniapp/web/src/main.tsx` — replace the six `@fontsource/geist*` lines with:
```ts
import "@fontsource/share-tech-mono/400.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";
```

- [ ] **Step 2: Rewrite `bridge/dashboard/web/src/index.css`** — keep the `@import "tailwindcss";` line and the existing `.md` markdown block at the bottom (the user added it); replace everything between with the HUD tokens/primitives:
```css
@import "tailwindcss";

:root {
  color-scheme: dark;
  /* === HUD identity (dashboard + Mini App). Keep both index.css in sync. === */
  --background: #060a0a;
  --panel: rgba(9, 16, 16, 0.5);
  --card: rgba(7, 13, 13, 0.6);
  --card-foreground: #bfe6de;
  --popover: rgba(7, 13, 13, 0.97);
  --popover-foreground: #dff8f2;
  --foreground: #bfe6de;
  --foreground-bright: #dff8f2;

  --primary: #7fe9d8;
  --primary-foreground: #060a0a;
  --brand: #7fe9d8;
  --brand-soft: #7fe9d8;
  --brand-bright: #dff8f2;

  --secondary: rgba(127, 233, 216, 0.08);
  --secondary-foreground: #bfe6de;
  --muted: rgba(127, 233, 216, 0.05);
  --muted-foreground: #6f938d;
  --muted-2: #3c544f;
  --accent: rgba(127, 233, 216, 0.08);
  --accent-foreground: #dff8f2;

  --success: #8fd9a8;
  --warning: #e3c279;
  --danger: #e0897a;
  --destructive: #e0897a;
  --destructive-foreground: #060a0a;
  --violet: #b9a6ff;
  --blue: #6fb5ff;

  /* Surface chips: VS=teal, WEB=green, TG=blue, MA=violet */
  --surface-vs: #7fe9d8;  --surface-vs-bg: rgba(127, 233, 216, 0.08);
  --surface-tg: #6fb5ff;  --surface-tg-bg: rgba(111, 181, 255, 0.06);
  --surface-ma: #b9a6ff;  --surface-ma-bg: rgba(185, 166, 255, 0.06);
  --surface-web: #8fd9a8; --surface-web-bg: rgba(143, 217, 168, 0.06);

  --border: rgba(127, 233, 216, 0.16);
  --border-bright: rgba(127, 233, 216, 0.4);
  --input: rgba(127, 233, 216, 0.2);
  --ring: #7fe9d8;

  /* legacy tg-* aliases still referenced by shared components */
  --tg-bg: var(--background);
  --tg-text: var(--foreground);
  --tg-hint: var(--muted-foreground);
  --tg-secondary-bg: var(--card);
  --tg-button: var(--primary);
  --tg-button-text: var(--primary-foreground);
  --tg-link: var(--primary);
  --surface-2: var(--panel);

  --radius: 0;
}

@theme inline {
  --radius-sm: 0px; --radius-md: 0px; --radius-lg: 0px; --radius-xl: 0px;
  --font-sans: "Share Tech Mono", "JetBrains Mono", ui-monospace, monospace;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;

  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-panel: var(--panel);
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
  --color-violet: var(--violet);
  --color-blue: var(--blue);
  --color-border: var(--border);
  --color-border-bright: var(--border-bright);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-brand: var(--brand);
  --color-brand-soft: var(--brand-soft);
  --color-brand-bright: var(--brand-bright);
  --color-foreground-bright: var(--foreground-bright);
  --color-surface-vs: var(--surface-vs);
  --color-surface-tg: var(--surface-tg);
  --color-surface-ma: var(--surface-ma);
  --color-surface-web: var(--surface-web);
}

html, body, #root { height: 100%; }
body {
  margin: 0;
  background: #060a0a;
  color: var(--foreground);
  font-family: "Share Tech Mono", "JetBrains Mono", ui-monospace, monospace;
  -webkit-font-smoothing: antialiased;
}
* { box-sizing: border-box; }
#root { position: relative; z-index: 1; height: 100%; }

::selection { background: rgba(127, 233, 216, 0.25); color: #eafffb; }
::-webkit-scrollbar { width: 7px; height: 7px; }
::-webkit-scrollbar-thumb { background: rgba(127, 233, 216, 0.22); }
::-webkit-scrollbar-thumb:hover { background: rgba(127, 233, 216, 0.4); }
::-webkit-scrollbar-track { background: transparent; }
* { scrollbar-width: thin; scrollbar-color: rgba(127,233,216,.22) transparent; }

textarea, input { font-family: var(--font-mono); }

/* HUD primitives */
.glow { text-shadow: 0 0 8px rgba(127, 233, 216, 0.35); }
.panel { position: relative; }
.panel::before, .panel::after {
  content: ""; position: absolute; width: 12px; height: 12px;
  border: 1px solid rgba(127, 233, 216, 0.6); pointer-events: none; z-index: 3;
}
.panel::before { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.panel::after { right: -1px; bottom: -1px; border-left: 0; border-top: 0; }
.crt {
  position: fixed; inset: 0; pointer-events: none; z-index: 80; opacity: 0.5;
  background: repeating-linear-gradient(0deg, rgba(0,0,0,0) 0, rgba(0,0,0,0) 2px, rgba(0,0,0,.22) 3px, rgba(0,0,0,0) 4px);
}
.sweep {
  position: fixed; left: 0; right: 0; top: 0; height: 180px; pointer-events: none; z-index: 79;
  background: linear-gradient(180deg, transparent, rgba(127,233,216,.045), transparent);
  animation: sweepmove 8s linear infinite;
}

@keyframes sweepmove { 0% { transform: translateY(-200px); } 100% { transform: translateY(100vh); } }
@keyframes boot { 0% { transform: translateY(10px) scale(.997); filter: brightness(2.6) saturate(.5); } 55% { filter: brightness(1.25); } 100% { transform: none; filter: none; } }
@keyframes flicker { 0% { filter: brightness(.35); } 9% { filter: brightness(2.2); } 13% { filter: brightness(.6); } 22% { filter: brightness(1.5); } 100% { filter: none; } }
@keyframes drawline { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes mpulse { 0% { box-shadow: 0 0 0 0 rgba(143,217,168,.55); } 70% { box-shadow: 0 0 0 6px rgba(143,217,168,0); } 100% { box-shadow: 0 0 0 0 rgba(143,217,168,0); } }
@keyframes mfadeup { from { transform: translateY(8px); filter: brightness(1.6); } to { transform: none; filter: none; } }
@keyframes mslide { from { transform: translateX(10px); filter: brightness(1.5); } to { transform: none; filter: none; } }
@keyframes mpop { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes grow { from { width: 0; } }
@keyframes twinkle { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
@keyframes caret { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
```
Keep the existing `.md { … }` markdown rules that follow (append them after this block unchanged). Update `.md a`/`.md strong` color references — they use `var(--brand-soft)`/`var(--foreground)`, which still resolve.

- [ ] **Step 3: Rewrite `bridge/miniapp/web/src/index.css`** — same `:root` + `@theme inline` blocks + the `body`/`::selection`/scrollbar/`textarea` rules + `.glow`/`.panel`/`.crt`/`.sweep`/keyframes as Step 2. Keep the Mini App's existing `body::before` glow removed (replaced by `.crt` which the Mini App root will add later) OR retain a faint version — set `body::before` to none here (HUD has no violet aura). Keep `#root` and `textarea,input` rules. No `.md` block needed unless already present.

- [ ] **Step 4: Build both**
```bash
npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build
npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/miniapp/web run build
```
Expected: both succeed; HUD fonts bundle; no unknown-utility errors (note `bg-panel`, `text-violet`, etc. aren't used yet — they compile when used in later tasks).

- [ ] **Step 5: Commit**
```bash
git add bridge/dashboard/web/package.json bridge/dashboard/web/package-lock.json \
        bridge/miniapp/web/package.json bridge/miniapp/web/package-lock.json \
        bridge/dashboard/web/src/main.tsx bridge/miniapp/web/src/main.tsx \
        bridge/dashboard/web/src/index.css bridge/miniapp/web/src/index.css
git commit -m "feat(ui): HUD theme foundation — teal CRT tokens + mono fonts (both clients)"
```

---

## Task 2: Telemetry lib

**Files:** Create `bridge/dashboard/web/src/lib/telemetry.ts`.

**Interfaces:** `useTelemetry({running, toolCount, eventCount}) -> {clock,date,uptime,sparkA,sparkB,wave}`; `poly(arr,w,h,pad)`, `wavePoly(arr,w,h)`, `avg(arr)`.

- [ ] **Step 1: Create `lib/telemetry.ts`**
```ts
import { useEffect, useRef, useState } from "react";

const p2 = (n: number) => String(n).padStart(2, "0");

export function poly(arr: number[], w: number, h: number, pad: number): string {
  if (!arr.length) return "";
  const min = Math.min(...arr), max = Math.max(...arr), rng = max - min || 1, n = arr.length;
  return arr
    .map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(pad + (1 - (v - min) / rng) * (h - 2 * pad)).toFixed(1)}`)
    .join(" ");
}

export function wavePoly(arr: number[], w: number, h: number): string {
  if (!arr.length) return "";
  const n = arr.length, mid = h / 2;
  return arr
    .map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(mid - v * (h / 2 - 3)).toFixed(1)}`)
    .join(" ");
}

export function avg(arr: number[]): number {
  return arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
}

const seed = (n: number, base: number, amp: number) =>
  Array.from({ length: n }, (_, i) => base + Math.sin(i / 3) * amp);

/** 1s-tick telemetry buffers driven by real signals (running state, tool/event
 *  deltas). Jitter is cosmetic smoothing; the trend is the real signal. */
export function useTelemetry({
  running,
  toolCount,
  eventCount,
}: {
  running: boolean;
  toolCount: number;
  eventCount: number;
}) {
  const [t, setT] = useState(() => ({
    clock: "--:--:--",
    date: "",
    uptime: "00:00",
    sparkA: seed(40, 30, 8),
    sparkB: seed(40, 20, 6),
    wave: seed(52, 0, 0),
  }));
  const mount = useRef(Date.now());
  const last = useRef({ toolCount, eventCount });

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const clock = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
      const date = d
        .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
        .toUpperCase();
      const upSec = Math.floor((Date.now() - mount.current) / 1000);
      const uptime = `${p2(Math.floor(upSec / 60))}:${p2(upSec % 60)}`;
      const dTool = Math.max(0, toolCount - last.current.toolCount);
      const dEvent = Math.max(0, eventCount - last.current.eventCount);
      last.current = { toolCount, eventCount };
      setT((s) => {
        const aTarget = running ? 78 + Math.random() * 22 : 12 + Math.random() * 8;
        const a = s.sparkA[s.sparkA.length - 1] * 0.6 + aTarget * 0.4;
        const b = Math.min(100, dTool * 40 + (running ? 25 : 5) + Math.random() * 8);
        const wv = dEvent > 0 ? (Math.random() - 0.5) * 2 : (Math.random() - 0.5) * 0.35;
        return {
          clock, date, uptime,
          sparkA: [...s.sparkA.slice(1), a],
          sparkB: [...s.sparkB.slice(1), b],
          wave: [...s.wave.slice(1), wv],
        };
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running, toolCount, eventCount]);

  return t;
}
```

- [ ] **Step 2: Build** — `npm --prefix …/dashboard/web run build` (compiles though unused). Expected: success.

- [ ] **Step 3: Commit**
```bash
git add bridge/dashboard/web/src/lib/telemetry.ts
git commit -m "feat(dashboard): real-derived telemetry hook (clock, uptime, sparklines, waveform)"
```

---

## Task 3: HUD primitives + shell scaffold (App grid)

**Files:** Create `components/hud/{Panel,Strip,StatusBar}.tsx`; rewrite `App.tsx`'s return/layout (keep ALL hooks/state/handlers from the current file).

- [ ] **Step 1: `components/hud/Panel.tsx`**
```tsx
import type { ReactNode } from "react";

export function Panel({
  title,
  label = "PANEL",
  className = "",
  delay = "0s",
  flex,
  children,
}: {
  title: ReactNode;
  label?: string;
  className?: string;
  delay?: string;
  flex?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`panel border border-border bg-panel ${flex ? "flex min-h-0 flex-1 flex-col" : "flex-none"} ${className}`}
      style={{ animation: `boot .5s ease both ${delay}` }}
    >
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[10.5px] tracking-[2.5px] text-muted-2">{label}</span>
        <span className="text-[10.5px] tracking-[2.5px] text-primary">{title}</span>
      </div>
      <div
        className="h-px flex-none origin-left"
        style={{
          background: "linear-gradient(90deg,#7fe9d8,rgba(127,233,216,.05))",
          animation: `drawline .7s ease both ${delay}`,
        }}
      />
      {children}
    </div>
  );
}
```

- [ ] **Step 2: `components/hud/Strip.tsx`**
```tsx
export function Strip({ host }: { host: string }) {
  return (
    <div
      className="flex flex-none items-center gap-3.5 border-b border-border px-4 py-[7px]"
      style={{ animation: "flicker .8s ease both" }}
    >
      <span className="glow text-[12px] tracking-[3px] text-primary">MYSTICAL//ASSISTANT</span>
      <span className="text-[11px] tracking-[2px] text-muted-2">REMOTE DEV BRIDGE</span>
      <span className="flex-1" />
      <span className="flex items-center gap-[7px] text-[11px] tracking-[1.5px] text-muted-foreground">
        <span className="h-[7px] w-[7px] rounded-full bg-success" style={{ animation: "mpulse 2.4s infinite" }} />
        BRIDGE ONLINE · {host}
      </span>
      <span className="text-[11px] tracking-[2px] text-muted-2">MAIN SHELL</span>
    </div>
  );
}
```

- [ ] **Step 3: `components/hud/StatusBar.tsx`**
```tsx
export function StatusBar({
  mount,
  repo,
  changes,
  contextPct,
  onPalette,
}: {
  mount: string;
  repo: string;
  changes: number;
  contextPct: number | null;
  onPalette: () => void;
}) {
  return (
    <div
      className="flex flex-none items-center gap-4 border-t border-border px-4 py-2 text-[10px] tracking-[1.5px] text-muted-2"
      style={{ animation: "flicker .9s ease both" }}
    >
      <span className="text-muted-foreground">MOUNT <span className="text-primary">{mount}</span></span>
      {contextPct !== null && (
        <span className="flex items-center gap-[7px]">
          CONTEXT {contextPct}%
          <span className="relative inline-block h-[4px] w-[120px] overflow-hidden bg-[rgba(127,233,216,.12)]">
            <span className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${contextPct}%` }} />
          </span>
        </span>
      )}
      <span className="flex-1" />
      <span>REPO <span className="text-foreground">/{repo}</span></span>
      <span className="text-warning">{changes} CHANGES</span>
      <button
        onClick={onPalette}
        className="border border-input px-2.5 py-1 text-[10px] tracking-[1.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        ⌘K COMMAND
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Rewrite the `App.tsx` return** — keep every hook, state var, effect, and handler currently in `App` (state polls, telemetry inputs, send/respond/stop/newSession/openFromHistory, `commands`, etc.). Remove imports of `Header`, `ChatHeader`, `Sidebar`, `RightPanel` (replaced); add imports for the hud components + `useTelemetry`. Compute telemetry inputs and render the grid. Replace the entire `return (...)` (the `<div className="flex h-full flex-col">…</div>`) with:
```tsx
  const toolCount = turns.reduce((n, t) => n + t.events.filter((e) => e.type === "tool").length, 0);
  const eventCount = turns.reduce((n, t) => n + t.events.length, 0);
  const cost = turns.reduce((n, t) => n + t.events.reduce((c, e) => c + (e.type === "result" ? e.cost : 0), 0), 0);
  const errorCount = turns.reduce((n, t) => n + t.events.filter((e) => e.type === "error").length, 0);
  const tele = useTelemetry({ running, toolCount, eventCount });
  const activeBadge = activeProject ? gitBadges.get(activeProject) : undefined;

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="crt" />
      <div className="sweep" />
      <Strip host={location.host} />
      <div className="grid min-h-0 flex-1 gap-[13px] p-[13px]" style={{ gridTemplateColumns: "344px minmax(0,1fr) 368px" }}>
        {/* LEFT */}
        <div className="flex min-h-0 min-w-0 flex-col gap-[13px] overflow-y-auto overflow-x-hidden pr-0.5">
          <WorkspacePanel
            tele={tele} model={model} vscodeLive={vscodeLive}
            projectRel={projectRel} sessions={sessions}
            onSelectProject={() => void loadSessions()} onNewSession={() => void newSession()}
          />
          <TelemetryPanel tele={tele} turns={turns.length} tools={toolCount} cost={cost} errors={errorCount} />
          <ContextMatrixPanel />
          <ProjectsPanel
            sessions={sessions} gitBadges={gitBadges} bridgeIds={bridgeIds}
            activeProject={activeProject}
          />
        </div>
        {/* CENTER */}
        <Terminal
          view={view} onView={setView} selected={selected} model={model} turnCount={turns.length}
          turns={turns} activeId={active?.id ?? null} onRespond={(rid, o) => void respond(rid, o)}
          error={error} scrollRef={scrollRef}
          composer={
            <Composer
              disabled={running || pendingCount > 0} running={running} model={model} effort={effort}
              permissionMode={state?.permission_mode} onModel={setModel} onEffort={setEffort}
              onSend={(t, i) => void send(t, i)} onStop={() => void stop()}
            />
          }
          onOpenFromHistory={(s) => void openFromHistory(s)}
        />
        {/* RIGHT */}
        <div className="flex min-h-0 min-w-0 flex-col gap-[13px] overflow-y-auto overflow-x-hidden pr-0.5">
          <SessionsPanel
            sessions={sessions} external={external} bridgeIds={bridgeIds} awaiting={awaiting}
            selectedId={sessionId} onSelect={openSession} tele={tele}
          />
          <RightPanel tabs={panelTabs} activeId={activeTab} onActiveChange={setActiveTab} />
        </div>
      </div>
      <StatusBar
        mount={state?.project?.rel ?? "/"} repo={activeProject ?? "—"}
        changes={activeBadge?.dirty ?? 0} contextPct={null}
        onPalette={() => setPaletteOpen(true)}
      />
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
    </div>
  );
```
For this task, create **temporary stub** versions of `WorkspacePanel`, `TelemetryPanel`, `ContextMatrixPanel`, `ProjectsPanel`, `SessionsPanel`, `Terminal` that accept the props above and render a `Panel` with a placeholder body, so the build is green. Tasks 4–7 flesh them out. (Each stub: `export function X(props){ return <Panel title="…">…</Panel> }` or for Terminal a bordered column rendering `Transcript` + `{composer}`.) Keep `useTelemetry` imported. Note: `useTelemetry` is a hook — call it unconditionally at the top level of `App` (move the `const tele = useTelemetry(...)` above `return`, with the other derived consts, NOT inside the JSX).

- [ ] **Step 5: Build** — `npm --prefix …/dashboard/web run build`. Expected: success with stubs.

- [ ] **Step 6: Commit**
```bash
git add bridge/dashboard/web/src/components/hud/ bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): HUD shell — strip, grid, status bar, command palette (stub panels)"
```

---

## Task 4: WorkspacePanel

**Files:** `components/hud/WorkspacePanel.tsx` (replace stub).

Renders: big glow clock (`tele.clock`), date + `SESSION N TURNS`, stat grid
(BRIDGE ONLINE / SURFACES count / MODEL / `tele.uptime`), surface chips (TG/MA/VS;
VS uses `vscodeLive`), and the project switcher — the folder-browser logic moved
from `Sidebar` (`api.projects`/`api.select`, controlled by a local `browsing`
state) plus a **NEW SESSION** button.

- [ ] **Step 1:** Implement `WorkspacePanel` with the folder-browser (port `load`/`useFolder` from `Sidebar.tsx`), HUD-styled per the mockup WORKSPACE panel (clock `text-[46px] glow text-foreground-bright`; stat cells `label text-[9.5px] text-muted-2` + value; surface chips bordered; switcher with `[+]`/`SWITCH`, dashed divider). Props per Task 3 (`tele, model, vscodeLive, projectRel, sessions, onSelectProject, onNewSession`). `SURFACES` count = `2 + (vscodeLive ? 1 : 0)`.
- [ ] **Step 2:** Build. **Step 3:** Commit `feat(dashboard): HUD workspace panel (clock, stats, surfaces, project switcher)`.

---

## Task 5: TelemetryPanel + ContextMatrixPanel

- [ ] **Step 1: `TelemetryPanel`** — two SVG sparklines using `poly(tele.sparkA,320,42,4)` / `poly(tele.sparkB,…)` (strokes teal / violet) with `AVG {avg(tele.sparkA)}%` labels, and a stat grid TURNS/TOOLS/COST(`$cost.toFixed(2)`)/ERRORS (errors colored `text-success` when 0 else `text-danger`). SVG `viewBox="0 0 320 42" preserveAspectRatio="none"` + a baseline `<line>`.
- [ ] **Step 2: `ContextMatrixPanel`** — own `api.usage()` poll (60s). Header `{pct}% · {used}K / 200K` if available. Body: ~132 `<span>` cells 7×7px; first `round(pct/100*132)` cells teal (`rgba(127,233,216,.8)`), rest faint, each `animation: twinkle 3s … delay`. Footer `RESETS IN {fmtReset}` + `MODE {permission_mode}` (mode via a small prop or its own `api.state()` — pass `permissionMode` down from App instead to avoid an extra poll; update Task 3 call to pass `permissionMode={state?.permission_mode}`). If usage unavailable, render the matrix at 0 and hide the % header.
- [ ] **Step 3:** Build. **Step 4:** Commit `feat(dashboard): HUD telemetry + context-matrix panels (real-derived)`.

---

## Task 6: ProjectsPanel + SessionsPanel

- [ ] **Step 1: `ProjectsPanel`** — group `sessions` by project (distinct repos); each row: dot (running/dirty/idle color), repo name, `LIVE` chip if any running, and a git line `⎇ {branch}` + `●{dirty} ↑{ahead} ↓{behind}` from `gitBadges.get(repo)`; left-border accent + `mfadeup` delay; clicking calls `api.select(repo)` then a passed `onProjectChanged`/reload (pass `onSelectProject` from App). Active repo (`activeProject`) highlighted.
- [ ] **Step 2: `SessionsPanel`** — `Panel title="ACTIVE SESSIONS"`. List recent `sessions` (newest-first; cap ~6) with `surfaceFor(origin)` tag, name, `{machine} · {ago(updated)}`, and a status dot+label (running from `bridgeIds`, waiting from `awaiting`, else idle/done) — clicking calls `onSelect(id)`. Then a CONVERSATION I/O waveform: SVG `viewBox="0 0 340 60"` with 3 baseline lines + `<polyline points={wavePoly(tele.wave,340,60)} stroke="#7fe9d8">`.
- [ ] **Step 3:** Build. **Step 4:** Commit `feat(dashboard): HUD projects + sessions panels (git badges, I/O waveform)`.

---

## Task 7: Terminal center (chat reskin)

**Files:** `components/hud/Terminal.tsx`; reskin `RunStream.tsx`, `Composer.tsx`; light touch `Transcript.tsx`, `HistoryView.tsx`.

- [ ] **Step 1: `Terminal`** — a `.panel` column: header row (`TERMINAL` label, `squared@batcore` or `state` shell id, active session title truncated, `VS CODE · THIS` violet chip, a `CHAT`/`HIST` toggle bound to `view`/`onView`), drawline divider, then the scroll area (`ref={scrollRef}`, JetBrains Mono) rendering `Transcript` (chat) or `HistoryView` (history) by `view`, with the `error` block, and a trailing `~ ❯ <caret>` prompt line; then `{composer}` at the bottom.
- [ ] **Step 2: Reskin `RunStream`** — user `text`: `~ ❯` violet prompt + bright text; assistant `text`: keep `<Markdown>`, indent `pl-[18px]`, `text-[#9fc7c0]`; `tool`: bordered row `[{name.toUpperCase()}]` tag (tagColor by tool) + dim detail; `result` (`FinalResult`): bordered block with a `RESULT // OK` header bar (success border) + Markdown body. Keep all non-text branches (permission/question/error/stopped) working; only restyle. Preserve `Markdown` import.
- [ ] **Step 3: Reskin `Composer`** — command-line: outer `border-t border-border`; the HUD context strip (CONTEXT bar `grow` anim + RESET + MODE) above; input row bordered with `~ ❯` violet prompt, the textarea (transparent, JetBrains Mono), a model chip, and a `SEND ▸` / `STOP` outline button. Keep all state/handlers (`addFiles`, `submit`, model/effort selects can become small bordered chips or stay as selects restyled), attach, context strip via existing `ContextStrip`.
- [ ] **Step 4: `Transcript`/`HistoryView`** — adjust container classes to terminal width (`max-w-none px-0`) and let inherited tokens reskin; minimal changes.
- [ ] **Step 5:** Build. **Step 6:** Commit `feat(dashboard): HUD terminal — command-line chat + composer`.

---

## Task 8: Readout tabs + feature tabs + palette reskin

**Files:** reskin `RightPanel.tsx`, `GitTab.tsx`, `IssuesTab.tsx`, `DiffTab.tsx`, `Logs.tsx`, `CommandPalette.tsx`.

- [ ] **Step 1: `RightPanel`** — wrap in `Panel`-like `.panel border` with flex-1; tab row: equal-width buttons, `border-bottom:2px` underline (`--primary` active), `tracking` labels uppercased, badges as bordered chips. Keep controlled `activeId`/`onActiveChange` + the `tabs` registry.
- [ ] **Step 2: `GitTab`** — uppercase labels (`CHANGES // N FILES`), bordered branch card `⎇ {branch}` + `↑/↓`, file rows (JetBrains Mono, status colored, `+add −del`), `COMMIT ALL` (teal outline) + `PUSH` (dim outline) buttons; keep commit/push logic + textarea.
- [ ] **Step 3: `IssuesTab`** — `● N OPEN` / `✓ M CLOSED`, bordered issue cards (circle + title + `#num` + label pills using real `#color` + ago), `NEW ISSUE` create form (bordered). Keep logic.
- [ ] **Step 4: `DiffTab`** — bordered file header (`M path +add −del`), diff rows with the HUD `D()` colors (hunk teal, add green, del red, ctx dim) from `parseDiff`. Keep logic.
- [ ] **Step 5: `Logs`** — `DEV SERVER · :PORT` header (pulse dot), bordered mono log box. Keep SSE.
- [ ] **Step 6: `CommandPalette`** — terminal modal: `.panel` border, `~ ❯` input, rows with left-border-accent on hover/highlight, group label dim. Keep filtering + ↑/↓/Enter/Esc.
- [ ] **Step 7:** Build. **Step 8:** Commit `feat(dashboard): HUD readout tabs, feature panels, and command palette`.

---

## Task 9: Integration, cleanup, Mini App

- [ ] **Step 1: Retire dead components** — confirm `App.tsx` no longer imports `Header`, `ChatHeader`, `Sidebar`; `grep -rn "components/Header\|components/ChatHeader\|components/Sidebar" bridge/dashboard/web/src` returns nothing, then `git rm bridge/dashboard/web/src/components/{Header,ChatHeader,Sidebar}.tsx`.
- [ ] **Step 2: Mini App CRT overlay** — in `bridge/miniapp/web/src/main.tsx` or its root component, add a `<div className="crt" />` at the app root so the phone shares the scanline texture (tokens/fonts already applied in Task 1). Keep its layout. (If the root is a router outlet, add the `.crt` div in the root route component.)
- [ ] **Step 3: Build both**
```bash
npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build
npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/miniapp/web run build
```
Expected: both succeed; no unused-import / missing-module errors.
- [ ] **Step 4: Backend regression**
```bash
for t in test_git test_github test_bridge test_native; do python tests/$t.py | tail -1; done
```
Expected: 8 / 10 / 69 / 5 passed.
- [ ] **Step 5: HTTP/visual smoke** — run the dashboard server against this repo (as in prior sub-projects) and, if libasound is restored, screenshot the HUD; otherwise verify the dashboard server still serves and the SPA mounts (curl 200). Note any skipped screenshot.
- [ ] **Step 6: Commit**
```bash
git add -A bridge
git commit -m "feat(dashboard): retire violet shell, Mini App CRT overlay, HUD integration"
```

---

## Self-Review

**Spec coverage:** theme (T1) · telemetry hook (T2) · shell grid+strip+statusbar+palette (T3) · workspace (T4) · telemetry+matrix panels (T5) · projects+sessions+waveform (T6) · terminal chat+composer (T7) · readout tabs+feature panels+palette (T8) · cleanup+Mini App+verify (T9). All real-derived telemetry signals mapped (running/tool/event/cost/errors/usage); latency omitted. ✓

**Placeholder scan:** Task 3 uses deliberate, explicitly-temporary stubs replaced in T4–T7. No vague "handle X". ✓

**Type consistency:** `useTelemetry` return (`clock,date,uptime,sparkA,sparkB,wave`) consumed by Workspace/Telemetry/Sessions panels; `poly`/`wavePoly`/`avg` signatures match. `Panel` props (`title,label,delay,flex,children`) consistent. HUD tokens (`text-primary`, `text-muted-2`, `text-success/warning/danger/violet/blue`, `border-border/-bright`, `bg-panel`, `text-foreground-bright`) all defined in T1's `@theme`. App passes `permissionMode` to ContextMatrixPanel (added in T5). Existing component props (Composer, RightPanel `tabs`, GitTab `onOpenDiff`, etc.) unchanged. ✓

**Note:** call `useTelemetry` at the top level of `App` (not in JSX) to satisfy the Rules of Hooks.
