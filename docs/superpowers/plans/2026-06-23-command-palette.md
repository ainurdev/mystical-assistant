# Command Palette (Sub-project D) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ⌘K command palette that launches existing app actions (sessions, view, server/preview, right-panel tabs, git, model), wired to the header button and a global shortcut.

**Architecture:** A presentational `CommandPalette` modal driven by App state. App owns `paletteOpen`, a global keydown listener, and a `commands` array built from current state/handlers. The sidebar's `browsing` flag is lifted to App so "Switch project…" can open the folder browser. Frontend-only.

**Tech Stack:** React 19 + Vite + Tailwind v4 + TypeScript, lucide-react.

## Global Constraints

- Frontend-only; no backend changes; no new deps.
- Per-task verification = `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`.
- Palette commands NEVER perform silent git writes: "Commit changes…" and "Push to origin…" both navigate to the Git tab (`setActiveTab("git")`).
- Reuse A/B/C tokens/classes (`bg-popover`, `border-border`, `text-muted-foreground`, `font-mono`, `mpop`).
- Match existing style (functional components, Tailwind).

---

## File Structure

- Create `bridge/dashboard/web/src/components/CommandPalette.tsx`.
- Modify `bridge/dashboard/web/src/components/Sidebar.tsx` — `browsing` becomes controlled props.
- Modify `bridge/dashboard/web/src/components/Header.tsx` — `onOpenPalette` prop on the ⌘K button.
- Modify `bridge/dashboard/web/src/App.tsx` — palette state, keydown, commands, lifted browsing, render.

---

## Task 1: CommandPalette component

**Files:**
- Create: `bridge/dashboard/web/src/components/CommandPalette.tsx`

**Interfaces:**
- Produces: `interface Command { id:string; label:string; group:string; icon:string; run:()=>void }`; `CommandPalette({ open:boolean; commands:Command[]; onClose:()=>void })`.

- [ ] **Step 1: Create `components/CommandPalette.tsx`**

```tsx
import { useEffect, useMemo, useState } from "react";

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: string;
  run: () => void;
}

export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Reset query/highlight whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
    }
  }, [open]);

  // Keep the highlight in range as the filtered list changes.
  useEffect(() => {
    setHighlight((h) => (filtered.length === 0 ? 0 : Math.min(h, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;
    c.run();
    onClose();
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-start justify-center bg-[rgba(8,6,14,.62)] pt-[13vh] backdrop-blur-[3px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[580px] max-w-[92vw] overflow-hidden rounded-2xl border border-[#322a48] bg-[#16121f] shadow-[0_24px_70px_rgba(0,0,0,.6)] animate-[mpop_.16s_ease]"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <span className="text-[15px] text-muted-2">⌕</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => (filtered.length ? (h + 1) % filtered.length : 0));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => (filtered.length ? (h - 1 + filtered.length) % filtered.length : 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                run(filtered[highlight]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="Search projects, sessions, or run a command…"
            className="flex-1 bg-transparent text-[14.5px] text-foreground outline-none placeholder:text-muted-2"
          />
          <span className="rounded-[5px] border border-input px-1.5 font-mono text-[11px] text-muted-2">esc</span>
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">No commands.</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                onClick={() => run(c)}
                onMouseMove={() => setHighlight(i)}
                className={`flex w-full items-center gap-3 rounded-[9px] px-3 py-2.5 text-left ${
                  i === highlight ? "bg-[#211a33]" : ""
                }`}
              >
                <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] bg-muted font-mono text-[13px] text-brand-soft">
                  {c.icon}
                </span>
                <span className="flex-1 text-[13.5px] text-card-foreground">{c.label}</span>
                <span className="font-mono text-[10.5px] text-muted-2">{c.group}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`
Expected: success (component compiles though not yet used).

- [ ] **Step 3: Commit**

```bash
git add bridge/dashboard/web/src/components/CommandPalette.tsx
git commit -m "feat(dashboard): CommandPalette modal component"
```

---

## Task 2: Lift sidebar `browsing` to App

**Files:**
- Modify: `bridge/dashboard/web/src/components/Sidebar.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx`

**Interfaces:**
- Produces: `Sidebar` props `browsing: boolean` + `onBrowsingChange: (v: boolean) => void` (replacing internal `useState`).

- [ ] **Step 1: Make Sidebar's browsing controlled**

In `bridge/dashboard/web/src/components/Sidebar.tsx`:
1. Remove the local browsing state line `const [browsing, setBrowsing] = useState(false);`.
2. Add `browsing` + `onBrowsingChange` to the destructured props and the props type:
```tsx
  browsing,
  onBrowsingChange,
```
   and in the type block:
```tsx
  browsing: boolean;
  onBrowsingChange: (v: boolean) => void;
```
3. Replace every `setBrowsing(...)` call:
   - the toggle buttons `onClick={() => setBrowsing((v) => !v)}` → `onClick={() => onBrowsingChange(!browsing)}` (both the project-name button and the "change" button).
   - inside `useFolder`, `setBrowsing(false)` → `onBrowsingChange(false)`.
   (`useState` may now be unused in Sidebar — keep the import only if `listing` still uses it; `listing` uses `useState`, so the import stays.)

- [ ] **Step 2: Own browsing in App and pass it down**

In `bridge/dashboard/web/src/App.tsx`:
1. Add state near the other `useState`s:
```tsx
const [browsing, setBrowsing] = useState(false);
```
2. Pass to `<Sidebar>`:
```tsx
browsing={browsing}
onBrowsingChange={setBrowsing}
```

- [ ] **Step 3: Build**

Run: `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/web/src/components/Sidebar.tsx bridge/dashboard/web/src/App.tsx
git commit -m "refactor(dashboard): lift sidebar browsing state to App"
```

---

## Task 3: Header opens the palette

**Files:**
- Modify: `bridge/dashboard/web/src/components/Header.tsx`

**Interfaces:**
- Produces: `Header` prop `onOpenPalette: () => void` on the ⌘K button.

- [ ] **Step 1: Add the prop and wire the button**

In `bridge/dashboard/web/src/components/Header.tsx`:
1. Add `onOpenPalette` to the props type and destructuring:
```tsx
  onOpenPalette,
```
   type:
```tsx
  onOpenPalette: () => void;
```
2. The ⌘K button currently has `title="Command palette (coming soon)"` and no `onClick`. Change to:
```tsx
      <button
        onClick={onOpenPalette}
        title="Search & commands (⌘K)"
        className="flex items-center gap-2.5 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-[12.5px] text-muted-foreground hover:bg-accent"
      >
```
   (only the `onClick` and `title` change; keep the inner spans.)

- [ ] **Step 2: Build**

This task alone leaves `Header` requiring a new prop that App hasn't passed yet — to keep the build green, complete Step 1 here but defer the build check to Task 4 where App passes `onOpenPalette`. (If building in isolation, App will error "missing onOpenPalette" — that's expected and resolved in Task 4.)

- [ ] **Step 3: Commit (with Task 4)**

Header's change is committed together with Task 4 (its consumer), since the prop is required.

---

## Task 4: App palette wiring

**Files:**
- Modify: `bridge/dashboard/web/src/App.tsx`

**Interfaces:**
- Consumes: `CommandPalette`, `Command` (Task 1); `Header.onOpenPalette` (Task 3); `setBrowsing` (Task 2); existing `newSession`, `setView`, `setActiveTab`, `setModel`, `api`, `state`.

- [ ] **Step 1: Import CommandPalette**

In `bridge/dashboard/web/src/App.tsx`:
```tsx
import { CommandPalette, type Command } from "./components/CommandPalette";
```

- [ ] **Step 2: Palette state + global keydown**

Add state near the other `useState`s:
```tsx
const [paletteOpen, setPaletteOpen] = useState(false);
```
Add a keydown effect (next to the other effects):
```tsx
// ⌘K / Ctrl-K toggles the command palette; Esc closes it.
useEffect(() => {
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      setPaletteOpen((v) => !v);
    } else if (e.key === "Escape") {
      setPaletteOpen(false);
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, []);
```

- [ ] **Step 3: Build the commands array**

Just before the `panelTabs` definition (so `activeProject`, `state`, handlers are in scope), add:
```tsx
const serverRunning = state?.server.status === "running";
const previewOpen = !!state?.preview.url;
const commands: Command[] = [
  { id: "new-chat", label: "New chat", group: "Session", icon: "+", run: () => void newSession() },
  { id: "switch-project", label: "Switch project…", group: "Session", icon: "⇄", run: () => setBrowsing(true) },
  { id: "view-chat", label: "Go to Chat", group: "View", icon: "▣", run: () => setView("chat") },
  { id: "view-history", label: "Go to History", group: "View", icon: "◷", run: () => setView("history") },
  {
    id: "server",
    label: serverRunning ? "Stop dev server" : "Start dev server",
    group: "Server", icon: "▸",
    run: () => void api.server(serverRunning ? "stop" : "start").catch(() => {}),
  },
  {
    id: "preview",
    label: previewOpen ? "Stop preview" : "Open preview",
    group: "Server", icon: "◰",
    run: () => void api.preview(previewOpen ? "stop" : "start").catch(() => {}),
  },
  { id: "tab-git", label: "Open Git", group: "Panel", icon: "⎇", run: () => setActiveTab("git") },
  { id: "tab-issues", label: "Open GitHub issues", group: "Panel", icon: "◉", run: () => setActiveTab("issues") },
  { id: "tab-diff", label: "View changes (diff)", group: "Panel", icon: "±", run: () => setActiveTab("diff") },
  { id: "tab-logs", label: "Open logs", group: "Panel", icon: "≣", run: () => setActiveTab("logs") },
  { id: "git-commit", label: "Git: commit changes…", group: "Git", icon: "✓", run: () => setActiveTab("git") },
  { id: "git-push", label: "Git: push to origin…", group: "Git", icon: "↑", run: () => setActiveTab("git") },
  { id: "model-opus", label: "Use Opus", group: "Model", icon: "⌥", run: () => setModel("opus") },
  { id: "model-sonnet", label: "Use Sonnet", group: "Model", icon: "⌥", run: () => setModel("sonnet") },
  { id: "model-haiku", label: "Use Haiku", group: "Model", icon: "⌥", run: () => setModel("haiku") },
];
```

- [ ] **Step 4: Pass `onOpenPalette` to Header + render the palette**

1. On the `<Header … />` usage, add:
```tsx
onOpenPalette={() => setPaletteOpen(true)}
```
2. At the end of the root `<div className="flex h-full flex-col">`, just before its closing `</div>`, render the palette:
```tsx
<CommandPalette
  open={paletteOpen}
  commands={commands}
  onClose={() => setPaletteOpen(false)}
/>
```

- [ ] **Step 5: Build**

Run: `npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build`
Expected: success (Header now receives `onOpenPalette`; palette renders).

- [ ] **Step 6: Commit (Header + App together)**

```bash
git add bridge/dashboard/web/src/components/Header.tsx bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): wire ⌘K command palette (header button + global shortcut)"
```

---

## Task 5: Integration verification

**Files:** none (verification only).

- [ ] **Step 1: Build both web apps**

Run:
```bash
npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/dashboard/web run build
npm --prefix /home/mhzrerfani/projects/mystical-assistant/bridge/miniapp/web run build
```
Expected: both succeed.

- [ ] **Step 2: Backend tests (regression — no backend change expected)**

Run:
```bash
python tests/test_git.py | tail -1
python tests/test_github.py | tail -1
```
Expected: `8/8 passed`, `10/10 passed`.

- [ ] **Step 3: Manual smoke (against a running bridge)**

- ⌘K (and the header ⌘K button) opens the palette; Esc / backdrop closes it.
- Typing "server" filters; ↑/↓ highlights; Enter runs ("Start/Stop dev server").
- "Open Git" / "Open GitHub issues" / "View changes (diff)" switch the right-panel tab.
- "Switch project…" opens the sidebar folder browser.
- "Use Sonnet" changes the composer model.

- [ ] **Step 4: Screenshot (if libasound restored)**

Capture the dashboard with the palette open; otherwise note it was skipped.

---

## Self-Review

**Spec coverage:**
- CommandPalette modal (filter, keyboard nav, esc/backdrop) → Task 1. ✓
- Header ⌘K button opens it → Task 3. ✓
- Global ⌘K/Esc shortcut → Task 4. ✓
- Commands wired to existing handlers, state-reflecting labels → Task 4. ✓
- Git commands navigate (no silent push) → Task 4. ✓
- Lifted sidebar `browsing` for "Switch project…" → Task 2. ✓
- Build verification → Tasks 1–5. ✓

**Placeholder scan:** No "TBD/handle edge cases"; concrete code throughout. The Task 3 deferred-build note is intentional (Header's required prop is supplied in Task 4; they commit together). ✓

**Type consistency:** `Command` shape identical between CommandPalette and App's `commands` array (`id,label,group,icon,run`). `Sidebar` `browsing`/`onBrowsingChange` types match App's `useState<boolean>` + setter. `Header.onOpenPalette: ()=>void` matches App's arrow. `setActiveTab` ids ("git"/"issues"/"diff"/"logs") match the `panelTabs` ids from B/C. ✓
